import { createHash, randomUUID } from "node:crypto";
import { isContinentePriceValid } from "./continente-parser.js";
import type {
  ContinenteDailyCheckpointRow,
  ContinenteStoredOnlinePrice,
  ContinenteSyncRepository,
  OnlineStore,
  Row,
} from "./continente-sync-repository.js";
import type {
  ContinenteProductObservation,
} from "./continente-types.js";
import { syncContinenteObservations } from "./continente-sync.js";
import type {
  ContinenteAdapter,
  ContinenteSitemapPlan,
} from "./continente-adapter.js";

const SOURCE_TYPE = "continente";
const TIME_ZONE = "Europe/Lisbon";
const REFRESH_NEAR_EXPIRY_MS = 12 * 60 * 60 * 1_000;
const MAX_SUBLOT_SIZE = 20;
const MAX_SCAN_URLS_PER_RUN_MULTIPLIER = 10;
const CHECKPOINT_LEASE_MS = 6 * 60 * 60 * 1_000;

export interface ContinenteDailyOptions {
  readonly limit: number;
  readonly resume: boolean;
  readonly commit: boolean;
}

export interface ContinenteDailyRepository extends ContinenteSyncRepository {
  preflightDailySync(): Promise<string[]>;
  loadDailyCheckpoint(): Promise<ContinenteDailyCheckpointRow | null>;
  insertDailyCheckpoint(
    fields: Omit<ContinenteDailyCheckpointRow, "updated_at"> & { readonly updated_at?: string },
  ): Promise<ContinenteDailyCheckpointRow>;
  updateDailyCheckpoint(
    expectedUpdatedAt: string,
    fields: Omit<ContinenteDailyCheckpointRow, "updated_at"> & { readonly updated_at?: string },
  ): Promise<ContinenteDailyCheckpointRow>;
  loadOnlinePriceCandidates(storeId: string): Promise<ContinenteStoredOnlinePrice[]>;
  loadOnlinePricesBySkus(
    storeId: string,
    skus: readonly string[],
  ): Promise<Map<string, ContinenteStoredOnlinePrice>>;
  loadHistoryKeys(storeId: string, productIds: readonly string[]): Promise<Set<string>>;
}

export type ContinenteDailyAdapter = Pick<
  ContinenteAdapter,
  "discoverProductSitemaps" | "runProductUrls" | "runSitemapBatch"
>;

interface RefreshItem {
  readonly sku: string;
  readonly sourceReference: string;
}

interface RefreshState {
  day: string | null;
  queue: RefreshItem[];
  cursor: number;
  complete: boolean;
}

interface DiscoveryState {
  sitemapIndexUrl: string | null;
  sitemapManifestHash: string | null;
  sitemapIndex: number;
  sitemapUrl: string | null;
  offset: number;
  lastProductUrl: string | null;
  cycle: number;
  cycleComplete: boolean;
}

interface DailyMetadata extends Row {
  dailySyncVersion: 1;
  phase: "refresh" | "discovery" | "complete";
  refresh: RefreshState;
  discovery: DiscoveryState;
  run: {
    id: string | null;
    status: "idle" | "running" | "error" | "complete";
    startedAt: string | null;
    lock: { runId: string; expiresAt: string } | null;
  };
}

interface RunDependencies {
  readonly now?: () => Date;
  readonly createRunId?: () => string;
}

export interface ContinenteDailyReport {
  ok: boolean;
  mode: "dry-run" | "commit";
  sourceType: "continente";
  priceScope: "online";
  writesEnabled: boolean;
  timezone: "Europe/Lisbon";
  scheduledTime: "05:00";
  scheduleConfigured: false;
  resume: boolean;
  limit: number;
  productPageRequestBudget: number;
  checkpointBefore: { cycle: number; sitemapIndex: number; offset: number } | null;
  checkpointAfter: { cycle: number; sitemapIndex: number; offset: number } | null;
  sitemapCount: number;
  counts: {
    refreshQueued: number;
    refreshProcessed: number;
    scannedSitemapUrls: number;
    knownUrlsSkipped: number;
    newUrlsProcessed: number;
    productsExtracted: number;
    pricesEligible: number;
    productsCreated: number;
    productsReused: number;
    mappingsCreated: number;
    mappingsReused: number;
    pricesCreated: number;
    pricesUpdated: number;
    pricesUnchanged: number;
    priceChanges: number;
    historyCreatedConfirmed: number;
    syncErrorsReconciled: number;
    pricesWritten: number;
    redirects: number;
    unavailable: number;
    retries: number;
    productPageRequests: number;
    sublotsCompleted: number;
    errors: number;
  };
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyMetadata(): DailyMetadata {
  return {
    dailySyncVersion: 1,
    phase: "refresh",
    refresh: { day: null, queue: [], cursor: 0, complete: false },
    discovery: {
      sitemapIndexUrl: null,
      sitemapManifestHash: null,
      sitemapIndex: 0,
      sitemapUrl: null,
      offset: 0,
      lastProductUrl: null,
      cycle: 0,
      cycleComplete: false,
    },
    run: { id: null, status: "idle", startedAt: null, lock: null },
  };
}

function normalizeMetadata(input: Row): DailyMetadata {
  if (input.dailySyncVersion !== undefined && input.dailySyncVersion !== 1) {
    throw new Error("Unsupported Continente daily checkpoint version.");
  }
  const fresh = emptyMetadata();
  const refreshInput = isRecord(input.refresh) ? input.refresh : {};
  const discoveryInput = isRecord(input.discovery) ? input.discovery : {};
  const runInput = isRecord(input.run) ? input.run : {};
  const queue = refreshInput.queue ?? [];
  if (!Array.isArray(queue) || queue.some((item) =>
    !isRecord(item) || typeof item.sku !== "string" || typeof item.sourceReference !== "string"
  )) {
    throw new Error("The Continente refresh checkpoint queue is invalid.");
  }
  const refreshCursor = Number(refreshInput.cursor ?? 0);
  const sitemapIndex = Number(discoveryInput.sitemapIndex ?? 0);
  const offset = Number(discoveryInput.offset ?? 0);
  const cycle = Number(discoveryInput.cycle ?? 0);
  if (
    !Number.isSafeInteger(refreshCursor) || refreshCursor < 0 ||
    !Number.isSafeInteger(sitemapIndex) || sitemapIndex < 0 ||
    !Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(cycle) || cycle < 0
  ) {
    throw new Error("The Continente daily checkpoint contains an invalid cursor.");
  }
  const phase = input.phase ?? fresh.phase;
  const status = runInput.status ?? fresh.run.status;
  if (!["refresh", "discovery", "complete"].includes(String(phase)) ||
      !["idle", "running", "error", "complete"].includes(String(status))) {
    throw new Error("The Continente daily checkpoint phase is invalid.");
  }
  const lockInput = runInput.lock;
  let lock: DailyMetadata["run"]["lock"] = null;
  if (lockInput !== null && lockInput !== undefined) {
    if (!isRecord(lockInput) || typeof lockInput.runId !== "string" ||
        typeof lockInput.expiresAt !== "string") {
      throw new Error("The Continente daily checkpoint lock is invalid.");
    }
    lock = { runId: lockInput.runId, expiresAt: lockInput.expiresAt };
  }
  return {
    ...input,
    dailySyncVersion: 1,
    phase: phase as DailyMetadata["phase"],
    refresh: {
      day: typeof refreshInput.day === "string" ? refreshInput.day : null,
      queue: queue as RefreshItem[],
      cursor: refreshCursor,
      complete: refreshInput.complete === true,
    },
    discovery: {
      sitemapIndexUrl: typeof discoveryInput.sitemapIndexUrl === "string"
        ? discoveryInput.sitemapIndexUrl
        : null,
      sitemapManifestHash: typeof discoveryInput.sitemapManifestHash === "string"
        ? discoveryInput.sitemapManifestHash
        : null,
      sitemapIndex,
      sitemapUrl: typeof discoveryInput.sitemapUrl === "string"
        ? discoveryInput.sitemapUrl
        : null,
      offset,
      lastProductUrl: typeof discoveryInput.lastProductUrl === "string"
        ? discoveryInput.lastProductUrl
        : null,
      cycle,
      cycleComplete: discoveryInput.cycleComplete === true,
    },
    run: {
      id: typeof runInput.id === "string" ? runInput.id : null,
      status: status as DailyMetadata["run"]["status"],
      startedAt: typeof runInput.startedAt === "string" ? runInput.startedAt : null,
      lock,
    },
  };
}

function localDate(date: Date): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function safeSourceUrl(sourceReference: string, sku: string): boolean {
  try {
    const url = new URL(sourceReference);
    return url.protocol === "https:" &&
      url.origin === "https://www.continente.pt" &&
      url.pathname.startsWith("/produto/") &&
      url.pathname.endsWith(`-${sku}.html`) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function priority(candidate: ContinenteStoredOnlinePrice, now: number): number {
  const validUntil = candidate.validUntil ? Date.parse(candidate.validUntil) : Number.NaN;
  if (Number.isFinite(validUntil) && validUntil <= now) return 0;
  if (Number.isFinite(validUntil) && validUntil <= now + REFRESH_NEAR_EXPIRY_MS) return 1;
  return 2;
}

function buildRefreshQueue(
  candidates: readonly ContinenteStoredOnlinePrice[],
  now: Date,
): RefreshItem[] {
  const invalid = candidates.find(
    (candidate) =>
      !safeSourceUrl(candidate.sourceReference, candidate.sku) ||
      !Number.isFinite(Date.parse(candidate.capturedAt)) ||
      (candidate.validUntil !== null && !Number.isFinite(Date.parse(candidate.validUntil))),
  );
  if (invalid) {
    throw new Error(`Saved price metadata for Continente SKU ${invalid.sku} cannot be refreshed safely.`);
  }
  return [...candidates]
    .sort((left, right) =>
      priority(left, now.getTime()) - priority(right, now.getTime()) ||
      Date.parse(left.capturedAt) - Date.parse(right.capturedAt) ||
      left.sku.localeCompare(right.sku)
    )
    .map(({ sku, sourceReference }) => ({ sku, sourceReference }));
}

function currentPageBudget(options: ContinenteDailyOptions): number {
  return options.limit * (options.commit ? 3 : 1);
}

function checkpointCursor(metadata: DailyMetadata): string | null {
  if (metadata.phase === "refresh") return `refresh:${metadata.refresh.cursor}`;
  if (metadata.phase === "discovery") {
    return `discovery:${metadata.discovery.sitemapIndex}:${metadata.discovery.offset}`;
  }
  return `complete:${metadata.discovery.cycle}`;
}

function errorMessage(cause: unknown): string {
  const value = cause instanceof Error ? cause.message : "Unexpected daily sync error.";
  return value
    .replace(/https?:\/\/\S+/gi, "[source URL]")
    .replace(/\b(?:authorization|apikey|service[_-]?role[_-]?key)\b[^,\s]*/gi, "[redacted]")
    .slice(0, 500);
}

function checkpointFields(
  metadata: DailyMetadata,
  previous: ContinenteDailyCheckpointRow | null,
  lastAttemptAt: string | null,
  lastSuccessAt: string | null,
  lastError: string | null,
): Omit<ContinenteDailyCheckpointRow, "updated_at"> {
  return {
    source_type: SOURCE_TYPE,
    cursor_value: checkpointCursor(metadata),
    last_attempt_at: lastAttemptAt,
    last_success_at: lastSuccessAt,
    last_error: lastError,
    metadata,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function samePersistedIntent(
  actual: ContinenteDailyCheckpointRow | null,
  intended: Omit<ContinenteDailyCheckpointRow, "updated_at">,
): actual is ContinenteDailyCheckpointRow {
  return actual !== null &&
    actual.source_type === intended.source_type &&
    actual.cursor_value === intended.cursor_value &&
    actual.last_attempt_at === intended.last_attempt_at &&
    actual.last_success_at === intended.last_success_at &&
    actual.last_error === intended.last_error &&
    stableJson(actual.metadata) === stableJson(intended.metadata);
}

function normalizedPrice(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "";
}

async function reconcileSublotWrites(
  observations: readonly ContinenteProductObservation[],
  syncReport: Awaited<ReturnType<typeof syncContinenteObservations>>,
  repository: ContinenteDailyRepository,
  store: OnlineStore | null,
  beforePrices: ReadonlyMap<string, ContinenteStoredOnlinePrice>,
  counts: ContinenteDailyReport["counts"],
): Promise<void> {
  if (!repository.commitEnabled) {
    if (syncReport.counts.errors > 0) {
      throw new Error(`Dry-run sync returned ${syncReport.counts.errors} item error(s).`);
    }
    return;
  }
  if (!store) throw new Error("The online store disappeared during price reconciliation.");

  const itemBySku = new Map(syncReport.items.map((item) => [item.sku, item]));
  const productIds: string[] = [];
  for (const observation of observations) {
    const sku = observation.externalProductId!;
    const item = itemBySku.get(sku);
    if (!item?.productId) {
      throw new Error(`No product identity was confirmed for SKU ${sku}; checkpoint preserved.`);
    }
    const mappings = await repository.findMappings(sku);
    const product = await repository.findProduct(item.productId);
    if (
      mappings.length !== 1 ||
      mappings[0]!.productId !== item.productId ||
      !mappings[0]!.verified ||
      !product ||
      !product.active
    ) {
      throw new Error(`Product mapping for SKU ${sku} was not confirmed by a read-only reconciliation.`);
    }
    productIds.push(item.productId);
  }

  const skus = observations.map((observation) => observation.externalProductId!);
  const savedPrices = await repository.loadOnlinePricesBySkus(store.id, skus);
  const savedHistoryKeys = await repository.loadHistoryKeys(store.id, productIds);
  for (const observation of observations) {
    const sku = observation.externalProductId!;
    const saved = savedPrices.get(sku);
    const item = itemBySku.get(sku);
    const expectedUntil = Date.parse(observation.capturedAt) + 36 * 60 * 60 * 1_000;
    if (
      !saved ||
      !item?.productId ||
      saved.productId !== item.productId ||
      saved.sourceReference !== observation.sourceReference ||
      normalizedPrice(saved.price) !== normalizedPrice(observation.price!) ||
      Date.parse(saved.capturedAt) !== Date.parse(observation.capturedAt) ||
      Date.parse(saved.validUntil ?? "") !== expectedUntil
    ) {
      throw new Error(`Price write for SKU ${sku} was not confirmed by a read-only reconciliation.`);
    }
    const before = beforePrices.get(sku);
    if (!before) {
      if (item.error) counts.pricesWritten += 1;
      counts.pricesCreated += 1;
      const historyKey = `${saved.productId}|${normalizedPrice(saved.price)}|${Date.parse(saved.capturedAt)}`;
      if (!savedHistoryKeys.has(historyKey)) {
        throw new Error(`Initial price history for SKU ${sku} was not confirmed.`);
      }
      counts.historyCreatedConfirmed += 1;
    } else {
      if (
        item.error &&
        (
          before.productId !== saved.productId ||
          normalizedPrice(before.price) !== normalizedPrice(saved.price) ||
          Date.parse(before.capturedAt) !== Date.parse(saved.capturedAt) ||
          before.sourceReference !== saved.sourceReference ||
          Date.parse(before.validUntil ?? "") !== Date.parse(saved.validUntil ?? "")
        )
      ) {
        counts.pricesWritten += 1;
      }
      counts.pricesUpdated += 1;
      if (normalizedPrice(before.price) === normalizedPrice(saved.price)) {
        counts.pricesUnchanged += 1;
      } else {
        counts.priceChanges += 1;
        const historyKey = `${saved.productId}|${normalizedPrice(saved.price)}|${Date.parse(saved.capturedAt)}`;
        if (!savedHistoryKeys.has(historyKey)) {
          throw new Error(`Changed-price history for SKU ${sku} was not confirmed.`);
        }
        counts.historyCreatedConfirmed += 1;
      }
    }
  }
  counts.syncErrorsReconciled += syncReport.counts.errors;
}

function validObservationForSync(
  observation: ContinenteProductObservation,
): boolean {
  if (!isContinentePriceValid(observation) ||
      !observation.price ||
      !/^\d+\.\d{2}$/.test(observation.price) ||
      !observation.externalProductId ||
      observation.externalProductId !== observation.sku ||
      observation.externalProductId !== observation.mpn ||
      observation.externalProductId !== observation.urlProductId ||
      !observation.name?.trim() ||
      /outofstock|soldout|out of stock/i.test(observation.availability ?? "")) {
    return false;
  }
  return safeSourceUrl(
    observation.sourceReference,
    observation.externalProductId,
  );
}

function productPageFailure(
  attempts: readonly { outcome: string; error: string | null }[],
): string | null {
  const failed = attempts.find((attempt) =>
    attempt.outcome === "blocked" ||
    attempt.outcome === "http_error" ||
    attempt.outcome === "invalid_page" ||
    attempt.outcome === "network_error"
  );
  return failed
    ? `Product page did not complete safely (${failed.outcome}${failed.error ? `: ${failed.error}` : ""}).`
    : null;
}

function hashSitemaps(plan: ContinenteSitemapPlan): string {
  return createHash("sha256").update(plan.productSitemaps.join("\n")).digest("hex");
}

function prepareDiscovery(
  metadata: DailyMetadata,
  plan: ContinenteSitemapPlan,
): void {
  const discovery = metadata.discovery;
  if (
    discovery.sitemapIndexUrl &&
    discovery.sitemapIndexUrl !== plan.sitemapIndexUrl &&
    !discovery.cycleComplete
  ) {
    throw new Error("The sitemap index URL changed mid-cycle; refusing to guess a resume position.");
  }
  const sitemapIndex = discovery.sitemapUrl
    ? plan.productSitemaps.indexOf(discovery.sitemapUrl)
    : discovery.sitemapIndex;
  if (discovery.sitemapUrl && sitemapIndex < 0 && !discovery.cycleComplete) {
    throw new Error("The saved product sitemap is no longer in the sitemap index; resume stopped safely.");
  }
  discovery.sitemapIndexUrl = plan.sitemapIndexUrl;
  discovery.sitemapManifestHash = hashSitemaps(plan);
  if (sitemapIndex >= 0) discovery.sitemapIndex = sitemapIndex;
  discovery.sitemapUrl = plan.productSitemaps[discovery.sitemapIndex] ?? null;
}

function refreshDayIsComplete(metadata: DailyMetadata, today: string): boolean {
  return metadata.refresh.day === today && metadata.refresh.complete;
}

export async function runContinenteDailySync(
  options: ContinenteDailyOptions,
  repository: ContinenteDailyRepository,
  adapter: ContinenteDailyAdapter,
  dependencies: RunDependencies = {},
): Promise<ContinenteDailyReport> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("The daily URL limit must be between 1 and 100.");
  }
  if (options.commit && !options.resume) {
    throw new Error("A daily commit requires --resume so it cannot restart from an old URL.");
  }
  const nowProvider = dependencies.now ?? (() => new Date());
  const runIdProvider = dependencies.createRunId ?? randomUUID;
  const now = nowProvider();
  const today = localDate(now);
  const mode = options.commit ? "commit" : "dry-run";
  const report: ContinenteDailyReport = {
    ok: false,
    mode,
    sourceType: SOURCE_TYPE,
    priceScope: "online",
    writesEnabled: options.commit,
    timezone: TIME_ZONE,
    scheduledTime: "05:00",
    scheduleConfigured: false,
    resume: options.resume,
    limit: options.limit,
    productPageRequestBudget: currentPageBudget(options),
    checkpointBefore: null,
    checkpointAfter: null,
    sitemapCount: 0,
    counts: {
      refreshQueued: 0,
      refreshProcessed: 0,
      scannedSitemapUrls: 0,
      knownUrlsSkipped: 0,
      newUrlsProcessed: 0,
      productsExtracted: 0,
      pricesEligible: 0,
      productsCreated: 0,
      productsReused: 0,
      mappingsCreated: 0,
      mappingsReused: 0,
      pricesCreated: 0,
      pricesUpdated: 0,
      pricesUnchanged: 0,
      priceChanges: 0,
      historyCreatedConfirmed: 0,
      syncErrorsReconciled: 0,
      pricesWritten: 0,
      redirects: 0,
      unavailable: 0,
      retries: 0,
      productPageRequests: 0,
      sublotsCompleted: 0,
      errors: 0,
    },
    errors: [],
  };

  let checkpoint: ContinenteDailyCheckpointRow | null = null;
  let metadata = emptyMetadata();
  let lastAttemptAt: string | null = null;
  let lockAcquired = false;

  if (repository.commitEnabled !== options.commit) {
    throw new Error("The daily mode does not match the repository's write permission.");
  }

  const persist = async (lastSuccessAt: string | null, lastError: string | null) => {
    const fields = checkpointFields(metadata, checkpoint, lastAttemptAt, lastSuccessAt, lastError);
    if (!options.commit) {
      checkpoint = {
        ...fields,
        updated_at: checkpoint?.updated_at ?? nowProvider().toISOString(),
      };
      return;
    }
    try {
      checkpoint = checkpoint
        ? await repository.updateDailyCheckpoint(checkpoint.updated_at, fields)
        : await repository.insertDailyCheckpoint(fields);
    } catch (cause) {
      // A failed acknowledgement does not establish whether the checkpoint write landed.
      // Read the row once; never replay an uncertain mutation.
      const observed = await repository.loadDailyCheckpoint().catch(() => null);
      if (!samePersistedIntent(observed, fields)) throw cause;
      checkpoint = observed;
    }
  };

  try {
    const databasePreflight = await repository.preflight();
    const dailyBlockers = await repository.preflightDailySync();
    if (dailyBlockers.length) throw new Error(dailyBlockers.join(" "));

    const stored = options.resume ? await repository.loadDailyCheckpoint() : null;
    checkpoint = stored;
    metadata = normalizeMetadata(stored?.metadata ?? {});
    report.checkpointBefore = stored
      ? {
        cycle: metadata.discovery.cycle,
        sitemapIndex: metadata.discovery.sitemapIndex,
        offset: metadata.discovery.offset,
      }
      : null;

    if (options.commit && stored?.metadata) {
      const oldLock = metadata.run.lock;
      if (oldLock && Date.parse(oldLock.expiresAt) > now.getTime()) {
        throw new Error("Another Continente daily sync holds the checkpoint lease.");
      }
    }

    const store = await repository.findOnlineStore();
    if (options.commit && !store) {
      throw new Error("Continente Online is not present; no physical store will be created by this job.");
    }
    const candidates = store
      ? await repository.loadOnlinePriceCandidates(store.id)
      : [];
    const previousStatus = metadata.run.status;
    const failedRunResume = options.resume &&
      (previousStatus === "error" || previousStatus === "running");
    if (!options.resume) metadata = emptyMetadata();

    if (!failedRunResume) {
      if (metadata.discovery.cycleComplete) {
        metadata.discovery = {
          sitemapIndexUrl: null,
          sitemapManifestHash: null,
          sitemapIndex: 0,
          sitemapUrl: null,
          offset: 0,
          lastProductUrl: null,
          cycle: metadata.discovery.cycle + 1,
          cycleComplete: false,
        };
      }
      const refreshInProgressToday =
        metadata.refresh.day === today &&
        !metadata.refresh.complete &&
        metadata.refresh.cursor < metadata.refresh.queue.length;
      if (refreshInProgressToday) {
        metadata.phase = "refresh";
      } else if (!refreshDayIsComplete(metadata, today)) {
        metadata.refresh = {
          day: today,
          queue: buildRefreshQueue(candidates, now),
          cursor: 0,
          complete: false,
        };
        metadata.phase = "refresh";
      } else {
        metadata.phase = "discovery";
      }
    }

    const runId = runIdProvider();
    lastAttemptAt = now.toISOString();
    metadata.run = {
      id: runId,
      status: "running",
      startedAt: lastAttemptAt,
      lock: options.commit
        ? {
          runId,
          expiresAt: new Date(now.getTime() + CHECKPOINT_LEASE_MS).toISOString(),
        }
        : null,
    };
    if (options.commit) {
      await persist(checkpoint?.last_success_at ?? null, checkpoint?.last_error ?? null);
      lockAcquired = true;
      if (databasePreflight.blockers.length) {
        throw new Error(`Commit preflight failed: ${databasePreflight.blockers.join(" ")}`);
      }
      if (!databasePreflight.mappingsAvailable) {
        throw new Error("The verified external mapping table is required for a daily commit.");
      }
    }
    report.counts.refreshQueued = metadata.refresh.queue.length;

    const knownPriceSkus = new Set(candidates.map(({ sku }) => sku));
    let usedUrlLimit = 0;
    let scannedUrlLimit = 0;
    let plan: ContinenteSitemapPlan | null = null;

    const checkpointSuccessfulPhase = async () => {
      await persist(checkpoint?.last_success_at ?? null, checkpoint?.last_error ?? null);
      report.counts.sublotsCompleted += 1;
    };

    const processUrls = async (
      urls: readonly string[],
      stableReadCount: number,
      successfulPageCount: number,
    ) => {
      const result = await adapter.runProductUrls(urls, stableReadCount);
      report.counts.productPageRequests += result.productPageRequests;
      report.counts.retries += result.retries;
      report.counts.productsExtracted += result.firstPassAttempts.filter(
        ({ outcome }) => outcome === "product",
      ).length;
      report.counts.redirects += result.firstPassAttempts.filter(
        ({ outcome }) => outcome === "redirect",
      ).length;
      const failure = result.stoppedReason ?? productPageFailure(result.firstPassAttempts);
      if (failure) throw new Error(failure);
      if (options.commit && (
        result.stability.changed > 0 ||
        result.stability.failed > 0 ||
        result.stability.stable !== result.firstPassAttempts.filter(
          ({ outcome }) => outcome === "product",
        ).length
      )) {
        throw new Error("Product ID changed or failed its stability reread; this sublot was not checkpointed.");
      }

      const observations = result.firstPassAttempts
        .map(({ observation }) => observation)
        .filter((value): value is ContinenteProductObservation => value !== null);
      const usable = observations.filter(validObservationForSync);
      report.counts.unavailable += observations.length - usable.length;
      report.counts.pricesEligible += usable.length;

      let beforePrices = new Map<string, ContinenteStoredOnlinePrice>();
      const previouslyMapped = new Set<string>();
      if (options.commit && usable.length) {
        if (!store) throw new Error("The online store disappeared before a daily sublot.");
        const skus = usable.flatMap((observation) =>
          observation.externalProductId ? [observation.externalProductId] : []
        );
        beforePrices = await repository.loadOnlinePricesBySkus(store.id, skus);
        for (const sku of skus) {
          if ((await repository.findMappings(sku)).length > 0) previouslyMapped.add(sku);
        }
      }

      if (usable.length) {
        const syncReport = await syncContinenteObservations(
          usable,
          repository,
          nowProvider(),
        );
        report.counts.productsCreated += syncReport.counts.sourceNativeCreated;
        report.counts.productsReused += syncReport.counts.existingReused;
        report.counts.mappingsCreated += syncReport.counts.mappingsCreated;
        report.counts.mappingsReused += previouslyMapped.size;
        report.counts.pricesWritten += syncReport.counts.pricesWritten;
        await reconcileSublotWrites(
          usable,
          syncReport,
          repository,
          store,
          beforePrices,
          report.counts,
        );
        for (const observation of usable) {
          if (observation.externalProductId) knownPriceSkus.add(observation.externalProductId);
        }
      }

      usedUrlLimit += successfulPageCount;
      return result;
    };

    let refreshRemaining = Math.max(0, metadata.refresh.queue.length - metadata.refresh.cursor);
    while (
      metadata.phase === "refresh" &&
      refreshRemaining > 0 &&
      usedUrlLimit < options.limit
    ) {
      const count = Math.min(
        MAX_SUBLOT_SIZE,
        refreshRemaining,
        options.limit - usedUrlLimit,
      );
      const batch = metadata.refresh.queue.slice(
        metadata.refresh.cursor,
        metadata.refresh.cursor + count,
      );
      await processUrls(batch.map(({ sourceReference }) => sourceReference), options.commit ? count : 0, count);
      metadata.refresh.cursor += count;
      report.counts.refreshProcessed += count;
      refreshRemaining -= count;
      if (metadata.refresh.cursor >= metadata.refresh.queue.length) {
        metadata.refresh = { day: today, queue: [], cursor: 0, complete: true };
        metadata.phase = "discovery";
      }
      await checkpointSuccessfulPhase();
    }

    if (metadata.phase === "refresh" && metadata.refresh.cursor >= metadata.refresh.queue.length) {
      metadata.refresh = { day: today, queue: [], cursor: 0, complete: true };
      metadata.phase = "discovery";
      await checkpointSuccessfulPhase();
    }

    if (metadata.phase === "discovery" && usedUrlLimit < options.limit) {
      plan = await adapter.discoverProductSitemaps();
      report.sitemapCount = plan.productSitemaps.length;
      report.counts.retries += plan.retries;
      prepareDiscovery(metadata, plan);
      const maximumScannedUrls = options.limit * MAX_SCAN_URLS_PER_RUN_MULTIPLIER;
      while (
        metadata.phase === "discovery" &&
        usedUrlLimit < options.limit &&
        scannedUrlLimit < maximumScannedUrls
      ) {
        if (metadata.discovery.sitemapIndex >= plan.productSitemaps.length) {
          metadata.discovery.cycleComplete = true;
          metadata.discovery.sitemapUrl = null;
          metadata.discovery.offset = 0;
          metadata.discovery.lastProductUrl = null;
          metadata.phase = "complete";
          await checkpointSuccessfulPhase();
          break;
        }
        const sitemapUrl = plan.productSitemaps[metadata.discovery.sitemapIndex]!;
        metadata.discovery.sitemapUrl = sitemapUrl;
        const rawLimit = Math.min(
          MAX_SUBLOT_SIZE,
          maximumScannedUrls - scannedUrlLimit,
        );
        const remainingPageBudget = options.limit - usedUrlLimit;
        const batch = await adapter.runSitemapBatch(
          sitemapUrl,
          metadata.discovery.offset,
          rawLimit,
          options.commit ? Math.min(MAX_SUBLOT_SIZE, remainingPageBudget) : 0,
          knownPriceSkus,
          remainingPageBudget,
          metadata.discovery.lastProductUrl,
        );
        report.counts.productPageRequests += batch.productPageRequests;
        report.counts.retries += batch.retries;
        report.counts.scannedSitemapUrls += batch.selectedUrls.length;
        report.counts.knownUrlsSkipped += batch.skippedKnown;
        report.counts.productsExtracted += batch.firstPassAttempts.filter(
          ({ outcome }) => outcome === "product",
        ).length;
        report.counts.newUrlsProcessed += batch.firstPassAttempts.length;
        report.counts.redirects += batch.firstPassAttempts.filter(
          ({ outcome }) => outcome === "redirect",
        ).length;
        const failure = batch.stoppedReason ?? productPageFailure(batch.firstPassAttempts);
        if (failure) throw new Error(failure);
        if (options.commit && (
          batch.stability.changed > 0 ||
          batch.stability.failed > 0 ||
          batch.stability.stable !== batch.firstPassAttempts.filter(
            ({ outcome }) => outcome === "product",
          ).length
        )) {
          throw new Error("Product ID changed or failed its stability reread; this sublot was not checkpointed.");
        }

        const observations = batch.firstPassAttempts
          .map(({ observation }) => observation)
          .filter((value): value is ContinenteProductObservation => value !== null);
        const usable = observations.filter(validObservationForSync);
        report.counts.unavailable += observations.length - usable.length;
        report.counts.pricesEligible += usable.length;

        let beforePrices = new Map<string, ContinenteStoredOnlinePrice>();
        const previouslyMapped = new Set<string>();
        if (options.commit && usable.length) {
          if (!store) throw new Error("The online store disappeared before a discovery sublot.");
          const skus = usable.map((observation) => observation.externalProductId!);
          beforePrices = await repository.loadOnlinePricesBySkus(store.id, skus);
          for (const sku of skus) {
            if ((await repository.findMappings(sku)).length > 0) previouslyMapped.add(sku);
          }
        }
        if (usable.length) {
          const syncReport = await syncContinenteObservations(usable, repository, nowProvider());
          report.counts.productsCreated += syncReport.counts.sourceNativeCreated;
          report.counts.productsReused += syncReport.counts.existingReused;
          report.counts.mappingsCreated += syncReport.counts.mappingsCreated;
          report.counts.mappingsReused += previouslyMapped.size;
          report.counts.pricesWritten += syncReport.counts.pricesWritten;
          await reconcileSublotWrites(
            usable,
            syncReport,
            repository,
            store,
            beforePrices,
            report.counts,
          );
          for (const observation of usable) {
            if (observation.externalProductId) knownPriceSkus.add(observation.externalProductId);
          }
        }

        scannedUrlLimit += batch.selectedUrls.length;
        usedUrlLimit += batch.firstPassAttempts.length;
        metadata.discovery.offset = batch.nextOffset;
        metadata.discovery.lastProductUrl =
          batch.selectedUrls.at(-1) ?? metadata.discovery.lastProductUrl;
        if (batch.nextOffset >= batch.totalUrls) {
          metadata.discovery.sitemapIndex += 1;
          metadata.discovery.sitemapUrl =
            plan.productSitemaps[metadata.discovery.sitemapIndex] ?? null;
          metadata.discovery.offset = 0;
          metadata.discovery.lastProductUrl = null;
          if (metadata.discovery.sitemapIndex >= plan.productSitemaps.length) {
            metadata.discovery.cycleComplete = true;
            metadata.phase = "complete";
          }
        }
        await checkpointSuccessfulPhase();
        if (batch.selectedUrls.length === 0) {
          if (metadata.phase === "discovery") {
            throw new Error("Product sitemap returned no progress; checkpoint was not advanced.");
          }
        }
      }
    }

    metadata.run = {
      id: metadata.run.id,
      status: "complete",
      startedAt: lastAttemptAt,
      lock: null,
    };
    if (metadata.phase === "refresh" && metadata.refresh.cursor >= metadata.refresh.queue.length) {
      metadata.refresh = { day: today, queue: [], cursor: 0, complete: true };
      metadata.phase = "discovery";
    }
    await persist(nowProvider().toISOString(), null);
    lockAcquired = false;
    report.ok = true;
    report.checkpointAfter = {
      cycle: metadata.discovery.cycle,
      sitemapIndex: metadata.discovery.sitemapIndex,
      offset: metadata.discovery.offset,
    };
    return report;
  } catch (cause) {
    const message = errorMessage(cause);
    report.errors.push(message);
    report.counts.errors += 1;
    if (options.commit && lockAcquired) {
      metadata.run = { ...metadata.run, status: "error", lock: null };
      try {
        await persist(checkpoint?.last_success_at ?? null, message);
      } catch {
        report.errors.push("Could not confirm the error checkpoint; inspect source_sync_state before retrying.");
      }
    }
    report.checkpointAfter = checkpoint
      ? {
        cycle: metadata.discovery.cycle,
        sitemapIndex: metadata.discovery.sitemapIndex,
        offset: metadata.discovery.offset,
      }
      : null;
    return report;
  }
}