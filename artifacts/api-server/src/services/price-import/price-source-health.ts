import {
  isCurrentVerifiedPrice,
  type PriceCoverageAuditRow,
} from "./price-coverage-audit.js";

export type PriceHealthSourceType = "continente" | "auchan";

export interface PriceSourceHealthReadResult {
  readonly capabilities: Readonly<Record<PriceHealthSourceType, unknown | null>>;
  readonly capabilityErrors: Readonly<Record<PriceHealthSourceType, string | null>>;
  readonly checkpoints: Readonly<
    Record<PriceHealthSourceType, readonly PriceCoverageAuditRow[] | null>
  >;
  readonly checkpointErrors: Readonly<Record<PriceHealthSourceType, string | null>>;
}

export interface PriceSourceHealthCapabilities {
  readonly available: boolean;
  readonly productIdentityUnique: boolean;
  readonly storeIdentityUnique: boolean;
  readonly priceIdentityUnique: boolean;
  readonly referenceStoreExists: boolean | null;
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export interface PriceSourceCheckpointHealth {
  readonly ok: boolean;
  readonly status:
    | "unavailable"
    | "missing"
    | "duplicate"
    | "invalid"
    | "error"
    | "stale_lock"
    | "running"
    | "idle"
    | "complete";
  readonly cursor: string | null;
  readonly updatedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly errorPresent: boolean;
  readonly issues: readonly string[];
}

export interface PriceSourceHealthSummary {
  readonly sourceType: PriceHealthSourceType;
  readonly ok: boolean;
  readonly expectedReference: string;
  readonly reference: {
    readonly candidates: number;
    readonly compliant: number;
    readonly ok: boolean;
  };
  readonly capabilities: PriceSourceHealthCapabilities;
  readonly checkpoint: PriceSourceCheckpointHealth;
  readonly prices: {
    readonly total: number;
    readonly verified: number;
    readonly valid: number;
    readonly expired: number;
    readonly validAtExpectedReference: number;
    readonly hasValidPriceAtExpectedReference: boolean;
  };
  readonly issues: readonly string[];
}

export interface PriceSourceHealthReport {
  readonly generatedAt: string;
  readonly asOf: string;
  readonly readOnly: true;
  readonly databaseWrites: 0;
  readonly capabilityRpcGets: 2;
  readonly sources: readonly PriceSourceHealthSummary[];
}

const EXPECTED_STORES: Readonly<Record<PriceHealthSourceType, {
  readonly externalId: string;
  readonly name?: string;
  readonly storeType: string;
  readonly postalCode?: string;
  readonly district?: string;
  readonly municipality?: string;
  readonly chainName?: string;
}>> = {
  continente: {
    externalId: "online",
    name: "Continente Online",
    storeType: "online",
  },
  auchan: {
    externalId: "reference:2650-435",
    storeType: "online_reference",
    postalCode: "2650-435",
    district: "Lisboa",
    municipality: "Amadora",
    chainName: "Auchan",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(row: PriceCoverageAuditRow, field: string): string | null {
  const value = row[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestampIsValid(value: unknown, required: boolean): value is string | null {
  if (value === null) return !required;
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isExpectedStore(
  store: PriceCoverageAuditRow,
  sourceType: PriceHealthSourceType,
): boolean {
  const expected = EXPECTED_STORES[sourceType];
  return store.source_type === sourceType &&
    store.external_id === expected.externalId &&
    store.active === true &&
    store.store_type === expected.storeType &&
    (expected.name === undefined || store.name === expected.name) &&
    (expected.postalCode === undefined || store.postal_code === expected.postalCode) &&
    (expected.district === undefined || store.district === expected.district) &&
    (expected.municipality === undefined || store.municipality === expected.municipality) &&
    (expected.chainName === undefined || store.chain_name === expected.chainName) &&
    (sourceType !== "continente" ||
      ["district", "municipality", "parish", "latitude", "longitude"].every(
        (field) => store[field] === null,
      ));
}

function readCapabilities(
  sourceType: PriceHealthSourceType,
  value: unknown | null,
  readError: string | null,
): PriceSourceHealthCapabilities {
  const validRecord = isRecord(value);
  const productIdentityUnique = validRecord && value.product_identity_unique === true;
  const storeIdentityUnique = validRecord && value.store_identity_unique === true;
  const priceIdentityUnique = validRecord && value.price_identity_unique === true;
  const referenceStoreExists = sourceType === "auchan"
    ? validRecord && value.reference_store_exists === true
    : null;
  const issues: string[] = [];
  if (!validRecord) {
    issues.push(readError ? "capabilities_read_failed" : "capabilities_response_invalid");
  }
  if (!productIdentityUnique) issues.push("product_identity_not_confirmed");
  if (!storeIdentityUnique) issues.push("store_identity_not_confirmed");
  if (!priceIdentityUnique) issues.push("price_identity_not_confirmed");
  if (sourceType === "auchan" && !referenceStoreExists) {
    issues.push("reference_store_capability_not_confirmed");
  }
  return {
    available: validRecord,
    productIdentityUnique,
    storeIdentityUnique,
    priceIdentityUnique,
    referenceStoreExists,
    ok: issues.length === 0,
    issues,
  };
}

function checkpointHealth(
  sourceType: PriceHealthSourceType,
  rows: readonly PriceCoverageAuditRow[] | null,
  readError: string | null,
  now: number,
): PriceSourceCheckpointHealth {
  const empty = {
    cursor: null,
    updatedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    errorPresent: false,
  } as const;
  if (rows === null) {
    return {
      ...empty,
      ok: false,
      status: "unavailable",
      issues: [readError ? "checkpoint_read_failed" : "checkpoint_response_unavailable"],
    };
  }
  if (rows.length === 0) {
    return { ...empty, ok: false, status: "missing", issues: ["checkpoint_missing"] };
  }
  if (rows.length !== 1) {
    return { ...empty, ok: false, status: "duplicate", issues: ["multiple_checkpoints"] };
  }

  const row = rows[0]!;
  const metadata = row.metadata;
  const phase = isRecord(metadata) ? metadata.phase : null;
  const run = isRecord(metadata) && isRecord(metadata.run) ? metadata.run : null;
  const runStatus = run?.status ?? "idle";
  const cursor = row.cursor_value;
  const updatedAt = row.updated_at;
  const lastAttemptAt = row.last_attempt_at;
  const lastSuccessAt = row.last_success_at;
  const lastError = row.last_error;
  const hasError = lastError !== null && lastError !== undefined;
  const lock = run?.lock;
  const issues: string[] = [];

  if (
    row.source_type !== sourceType ||
    !isRecord(metadata) ||
    !["refresh", "discovery", "complete", undefined].includes(
      typeof phase === "string" ? phase : undefined,
    ) ||
    !["idle", "running", "error", "complete"].includes(String(runStatus)) ||
    !(cursor === null || cursor === undefined || typeof cursor === "string") ||
    !timestampIsValid(updatedAt, true) ||
    !timestampIsValid(lastAttemptAt, false) ||
    !timestampIsValid(lastSuccessAt, false) ||
    !(lastError === null || lastError === undefined || typeof lastError === "string")
  ) {
    return {
      ...empty,
      ok: false,
      status: "invalid",
      errorPresent: hasError,
      issues: ["checkpoint_shape_invalid"],
    };
  }

  const updatedAtText = updatedAt as string;
  const lastAttemptText = typeof lastAttemptAt === "string" ? lastAttemptAt : null;
  const lastSuccessText = typeof lastSuccessAt === "string" ? lastSuccessAt : null;
  const cursorText = typeof cursor === "string" ? cursor : null;
  if (lock !== null && lock !== undefined) {
    if (
      !isRecord(lock) ||
      typeof lock.runId !== "string" ||
      !timestampIsValid(lock.expiresAt, true)
    ) {
      return {
        ...empty,
        ok: false,
        status: "invalid",
        errorPresent: hasError,
        issues: ["checkpoint_lock_invalid"],
      };
    }
  }
  if (hasError || runStatus === "error") {
    return {
      cursor: cursorText,
      updatedAt: updatedAtText,
      lastAttemptAt: lastAttemptText,
      lastSuccessAt: lastSuccessText,
      errorPresent: true,
      ok: false,
      status: "error",
      issues: ["checkpoint_records_error"],
    };
  }
  if (runStatus === "running") {
    if (!isRecord(lock)) {
      return {
        cursor: cursorText,
        updatedAt: updatedAtText,
        lastAttemptAt: lastAttemptText,
        lastSuccessAt: lastSuccessText,
        errorPresent: false,
        ok: false,
        status: "invalid",
        issues: ["running_checkpoint_has_no_lock"],
      };
    }
    if (Date.parse(String(lock.expiresAt)) < now) {
      return {
        cursor: cursorText,
        updatedAt: updatedAtText,
        lastAttemptAt: lastAttemptText,
        lastSuccessAt: lastSuccessText,
        errorPresent: false,
        ok: false,
        status: "stale_lock",
        issues: ["checkpoint_lock_expired"],
      };
    }
    return {
      cursor: cursorText,
      updatedAt: updatedAtText,
      lastAttemptAt: lastAttemptText,
      lastSuccessAt: lastSuccessText,
      errorPresent: false,
      ok: true,
      status: "running",
      issues: [],
    };
  }

  const status = runStatus === "complete" || phase === "complete" ? "complete" : "idle";
  return {
    cursor: cursorText,
    updatedAt: updatedAtText,
    lastAttemptAt: lastAttemptText,
    lastSuccessAt: lastSuccessText,
    errorPresent: false,
    ok: true,
    status,
    issues: [],
  };
}

function summarizeSource(
  sourceType: PriceHealthSourceType,
  stores: readonly PriceCoverageAuditRow[],
  prices: readonly PriceCoverageAuditRow[],
  readResult: PriceSourceHealthReadResult,
  now: number,
): PriceSourceHealthSummary {
  const sourceStores = stores.filter((store) => store.source_type === sourceType);
  const referenceStores = sourceStores.filter((store) =>
    text(store, "external_id") === EXPECTED_STORES[sourceType].externalId
  );
  const compliantStores = referenceStores.filter((store) =>
    isExpectedStore(store, sourceType)
  );
  const expectedStoreId = referenceStores.length === 1 && compliantStores.length === 1
    ? text(compliantStores[0]!, "id")
    : null;
  const sourcePrices = prices.filter((price) => price.source_type === sourceType);
  let verified = 0;
  let valid = 0;
  let expired = 0;
  let validAtExpectedReference = 0;
  for (const price of sourcePrices) {
    if (text(price, "verification_status") !== "verified") continue;
    verified += 1;
    const status = isCurrentVerifiedPrice(price, now);
    if (status.current) {
      valid += 1;
      if (
        expectedStoreId !== null &&
        text(price, "store_id") === expectedStoreId
      ) validAtExpectedReference += 1;
    }
    if (status.expired) expired += 1;
  }

  const capabilities = readCapabilities(
    sourceType,
    readResult.capabilities[sourceType],
    readResult.capabilityErrors[sourceType],
  );
  const checkpoint = checkpointHealth(
    sourceType,
    readResult.checkpoints[sourceType],
    readResult.checkpointErrors[sourceType],
    now,
  );
  const referenceOk = referenceStores.length === 1 && compliantStores.length === 1;
  const issues = [
    ...capabilities.issues,
    ...checkpoint.issues,
    ...(!referenceOk ? ["expected_reference_missing_or_invalid"] : []),
    ...(validAtExpectedReference === 0 ? ["no_current_verified_price_at_reference"] : []),
  ];

  return {
    sourceType,
    ok: issues.length === 0,
    expectedReference: sourceType === "continente"
      ? "Continente Online"
      : "Auchan online_reference 2650-435, Lisboa/Amadora",
    reference: {
      candidates: referenceStores.length,
      compliant: compliantStores.length,
      ok: referenceOk,
    },
    capabilities,
    checkpoint,
    prices: {
      total: sourcePrices.length,
      verified,
      valid,
      expired,
      validAtExpectedReference,
      hasValidPriceAtExpectedReference: validAtExpectedReference > 0,
    },
    issues,
  };
}

export function buildPriceSourceHealthReport(
  stores: readonly PriceCoverageAuditRow[],
  prices: readonly PriceCoverageAuditRow[],
  readResult: PriceSourceHealthReadResult,
  asOf: Date = new Date(),
): PriceSourceHealthReport {
  const now = asOf.getTime();
  if (!Number.isFinite(now)) throw new Error("The health check as-of time is invalid.");
  return {
    generatedAt: asOf.toISOString(),
    asOf: asOf.toISOString(),
    readOnly: true,
    databaseWrites: 0,
    capabilityRpcGets: 2,
    sources: (["continente", "auchan"] as const).map((sourceType) =>
      summarizeSource(sourceType, stores, prices, readResult, now)
    ),
  };
}
