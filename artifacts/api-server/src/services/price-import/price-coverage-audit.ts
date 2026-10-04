export type PriceCoverageAuditRow = Readonly<Record<string, unknown>>;

export interface PriceCoverageAuditInput {
  readonly products: readonly PriceCoverageAuditRow[];
  readonly stores: readonly PriceCoverageAuditRow[];
  readonly mappings: readonly PriceCoverageAuditRow[];
  readonly prices: readonly PriceCoverageAuditRow[];
}

export interface DuplicateIdentitySummary {
  readonly groups: number;
  readonly extraRows: number;
}

export interface CapturedAtAgeSummary {
  readonly count: number;
  readonly invalidTimestamps: number;
  readonly minHours: number | null;
  readonly medianHours: number | null;
  readonly p90Hours: number | null;
  readonly maxHours: number | null;
}

export interface PriceCoverageChannelSummary {
  readonly channel: string;
  readonly stores: number;
  readonly activeStores: number;
  readonly prices: number;
  readonly verifiedPrices: number;
  readonly validPrices: number;
  readonly expiredVerifiedPrices: number;
  readonly notCurrentVerifiedPrices: number;
  readonly invalidValidityWindowPrices: number;
  readonly capturedAtAgeHours: CapturedAtAgeSummary;
  readonly coverage: {
    readonly coveredActiveProducts: number;
    readonly activeProducts: number;
    readonly percent: number | null;
  };
  readonly orphanPrices: {
    readonly rows: number;
    readonly missingProductRows: number;
    readonly missingStoreRows: number;
  };
}

export interface PriceCoverageSourceSummary {
  readonly sourceType: string | null;
  readonly products: {
    readonly total: number;
    readonly active: number;
    readonly duplicateIdentities: DuplicateIdentitySummary;
  };
  readonly mappings: {
    readonly total: number;
    readonly duplicateIdentities: DuplicateIdentitySummary;
    readonly orphanRows: number;
  };
  readonly stores: {
    readonly total: number;
    readonly active: number;
    readonly duplicateIdentities: DuplicateIdentitySummary;
  };
  readonly prices: {
    readonly total: number;
    readonly duplicateIdentities: DuplicateIdentitySummary;
  };
  readonly channels: readonly PriceCoverageChannelSummary[];
}

export interface PriceCoverageScopeCheck {
  readonly ok: boolean;
  readonly expected: string;
  readonly candidateStores: number;
  readonly compliantStores: number;
  readonly pricesInExpectedChannel: number;
  readonly pricesOutsideExpectedChannel: number;
  readonly additionalOutOfScopeStores: number;
  readonly issues: readonly string[];
}

export interface PriceCoverageAuditReport {
  readonly generatedAt: string;
  readonly asOf: string;
  readonly readOnly: true;
  readonly databaseWrites: 0;
  readonly rpcCalls: 0;
  readonly tablesRead: readonly [
    "products",
    "stores",
    "external_product_mappings",
    "prices",
  ];
  readonly sources: readonly PriceCoverageSourceSummary[];
  readonly expectedScopes: {
    readonly continenteOnline: PriceCoverageScopeCheck;
    readonly auchanAmadoraReference: PriceCoverageScopeCheck;
  };
}

const CONTINENTE_ONLINE_EXTERNAL_ID = "online";
const AUCHAN_REFERENCE_EXTERNAL_ID = "reference:2650-435";
const AUCHAN_REFERENCE_POSTAL_CODE = "2650-435";
const HOUR_MS = 60 * 60 * 1000;

function readText(
  row: PriceCoverageAuditRow,
  field: string,
  table: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`public.${table}.${field} was not text or null.`);
  }
  return value.trim() || null;
}

function requiredText(
  row: PriceCoverageAuditRow,
  field: string,
  table: string,
): string {
  const value = readText(row, field, table);
  if (!value) throw new Error(`public.${table}.${field} was empty or null.`);
  return value;
}

function readBoolean(
  row: PriceCoverageAuditRow,
  field: string,
  table: string,
): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new Error(`public.${table}.${field} was not boolean.`);
  }
  return value;
}

function sourceTypeOf(row: PriceCoverageAuditRow, table: string): string | null {
  return readText(row, "source_type", table);
}

function sourceKey(sourceType: string | null): string {
  return JSON.stringify(sourceType);
}

function duplicateIdentitySummary(
  rows: readonly PriceCoverageAuditRow[],
  identityOf: (row: PriceCoverageAuditRow) => string | null,
): DuplicateIdentitySummary {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const identity = identityOf(row);
    if (identity === null) continue;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }

  let groups = 0;
  let extraRows = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      groups += 1;
      extraRows += count - 1;
    }
  }
  return { groups, extraRows };
}

function identity(
  row: PriceCoverageAuditRow,
  table: string,
  firstField: string,
  secondField: string,
): string | null {
  const first = readText(row, firstField, table);
  const second = readText(row, secondField, table);
  return first && second ? JSON.stringify([first, second]) : null;
}

function parseTimestamp(
  value: string | null,
): { readonly timestamp: number | null; readonly invalid: boolean } {
  if (value === null) return { timestamp: null, invalid: false };
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? { timestamp, invalid: false }
    : { timestamp: null, invalid: true };
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarizeAges(
  prices: readonly PriceCoverageAuditRow[],
  now: number,
): CapturedAtAgeSummary {
  const ages: number[] = [];
  let invalidTimestamps = 0;
  for (const price of prices) {
    if (readText(price, "verification_status", "prices") !== "verified") continue;
    const capturedAt = parseTimestamp(readText(price, "captured_at", "prices"));
    if (capturedAt.invalid || capturedAt.timestamp === null) {
      invalidTimestamps += 1;
      continue;
    }
    ages.push((now - capturedAt.timestamp) / HOUR_MS);
  }
  ages.sort((a, b) => a - b);
  if (!ages.length) {
    return {
      count: 0,
      invalidTimestamps,
      minHours: null,
      medianHours: null,
      p90Hours: null,
      maxHours: null,
    };
  }

  const middle = Math.floor(ages.length / 2);
  const median = ages.length % 2 === 1
    ? ages[middle]!
    : (ages[middle - 1]! + ages[middle]!) / 2;
  const p90Index = Math.max(0, Math.ceil(ages.length * 0.9) - 1);
  return {
    count: ages.length,
    invalidTimestamps,
    minHours: roundHours(ages[0]!),
    medianHours: roundHours(median),
    p90Hours: roundHours(ages[p90Index]!),
    maxHours: roundHours(ages[ages.length - 1]!),
  };
}

export function isCurrentVerifiedPrice(
  price: PriceCoverageAuditRow,
  now: number,
): { readonly current: boolean; readonly expired: boolean; readonly invalidWindow: boolean } {
  if (readText(price, "verification_status", "prices") !== "verified") {
    return { current: false, expired: false, invalidWindow: false };
  }
  const validFrom = parseTimestamp(readText(price, "valid_from", "prices"));
  const validUntil = parseTimestamp(readText(price, "valid_until", "prices"));
  const invalidWindow = validFrom.invalid || validUntil.invalid;
  const expired = !validUntil.invalid &&
    validUntil.timestamp !== null &&
    validUntil.timestamp < now;
  return {
    current: !invalidWindow &&
      (validFrom.timestamp === null || validFrom.timestamp <= now) &&
      (validUntil.timestamp === null || validUntil.timestamp >= now),
    expired,
    invalidWindow,
  };
}

function channelForStore(store: PriceCoverageAuditRow): string {
  const sourceType = sourceTypeOf(store, "stores");
  const externalId = readText(store, "external_id", "stores");
  const storeType = readText(store, "store_type", "stores") ?? "unknown";
  if (sourceType === "continente" && externalId === CONTINENTE_ONLINE_EXTERNAL_ID) {
    return "online";
  }
  if (sourceType === "auchan" && externalId === AUCHAN_REFERENCE_EXTERNAL_ID) {
    return "online_reference:2650-435";
  }
  if (storeType === "online_reference") {
    const postalCode = readText(store, "postal_code", "stores") ?? "sem-código-postal";
    return `${storeType}:${postalCode}`;
  }
  return storeType;
}

function channelPriceIdentity(row: PriceCoverageAuditRow): string | null {
  const sourceType = sourceTypeOf(row, "prices");
  const externalId = readText(row, "external_id", "prices");
  if (externalId) return JSON.stringify([sourceType, externalId]);
  const storeId = readText(row, "store_id", "prices");
  const productId = readText(row, "product_id", "prices");
  const capturedAt = readText(row, "captured_at", "prices");
  return storeId && productId && capturedAt
    ? JSON.stringify([sourceType, storeId, productId, capturedAt])
    : null;
}

function makeChannelSummary(
  channel: string,
  channelStores: readonly PriceCoverageAuditRow[],
  channelPrices: readonly PriceCoverageAuditRow[],
  activeProductIds: ReadonlySet<string>,
  allProductIds: ReadonlySet<string>,
  allStoreIds: ReadonlySet<string>,
  now: number,
): PriceCoverageChannelSummary {
  let verifiedPrices = 0;
  let validPrices = 0;
  let expiredVerifiedPrices = 0;
  let notCurrentVerifiedPrices = 0;
  let invalidValidityWindowPrices = 0;
  let missingProductRows = 0;
  let missingStoreRows = 0;
  const coveredProductIds = new Set<string>();

  for (const price of channelPrices) {
    const status = readText(price, "verification_status", "prices");
    const productId = readText(price, "product_id", "prices");
    const storeId = readText(price, "store_id", "prices");
    if (!productId || !allProductIds.has(productId)) missingProductRows += 1;
    if (!storeId || !allStoreIds.has(storeId)) missingStoreRows += 1;
    if (status !== "verified") continue;
    verifiedPrices += 1;
    const validity = isCurrentVerifiedPrice(price, now);
    if (validity.current) {
      validPrices += 1;
      if (productId && activeProductIds.has(productId)) {
        coveredProductIds.add(productId);
      }
    }
    if (validity.expired) expiredVerifiedPrices += 1;
    if (!validity.current) notCurrentVerifiedPrices += 1;
    if (validity.invalidWindow) invalidValidityWindowPrices += 1;
  }

  const activeProducts = activeProductIds.size;
  return {
    channel,
    stores: channelStores.length,
    activeStores: channelStores.filter((store) =>
      readBoolean(store, "active", "stores")
    ).length,
    prices: channelPrices.length,
    verifiedPrices,
    validPrices,
    expiredVerifiedPrices,
    notCurrentVerifiedPrices,
    invalidValidityWindowPrices,
    capturedAtAgeHours: summarizeAges(channelPrices, now),
    coverage: {
      coveredActiveProducts: coveredProductIds.size,
      activeProducts,
      percent: activeProducts
        ? roundHours((coveredProductIds.size / activeProducts) * 100)
        : null,
    },
    orphanPrices: {
      rows: channelPrices.filter((price) => {
        const productId = readText(price, "product_id", "prices");
        const storeId = readText(price, "store_id", "prices");
        return !productId || !allProductIds.has(productId) ||
          !storeId || !allStoreIds.has(storeId);
      }).length,
      missingProductRows,
      missingStoreRows,
    },
  };
}

function checkContinenteOnlineScope(
  stores: readonly PriceCoverageAuditRow[],
  prices: readonly PriceCoverageAuditRow[],
): PriceCoverageScopeCheck {
  const candidates = stores.filter((store) =>
    sourceTypeOf(store, "stores") === "continente" &&
    readText(store, "external_id", "stores") === CONTINENTE_ONLINE_EXTERNAL_ID
  );
  const compliant = candidates.filter((store) =>
    readText(store, "name", "stores") === "Continente Online" &&
    readBoolean(store, "active", "stores") &&
    readText(store, "store_type", "stores") === "online" &&
    ["district", "municipality", "parish", "latitude", "longitude"].every(
      (field) => store[field] === null,
    )
  );
  const expectedStoreId = candidates.length === 1 && compliant.length === 1
    ? readText(compliant[0]!, "id", "stores")
    : null;
  const scopedPrices = prices.filter((price) =>
    sourceTypeOf(price, "prices") === "continente"
  );
  const inScope = expectedStoreId
    ? scopedPrices.filter((price) =>
        readText(price, "store_id", "prices") === expectedStoreId
      ).length
    : 0;
  const outside = scopedPrices.length - inScope;
  const issues: string[] = [];
  if (candidates.length !== 1) issues.push("expected_store_missing_or_duplicated");
  if (candidates.length === 1 && compliant.length !== 1) {
    issues.push("expected_store_scope_invalid");
  }
  if (outside > 0) issues.push("prices_outside_continente_online");
  return {
    ok: issues.length === 0,
    expected: "source_type=continente, external_id=online, loja ativa Continente Online, store_type=online, sem localização física",
    candidateStores: candidates.length,
    compliantStores: compliant.length,
    pricesInExpectedChannel: inScope,
    pricesOutsideExpectedChannel: outside,
    additionalOutOfScopeStores: 0,
    issues,
  };
}

function checkAuchanAmadoraScope(
  stores: readonly PriceCoverageAuditRow[],
  prices: readonly PriceCoverageAuditRow[],
): PriceCoverageScopeCheck {
  const candidates = stores.filter((store) =>
    sourceTypeOf(store, "stores") === "auchan" &&
    readText(store, "external_id", "stores") === AUCHAN_REFERENCE_EXTERNAL_ID
  );
  const compliant = candidates.filter((store) =>
    readBoolean(store, "active", "stores") &&
    readText(store, "store_type", "stores") === "online_reference" &&
    readText(store, "postal_code", "stores") === AUCHAN_REFERENCE_POSTAL_CODE &&
    readText(store, "district", "stores") === "Lisboa" &&
    readText(store, "municipality", "stores") === "Amadora" &&
    readText(store, "chain_name", "stores") === "Auchan" &&
    readText(store, "name", "stores") !== null
  );
  const expectedStoreId = candidates.length === 1 && compliant.length === 1
    ? readText(compliant[0]!, "id", "stores")
    : null;
  const genericOnlineStores = stores.filter((store) =>
    sourceTypeOf(store, "stores") === "auchan" &&
    readText(store, "store_type", "stores") === "online"
  ).length;
  const otherReferenceStores = stores.filter((store) =>
    sourceTypeOf(store, "stores") === "auchan" &&
    readText(store, "store_type", "stores") === "online_reference" &&
    (
      readText(store, "postal_code", "stores") !== AUCHAN_REFERENCE_POSTAL_CODE ||
      readText(store, "external_id", "stores") !== AUCHAN_REFERENCE_EXTERNAL_ID
    )
  ).length;
  const scopedPrices = prices.filter((price) =>
    sourceTypeOf(price, "prices") === "auchan"
  );
  const inScope = expectedStoreId
    ? scopedPrices.filter((price) =>
        readText(price, "store_id", "prices") === expectedStoreId
      ).length
    : 0;
  const outside = scopedPrices.length - inScope;
  const issues: string[] = [];
  if (candidates.length !== 1) issues.push("expected_reference_missing_or_duplicated");
  if (candidates.length === 1 && compliant.length !== 1) {
    issues.push("expected_reference_scope_invalid");
  }
  if (genericOnlineStores > 0) issues.push("generic_auchan_online_store_present");
  if (otherReferenceStores > 0) issues.push("out_of_scope_auchan_reference_store_present");
  if (outside > 0) issues.push("prices_outside_auchan_amadora_reference");
  return {
    ok: issues.length === 0,
    expected: "source_type=auchan, external_id=reference:2650-435, store_type=online_reference, 2650-435, Lisboa/Amadora, chain_name=Auchan",
    candidateStores: candidates.length,
    compliantStores: compliant.length,
    pricesInExpectedChannel: inScope,
    pricesOutsideExpectedChannel: outside,
    additionalOutOfScopeStores: genericOnlineStores + otherReferenceStores,
    issues,
  };
}

export function buildPriceCoverageAuditReport(
  input: PriceCoverageAuditInput,
  asOf: Date = new Date(),
): PriceCoverageAuditReport {
  const now = asOf.getTime();
  if (!Number.isFinite(now)) throw new Error("The audit as-of time is invalid.");

  const allProductIds = new Set(
    input.products.map((product) => requiredText(product, "id", "products")),
  );
  const allStoreIds = new Set(
    input.stores.map((store) => requiredText(store, "id", "stores")),
  );
  const storesById = new Map(
    input.stores.map((store) => [
      requiredText(store, "id", "stores"),
      store,
    ] as const),
  );
  const sourceTypes = new Map<string, string | null>();
  for (const [table, rows] of [
    ["products", input.products],
    ["stores", input.stores],
    ["external_product_mappings", input.mappings],
    ["prices", input.prices],
  ] as const) {
    for (const row of rows) {
      const sourceType = sourceTypeOf(row, table);
      sourceTypes.set(sourceKey(sourceType), sourceType);
    }
  }

  const storesBySourceAndChannel = new Map<string, Map<string, Map<string, PriceCoverageAuditRow>>>();
  const ensureSourceChannel = (
    sourceType: string | null,
    channel: string,
  ): Map<string, PriceCoverageAuditRow> => {
    const key = sourceKey(sourceType);
    let channels = storesBySourceAndChannel.get(key);
    if (!channels) {
      channels = new Map();
      storesBySourceAndChannel.set(key, channels);
    }
    let stores = channels.get(channel);
    if (!stores) {
      stores = new Map();
      channels.set(channel, stores);
    }
    return stores;
  };
  const addStoreChannel = (
    sourceType: string | null,
    channel: string,
    store: PriceCoverageAuditRow,
  ) => {
    const stores = ensureSourceChannel(sourceType, channel);
    stores.set(requiredText(store, "id", "stores"), store);
  };

  for (const store of input.stores) {
    addStoreChannel(
      sourceTypeOf(store, "stores"),
      channelForStore(store),
      store,
    );
  }
  for (const price of input.prices) {
    const storeId = readText(price, "store_id", "prices");
    const store = storeId ? storesById.get(storeId) : undefined;
    if (store) {
      addStoreChannel(
        sourceTypeOf(price, "prices"),
        channelForStore(store),
        store,
      );
    } else {
      ensureSourceChannel(sourceTypeOf(price, "prices"), "loja em falta");
    }
  }

  const sources: PriceCoverageSourceSummary[] = [];
  for (const sourceType of [...sourceTypes.values()].sort((a, b) =>
    (a ?? "").localeCompare(b ?? "")
  )) {
    const key = sourceKey(sourceType);
    const sourceProducts = input.products.filter((row) =>
      sourceTypeOf(row, "products") === sourceType
    );
    const sourceMappings = input.mappings.filter((row) =>
      sourceTypeOf(row, "external_product_mappings") === sourceType
    );
    const sourceStores = input.stores.filter((row) =>
      sourceTypeOf(row, "stores") === sourceType
    );
    const sourcePrices = input.prices.filter((row) =>
      sourceTypeOf(row, "prices") === sourceType
    );
    const activeProductIds = new Set(
      sourceProducts.filter((product) => readBoolean(product, "active", "products"))
        .map((product) => requiredText(product, "id", "products")),
    );
    const channels = storesBySourceAndChannel.get(key) ?? new Map();
    if (channels.size === 0) channels.set("sem canal", new Map());

    const channelSummaries = [...channels.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "pt-PT"))
      .map(([channel, storeMap]) => {
        const channelStores = [...storeMap.values()];
        const channelPrices = sourcePrices.filter((price) => {
          const storeId = readText(price, "store_id", "prices");
          const store = storeId ? storesById.get(storeId) : undefined;
          return (store ? channelForStore(store) : "loja em falta") === channel;
        });
        return makeChannelSummary(
          channel,
          channelStores,
          channelPrices,
          activeProductIds,
          allProductIds,
          allStoreIds,
          now,
        );
      });
    const orphanMappings = sourceMappings.filter((mapping) => {
      const productId = readText(mapping, "product_id", "external_product_mappings");
      return !productId || !allProductIds.has(productId);
    }).length;

    sources.push({
      sourceType,
      products: {
        total: sourceProducts.length,
        active: activeProductIds.size,
        duplicateIdentities: duplicateIdentitySummary(
          sourceProducts,
          (row) => identity(row, "products", "source_type", "external_id"),
        ),
      },
      mappings: {
        total: sourceMappings.length,
        duplicateIdentities: duplicateIdentitySummary(
          sourceMappings,
          (row) => identity(
            row,
            "external_product_mappings",
            "source_type",
            "external_product_id",
          ),
        ),
        orphanRows: orphanMappings,
      },
      stores: {
        total: sourceStores.length,
        active: sourceStores.filter((store) =>
          readBoolean(store, "active", "stores")
        ).length,
        duplicateIdentities: duplicateIdentitySummary(
          sourceStores,
          (row) => identity(row, "stores", "source_type", "external_id"),
        ),
      },
      prices: {
        total: sourcePrices.length,
        duplicateIdentities: duplicateIdentitySummary(
          sourcePrices,
          channelPriceIdentity,
        ),
      },
      channels: channelSummaries,
    });
  }

  return {
    generatedAt: asOf.toISOString(),
    asOf: asOf.toISOString(),
    readOnly: true,
    databaseWrites: 0,
    rpcCalls: 0,
    tablesRead: ["products", "stores", "external_product_mappings", "prices"],
    sources,
    expectedScopes: {
      continenteOnline: checkContinenteOnlineScope(input.stores, input.prices),
      auchanAmadoraReference: checkAuchanAmadoraScope(input.stores, input.prices),
    },
  };
}