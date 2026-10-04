import { createHash, randomUUID } from "node:crypto";
import type {
  ContinenteMappingRepository,
} from "./continente-types.js";
import {
  buildAuchanDryRunItems,
  type AuchanCatalogReader,
  type AuchanDryRunItem,
} from "./auchan-dry-run.js";
import type { AuchanProductObservation } from "./auchan-types.js";
import type {
  AuchanDailyCheckpointRow,
  AuchanRefreshPriceCandidate,
  AuchanReferenceStore,
} from "./supabase-auchan-sync-repository.js";
import {
  syncAuchanObservations,
  type AuchanSyncRepository,
} from "./auchan-sync.js";
import type {
  AuchanAdapter,
  AuchanProductUrlBatch,
  AuchanSitemapBatch,
  AuchanSitemapPlan,
} from "./auchan-adapter.js";

type Row = Record<string, unknown>;

const SOURCE_TYPE = "auchan";
const TIME_ZONE = "Europe/Lisbon";
const MAX_SUBLOT_SIZE = 20;
const MAX_SCAN_URLS_PER_RUN_MULTIPLIER = 10;
const CHECKPOINT_LEASE_MS = 6 * 60 * 60 * 1_000;
const MAX_DAILY_LIMIT = 100;

export interface AuchanDailyOptions {
  readonly limit: number;
  readonly resume: boolean;
  readonly commit: boolean;
}

export interface AuchanDailyRepository extends AuchanSyncRepository {
  preflightDailySync(): Promise<string[]>;
  loadDailyCheckpoint(): Promise<AuchanDailyCheckpointRow | null>;
  insertDailyCheckpoint(
    fields: Omit<AuchanDailyCheckpointRow, "updated_at"> & { readonly updated_at?: string },
  ): Promise<AuchanDailyCheckpointRow>;
  updateDailyCheckpoint(
    expectedUpdatedAt: string,
    fields: Omit<AuchanDailyCheckpointRow, "updated_at"> & { readonly updated_at?: string },
  ): Promise<AuchanDailyCheckpointRow>;
  loadDailyPriceCandidates(storeId: string): Promise<AuchanRefreshPriceCandidate[]>;
}

export type AuchanDailyAdapter = Pick<
  AuchanAdapter,
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

export interface AuchanDailyReport {
  ok: boolean;
  mode: "dry-run" | "commit";
  sourceType: "auchan";
  priceScope: "reference_only_2650_435";
  writesEnabled: boolean;
  timezone: "Europe/Lisbon";
  scheduledTime: "05:20";
  scheduleConfigured: true;
  resume: boolean;
  limit: number;
  productPageRequestBudget: number;
  checkpointBefore: { cycle: number; sitemapIndex: number; offset: number } | null;
  checkpointAfter: { cycle: number; sitemapIndex: number; offset: number } | null;
  sitemapCount: number;
  priceResults: {
    sku: string;
    action: "created" | "changed" | "unchanged";
    capturedAt: string;
  }[];
  referenceStore: {
    id: string | null;
    name: "Auchan Online · referência 2650-435 (Amadora)";
  };
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
    historyDuplicatesSuppressed: number;
    syncErrorsReconciled: number;
    pricesWritten: number;
    redirects: number;
    unavailable: number;
    productPageRequests: number;
    sublotsCompleted: number;
    errors: number;
  };
  errors: string[];
}

function isRecord(value: unknown): value is Row {
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
    throw new Error("Unsupported Auchan daily checkpoint version.");
  }
  const fresh = emptyMetadata();
  const refreshInput = isRecord(input.refresh) ? input.refresh : {};
  const discoveryInput = isRecord(input.discovery) ? input.discovery : {};
  const runInput = isRecord(input.run) ? input.run : {};
  const queue = refreshInput.queue ?? [];
  if (
    !Array.isArray(queue) ||
    queue.some((item) =>
      !isRecord(item) ||
      typeof item.sku !== "string" ||
      typeof item.sourceReference !== "string"
    )
  ) throw new Error("The Auchan refresh checkpoint queue is invalid.");

  const refreshCursor = Number(refreshInput.cursor ?? 0);
  const sitemapIndex = Number(discoveryInput.sitemapIndex ?? 0);
  const offset = Number(discoveryInput.offset ?? 0);
  const cycle = Number(discoveryInput.cycle ?? 0);
  if (
    !Number.isSafeInteger(refreshCursor) || refreshCursor < 0 ||
    !Number.isSafeInteger(sitemapIndex) || sitemapIndex < 0 ||
    !Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(cycle) || cycle < 0
  ) throw new Error("The Auchan daily checkpoint contains an invalid cursor.");

  const phase = input.phase ?? fresh.phase;
  const status = runInput.status ?? fresh.run.status;
  if (
    !["refresh", "discovery", "complete"].includes(String(phase)) ||
    !["idle", "running", "error", "complete"].includes(String(status))
  ) throw new Error("The Auchan daily checkpoint phase is invalid.");
  const lockInput = runInput.lock;
  let lock: DailyMetadata["run"]["lock"] = null;
  if (lockInput !== null && lockInput !== undefined) {
    if (
      !isRecord(lockInput) ||
      typeof lockInput.runId !== "string" ||
      typeof lockInput.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(lockInput.expiresAt))
    ) throw new Error("The Auchan daily checkpoint lock is invalid.");
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
      url.origin === "https://www.auchan.pt" &&
      url.pathname.startsWith("/pt/") &&
      url.pathname.endsWith(`/${sku}.html`) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function buildRefreshQueue(
  candidates: readonly AuchanRefreshPriceCandidate[],
): RefreshItem[] {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (
      !/^[1-9]\d*$/.test(candidate.sku) ||
      !safeSourceUrl(candidate.sourceReference, candidate.sku) ||
      !Number.isFinite(Date.parse(candidate.capturedAt)) ||
      (candidate.validUntil !== null && !Number.isFinite(Date.parse(candidate.validUntil))) ||
      !Number.isFinite(Number(candidate.price)) ||
      Number(candidate.price) <= 0 ||
      !candidate.productId
    ) throw new Error(`Saved price metadata for Auchan SKU ${candidate.sku} cannot be refreshed safely.`);
    if (seen.has(candidate.sku)) {
      throw new Error(`Multiple saved Auchan price rows exist for SKU ${candidate.sku}.`);
    }
    seen.add(candidate.sku);
  }
  return [...candidates]
    .sort((left, right) => {
      if (left.validUntil === null && right.validUntil !== null) return -1;
      if (right.validUntil === null && left.validUntil !== null) return 1;
      if (left.validUntil && right.validUntil) {
        const expirationOrder = Date.parse(left.validUntil) - Date.parse(right.validUntil);
        if (expirationOrder) return expirationOrder;
      }
      return Date.parse(left.capturedAt) - Date.parse(right.capturedAt) ||
        left.sku.localeCompare(right.sku);
    })
    .map(({ sku, sourceReference }) => ({ sku, sourceReference }));
}

function checkpointCursor(metadata: DailyMetadata): string {
  if (metadata.phase === "refresh") return `refresh:${metadata.refresh.cursor}`;
  if (metadata.phase === "discovery") {
    return `discovery:${metadata.discovery.cycle}:${metadata.discovery.sitemapIndex}:${metadata.discovery.offset}`;
  }
  return `complete:${metadata.discovery.cycle}`;
}

function errorMessage(cause: unknown): string {
  const value = cause instanceof Error ? cause.message : "Unexpected Auchan daily sync error.";
  return value
    .replace(/https?:\/\/\S+/gi, "[source URL]")
    .replace(/\b(?:authorization|apikey|service[_-]?role[_-]?key)\b[^,\s]*/gi, "[redacted]")
    .slice(0, 500);
}

function checkpointFields(
  metadata: DailyMetadata,
  lastAttemptAt: string | null,
  lastSuccessAt: string | null,
  lastError: string | null,
): Omit<AuchanDailyCheckpointRow, "updated_at"> {
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
  return JSON.stringify(value) ?? "null";
}

function samePersistedIntent(
  actual: AuchanDailyCheckpointRow | null,
  intended: Omit<AuchanDailyCheckpointRow, "updated_at">,
): actual is AuchanDailyCheckpointRow {
  return actual !== null &&
    actual.source_type === intended.source_type &&
    actual.cursor_value === intended.cursor_value &&
    actual.last_attempt_at === intended.last_attempt_at &&
    actual.last_success_at === intended.last_success_at &&
    actual.last_error === intended.last_error &&
    stableJson(actual.metadata) === stableJson(intended.metadata);
}

function hashPlan(plan: AuchanSitemapPlan): string {
  return createHash("sha256")
    .update(`${plan.sitemapIndexUrl}\n${plan.productSitemaps.join("\n")}`)
    .digest("hex");
}

function prepareDiscovery(metadata: DailyMetadata, plan: AuchanSitemapPlan): void {
  const manifestHash = hashPlan(plan);
  const manifestChanged = metadata.discovery.sitemapManifestHash !== null &&
    (
      metadata.discovery.sitemapIndexUrl !== plan.sitemapIndexUrl ||
      metadata.discovery.sitemapManifestHash !== manifestHash
    );
  if (manifestChanged) {
    metadata.discovery.sitemapIndex = 0;
    metadata.discovery.offset = 0;
    metadata.discovery.lastProductUrl = null;
    metadata.discovery.cycleComplete = false;
  }
  metadata.discovery.sitemapIndexUrl = plan.sitemapIndexUrl;
  metadata.discovery.sitemapManifestHash = manifestHash;
  metadata.discovery.sitemapUrl =
    plan.productSitemaps[metadata.discovery.sitemapIndex] ?? null;
}

function refreshDayIsComplete(metadata: DailyMetadata, today: string): boolean {
  return metadata.refresh.day === today && metadata.refresh.complete;
}

function productPageFailure(
  attempts: readonly { readonly outcome: string; readonly error: string | null }[],
): string | null {
  const failed = attempts.find(({ outcome }) =>
    outcome === "blocked" ||
    outcome === "http_error" ||
    outcome === "network_error" ||
    outcome === "request_budget_exhausted"
  );
  if (!failed) return null;
  return failed.outcome === "blocked"
    ? "Auchan stopped the run on a block or anti-bot challenge."
    : `Auchan product-page request failed (${failed.outcome}${failed.error ? `: ${failed.error}` : ""}).`;
}

function validObservationForSync(item: AuchanDryRunItem): boolean {
  return item.identityStable && item.priceSafeToImport;
}

function emptyReport(options: AuchanDailyOptions): AuchanDailyReport {
  return {
    ok: false,
    mode: options.commit ? "commit" : "dry-run",
    sourceType: "auchan",
    priceScope: "reference_only_2650_435",
    writesEnabled: options.commit,
    timezone: TIME_ZONE,
    scheduledTime: "05:20",
    scheduleConfigured: true,
    resume: options.resume,
    limit: options.limit,
    productPageRequestBudget: options.limit * 2,
    checkpointBefore: null,
    checkpointAfter: null,
    sitemapCount: 0,
    priceResults: [],
    referenceStore: {
      id: null,
      name: "Auchan Online · referência 2650-435 (Amadora)",
    },
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
      historyDuplicatesSuppressed: 0,
      syncErrorsReconciled: 0,
      pricesWritten: 0,
      redirects: 0,
      unavailable: 0,
      productPageRequests: 0,
      sublotsCompleted: 0,
      errors: 0,
    },
    errors: [],
  };
}

export async function runAuchanDailySync(
  repository: AuchanDailyRepository,
  adapter: AuchanDailyAdapter,
  catalogReader: AuchanCatalogReader,
  mappings: ContinenteMappingRepository,
  options: AuchanDailyOptions,
  dependencies: RunDependencies = {},
): Promise<AuchanDailyReport> {
  const report = emptyReport(options);
  const nowProvider = dependencies.now ?? (() => new Date());
  const runIdProvider = dependencies.createRunId ?? randomUUID;
  const startedAt = nowProvider();
  const today = localDate(startedAt);
  let checkpoint: AuchanDailyCheckpointRow | null = null;
  let metadata = emptyMetadata();
  let lastAttemptAt: string | null = null;
  let lockAcquired = false;

  const persist = async (lastSuccessAt: string | null, lastError: string | null) => {
    const fields = checkpointFields(metadata, lastAttemptAt, lastSuccessAt, lastError);
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
      // A failed acknowledgement does not establish whether the checkpoint landed.
      const observed = await repository.loadDailyCheckpoint().catch(() => null);
      if (!samePersistedIntent(observed, fields)) throw cause;
      checkpoint = observed;
    }
  };

  try {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_DAILY_LIMIT) {
      throw new Error(`The Auchan daily limit must be between 1 and ${MAX_DAILY_LIMIT}.`);
    }
    if (repository.commitEnabled !== options.commit) {
      throw new Error("The daily mode does not match the repository's write permission.");
    }
    if (options.commit && !options.resume) {
      throw new Error("Auchan daily commits require --resume so the saved checkpoint is preserved.");
    }

    const databasePreflight = await repository.preflight();
    if (databasePreflight.blockers.length) {
      throw new Error(databasePreflight.blockers.join(" "));
    }
    const dailyBlockers = await repository.preflightDailySync();
    if (dailyBlockers.length) throw new Error(dailyBlockers.join(" "));
    const store: AuchanReferenceStore | null = databasePreflight.referenceStore;
    if (!store) throw new Error("The exact Auchan Amadora reference store is unavailable.");
    report.referenceStore.id = store.id;

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
      if (oldLock && Date.parse(oldLock.expiresAt) > startedAt.getTime()) {
        throw new Error("Another Auchan daily sync holds the checkpoint lease.");
      }
    }

    const candidates = await repository.loadDailyPriceCandidates(store.id);
    const previousStatus = metadata.run.status;
    const interruptedRun = options.resume &&
      (previousStatus === "error" || previousStatus === "running");
    if (!options.resume) metadata = emptyMetadata();

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
    } else if (
      !interruptedRun &&
      !refreshDayIsComplete(metadata, today)
    ) {
      metadata.refresh = {
        day: today,
        queue: buildRefreshQueue(candidates),
        cursor: 0,
        complete: false,
      };
      metadata.phase = "refresh";
    } else if (metadata.refresh.day !== today && !refreshDayIsComplete(metadata, today)) {
      // An interrupted run from an earlier day still refreshes current prices first,
      // while retaining its separate discovery bookmark.
      metadata.refresh = {
        day: today,
        queue: buildRefreshQueue(candidates),
        cursor: 0,
        complete: false,
      };
      metadata.phase = "refresh";
    } else {
      metadata.phase = "discovery";
    }

    const runId = runIdProvider();
    lastAttemptAt = startedAt.toISOString();
    metadata.run = {
      id: runId,
      status: "running",
      startedAt: lastAttemptAt,
      lock: options.commit
        ? {
          runId,
          expiresAt: new Date(startedAt.getTime() + CHECKPOINT_LEASE_MS).toISOString(),
        }
        : null,
    };
    if (options.commit) {
      await persist(checkpoint?.last_success_at ?? null, checkpoint?.last_error ?? null);
      lockAcquired = true;
    }

    report.counts.refreshQueued = metadata.refresh.queue.length;
    const knownProductIds = new Set(candidates.map(({ sku }) => sku));
    let usedProductLimit = 0;
    let scannedUrlLimit = 0;
    let plan: AuchanSitemapPlan | null = null;

    const checkpointSuccessfulPhase = async () => {
      if (options.commit) {
        await persist(checkpoint?.last_success_at ?? null, null);
      }
      report.counts.sublotsCompleted += 1;
    };

    const processResults = async (
      result: AuchanProductUrlBatch | AuchanSitemapBatch,
      expectedPageCount: number,
    ): Promise<void> => {
      const attempts = result.firstPassAttempts;
      report.counts.productPageRequests += result.productPageRequests;
      report.counts.productsExtracted += attempts.filter(
        ({ outcome }) => outcome === "product",
      ).length;
      report.counts.redirects += attempts.filter(
        ({ outcome }) => outcome === "redirect",
      ).length;
      report.counts.unavailable += attempts.filter(
        ({ outcome }) => outcome === "invalid_page",
      ).length;
      if (result.stoppedReason) throw new Error(result.stoppedReason);
      const failure = productPageFailure(attempts);
      if (failure) throw new Error(failure);
      if (attempts.length !== expectedPageCount) {
        throw new Error("Auchan returned an incomplete product-page sublot; it was not checkpointed.");
      }

      const observations = attempts
        .map(({ observation }) => observation)
        .filter((value): value is AuchanProductObservation => value !== null);
      const identifiableObservations = observations.filter(
        ({ externalProductId }) => externalProductId !== null,
      );
      if (identifiableObservations.some((item) =>
        item.priceScope !== "reference_only_2650_435" || !item.priceScopeEvidence
      )) {
        throw new Error("A selected Auchan page did not prove the 2650-435 Amadora reference scope.");
      }
      const observedIds = identifiableObservations.map(
        ({ externalProductId }) => externalProductId!,
      );
      if (new Set(observedIds).size !== observedIds.length) {
        throw new Error("Duplicate Auchan product identity in a sublot; checkpoint was not advanced.");
      }
      if (
        result.stability.changed > 0 ||
        result.stability.failed > 0 ||
        result.stability.stable !== identifiableObservations.length
      ) {
        throw new Error("Auchan product identity changed or failed its stability reread; sublot not checkpointed.");
      }

      const stableUrls = new Set(
        result.stability.details.filter(({ stable }) => stable).map(({ url }) => url),
      );
      const items = await buildAuchanDryRunItems(
        identifiableObservations,
        stableUrls,
        catalogReader,
        mappings,
        nowProvider(),
      );
      report.counts.unavailable += observations.length - identifiableObservations.length;
      const blockingReasons = items.flatMap((item) =>
        item.importBlockers.filter((reason) =>
          reason !== "price_not_valid_eur" &&
          reason !== "product_unavailable"
        )
      );
      if (blockingReasons.length) {
        throw new Error(`Auchan sublot validation failed: ${[...new Set(blockingReasons)].join(", ")}.`);
      }
      const usable = items.filter(validObservationForSync);
      report.counts.unavailable += items.length - usable.length;
      report.counts.pricesEligible += usable.length;

      if (usable.length) {
        const syncReport = await syncAuchanObservations(usable, repository, nowProvider());
        report.counts.productsCreated += syncReport.counts.sourceNativeCreated;
        report.counts.productsReused += syncReport.counts.existingReused;
        report.counts.mappingsCreated += syncReport.counts.mappingsCreated;
        report.counts.mappingsReused += syncReport.counts.mappingsReused;
        report.counts.pricesWritten += syncReport.counts.pricesWritten;
        report.counts.pricesCreated += syncReport.counts.pricesCreated;
        report.counts.pricesUpdated += syncReport.counts.pricesUpdated;
        report.counts.pricesUnchanged += syncReport.counts.pricesUnchanged;
        report.counts.priceChanges += syncReport.counts.priceChanges;
        report.counts.historyCreatedConfirmed += syncReport.counts.historyRowsConfirmed ?? 0;
        report.counts.historyDuplicatesSuppressed += syncReport.counts.historyRowsSuppressed;
        report.counts.syncErrorsReconciled += syncReport.items.filter(
          ({ rpcAcknowledgementResolved }) => rpcAcknowledgementResolved,
        ).length;
        for (const item of syncReport.items) {
          if (
            item.sku &&
            item.priceAction &&
            (
              item.action === "price_and_history_confirmed" ||
              item.action === "price_changed_with_history_confirmed" ||
              item.action === "price_refreshed_without_duplicate_history"
            )
          ) {
            report.priceResults.push({
              sku: item.sku,
              action: item.priceAction,
              capturedAt: usable.find(
                ({ observation }) => observation.externalProductId === item.sku,
              )!.observation.capturedAt,
            });
          }
        }
        if (syncReport.blockers.length || syncReport.counts.errors > 0) {
          const itemErrors = syncReport.items.flatMap(({ error }) =>
            error ? [error] : []
          );
          throw new Error(
            `Auchan database sublot failed verification: ${
              [...syncReport.blockers, ...itemErrors].map(errorMessage).join(" ")
            }`,
          );
        }
        if (options.commit && syncReport.counts.pricesWritten !== usable.length) {
          throw new Error("Not every Auchan price write was confirmed by GET readback.");
        }
        for (const item of usable) {
          const sku = item.observation.externalProductId;
          if (sku) knownProductIds.add(sku);
        }
      }
    };

    let refreshRemaining = Math.max(
      0,
      metadata.refresh.queue.length - metadata.refresh.cursor,
    );
    while (
      metadata.phase === "refresh" &&
      refreshRemaining > 0 &&
      usedProductLimit < options.limit
    ) {
      const count = Math.min(
        MAX_SUBLOT_SIZE,
        refreshRemaining,
        options.limit - usedProductLimit,
      );
      const batch = metadata.refresh.queue.slice(
        metadata.refresh.cursor,
        metadata.refresh.cursor + count,
      );
      const result = await adapter.runProductUrls(
        batch.map(({ sourceReference }) => sourceReference),
        count,
      );
      await processResults(result, count);
      metadata.refresh.cursor += count;
      report.counts.refreshProcessed += count;
      usedProductLimit += count;
      refreshRemaining -= count;
      if (metadata.refresh.cursor >= metadata.refresh.queue.length) {
        metadata.refresh = { day: today, queue: [], cursor: 0, complete: true };
        metadata.phase = "discovery";
      }
      await checkpointSuccessfulPhase();
    }

    if (
      metadata.phase === "refresh" &&
      metadata.refresh.cursor >= metadata.refresh.queue.length
    ) {
      metadata.refresh = { day: today, queue: [], cursor: 0, complete: true };
      metadata.phase = "discovery";
      await checkpointSuccessfulPhase();
    }

    if (metadata.phase === "discovery" && usedProductLimit < options.limit) {
      plan = await adapter.discoverProductSitemaps();
      report.sitemapCount = plan.productSitemaps.length;
      prepareDiscovery(metadata, plan);
      const maximumScannedUrls = options.limit * MAX_SCAN_URLS_PER_RUN_MULTIPLIER;
      while (
        metadata.phase === "discovery" &&
        usedProductLimit < options.limit &&
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
        const remainingPageBudget = options.limit - usedProductLimit;
        const batch = await adapter.runSitemapBatch(
          sitemapUrl,
          metadata.discovery.offset,
          rawLimit,
          Math.min(MAX_SUBLOT_SIZE, remainingPageBudget),
          knownProductIds,
          remainingPageBudget,
          metadata.discovery.lastProductUrl,
        );
        if (!batch.selectedUrls.length) {
          throw new Error("Auchan product sitemap returned no progress; checkpoint was not advanced.");
        }
        report.counts.scannedSitemapUrls += batch.selectedUrls.length;
        report.counts.knownUrlsSkipped += batch.skippedKnown;
        report.counts.newUrlsProcessed += batch.firstPassAttempts.length;
        await processResults(batch, batch.firstPassAttempts.length);

        scannedUrlLimit += batch.selectedUrls.length;
        usedProductLimit += batch.firstPassAttempts.length;
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
      }
    }

    if (
      metadata.phase === "refresh" &&
      metadata.refresh.cursor >= metadata.refresh.queue.length
    ) {
      metadata.refresh = { day: today, queue: [], cursor: 0, complete: true };
      metadata.phase = "discovery";
    }
    metadata.run = {
      id: metadata.run.id,
      status: "complete",
      startedAt: lastAttemptAt,
      lock: null,
    };
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
        report.errors.push("Could not confirm the Auchan error checkpoint; inspect source_sync_state before retrying.");
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