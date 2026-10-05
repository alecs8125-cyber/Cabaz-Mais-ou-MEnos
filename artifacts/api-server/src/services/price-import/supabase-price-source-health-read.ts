import type { PriceCoverageAuditRow } from "./price-coverage-audit.js";
import type {
  PriceHealthSourceType,
  PriceSourceHealthReadResult,
} from "./price-source-health.js";
import { resolveServerSupabaseUrl } from "./server-supabase-env.js";

export interface PriceSourceHealthReadConfig {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export interface PriceSourceHealthReadClient {
  getCheckpointRows(
    sourceType: PriceHealthSourceType,
  ): Promise<readonly PriceCoverageAuditRow[]>;
  getCapabilities(sourceType: PriceHealthSourceType): Promise<unknown>;
}

const CAPABILITY_RPC: Readonly<Record<PriceHealthSourceType, string>> = {
  continente: "continente_sync_capabilities",
  auchan: "auchan_sync_capabilities",
};

function assertAllowedSourceType(sourceType: string): asserts sourceType is PriceHealthSourceType {
  if (!Object.hasOwn(CAPABILITY_RPC, sourceType)) {
    throw new Error("Price source health type is not allowlisted.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateConfig(
  config: PriceSourceHealthReadConfig,
): PriceSourceHealthReadConfig {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error("SUPABASE_URL has an invalid format.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("SUPABASE_URL must be HTTP(S) without credentials or parameters.");
  }
  if (!config.serviceRoleKey.trim()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for the read-only health check.");
  }
  return {
    url: url.toString().replace(/\/+$/, ""),
    serviceRoleKey: config.serviceRoleKey,
  };
}

/**
 * Read-only health transport. Its only operations are GETs against the existing
 * source_sync_state rows and the two explicitly allowlisted capability GET RPCs.
 */
export class SupabasePriceSourceHealthReadClient
implements PriceSourceHealthReadClient {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(
    config: PriceSourceHealthReadConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    const validated = validateConfig(config);
    this.baseUrl = validated.url;
    this.serviceRoleKey = validated.serviceRoleKey;
  }

  private async getJson(path: string, query?: Readonly<Record<string, string>>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await this.fetchImplementation(url, {
      method: "GET",
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const resource = path.includes("/rpc/")
        ? `public.${path.split("/").at(-1)}`
        : "public.source_sync_state";
      throw new Error(`Read-only GET ${resource} failed with HTTP ${response.status}.`);
    }
    return response.json();
  }

  async getCheckpointRows(
    sourceType: PriceHealthSourceType,
  ): Promise<readonly PriceCoverageAuditRow[]> {
    assertAllowedSourceType(sourceType);
    const body = await this.getJson("/rest/v1/source_sync_state", {
      select: "source_type,cursor_value,last_attempt_at,last_success_at,last_error,metadata,updated_at",
      source_type: `eq.${sourceType}`,
      limit: "2",
    });
    if (!Array.isArray(body) || body.some((row) => !isRecord(row))) {
      throw new Error("Supabase returned an invalid source_sync_state health response.");
    }
    return body;
  }

  getCapabilities(sourceType: PriceHealthSourceType): Promise<unknown> {
    assertAllowedSourceType(sourceType);
    const rpcName = CAPABILITY_RPC[sourceType];
    return this.getJson(`/rest/v1/rpc/${rpcName}`);
  }
}

export function createSupabasePriceSourceHealthReadClient(
  environment: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
): SupabasePriceSourceHealthReadClient {
  const url = resolveServerSupabaseUrl(environment);
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRoleKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
  return new SupabasePriceSourceHealthReadClient(
    { url, serviceRoleKey },
    fetchImplementation,
  );
}

async function capture<T>(promise: Promise<T>): Promise<{
  readonly value: T | null;
  readonly error: string | null;
}> {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return {
      value: null,
      error: error instanceof Error
        ? error.message
        : "Unexpected read-only health request failure.",
    };
  }
}

export async function readPriceSourceHealthData(
  client: PriceSourceHealthReadClient,
): Promise<PriceSourceHealthReadResult> {
  const [continenteCapabilities, auchanCapabilities, continenteCheckpoint, auchanCheckpoint] =
    await Promise.all([
      capture(client.getCapabilities("continente")),
      capture(client.getCapabilities("auchan")),
      capture(client.getCheckpointRows("continente")),
      capture(client.getCheckpointRows("auchan")),
    ]);
  return {
    capabilities: {
      continente: continenteCapabilities.value,
      auchan: auchanCapabilities.value,
    },
    capabilityErrors: {
      continente: continenteCapabilities.error,
      auchan: auchanCapabilities.error,
    },
    checkpoints: {
      continente: continenteCheckpoint.value,
      auchan: auchanCheckpoint.value,
    },
    checkpointErrors: {
      continente: continenteCheckpoint.error,
      auchan: auchanCheckpoint.error,
    },
  };
}
