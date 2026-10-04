const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const WINDOW_MS = 36 * 60 * 60 * 1000;

function cents(value) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const result = Math.round(amount * 100);
  return Number.isSafeInteger(result) ? result : null;
}

function duplicateRows(rows, identity) {
  const seen = new Set();
  let duplicates = 0;
  for (const row of rows) {
    const key = identity(row);
    if (key === null) continue;
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

function identity(sourceType, externalId) {
  return typeof sourceType === "string" && typeof externalId === "string" && externalId
    ? JSON.stringify([sourceType, externalId])
    : null;
}

/** Validate a read-only snapshot without assuming how many products a batch contains. */
export function verifyContinenteSnapshot({
  sourceProducts,
  mappedProducts,
  mappings,
  prices,
  onlineStores,
  history,
}) {
  const errors = [];
  const store = onlineStores.length === 1 ? onlineStores[0] : null;
  const allProducts = new Map();
  for (const product of [...sourceProducts, ...mappedProducts]) {
    if (typeof product.id === "string") allProducts.set(product.id, product);
  }

  const mappingBySku = new Map();
  for (const mapping of mappings) {
    if (typeof mapping.external_product_id === "string") {
      mappingBySku.set(mapping.external_product_id, mapping);
    }
  }

  const pricesBySku = new Map();
  for (const price of prices) {
    const externalId = typeof price.external_id === "string" ? price.external_id : "";
    if (externalId.startsWith("online:")) {
      const sku = externalId.slice("online:".length);
      pricesBySku.set(sku, [...(pricesBySku.get(sku) ?? []), price]);
    }
  }

  const productDuplicates = duplicateRows(
    sourceProducts,
    (row) => row.external_id == null ? null : identity(row.source_type, row.external_id),
  );
  const mappingDuplicates = duplicateRows(
    mappings,
    (row) => identity(row.source_type, row.external_product_id),
  );
  const priceDuplicates = duplicateRows(
    prices,
    (row) => row.external_id == null ? null : identity(row.source_type, row.external_id),
  );
  const historyDuplicates = duplicateRows(
    history,
    (row) =>
      typeof row.product_id === "string" &&
      typeof row.store_id === "string" &&
      typeof row.captured_at === "string" &&
      cents(row.price) !== null
        ? JSON.stringify([row.product_id, row.store_id, row.captured_at, cents(row.price)])
        : null,
  );

  if (!sourceProducts.length) errors.push("No source-native Continente products were found.");
  if (!mappings.length) errors.push("No Continente product mappings were found.");
  if (!prices.length) errors.push("No Continente prices were found.");
  if (!history.length) errors.push("No price history was found for mapped products at the online store.");
  if (
    !store ||
    store.name !== "Continente Online" ||
    store.active !== true ||
    store.store_type !== "online" ||
    store.source_type !== "continente" ||
    store.external_id !== "online" ||
    ["district", "municipality", "parish", "latitude", "longitude", "address"]
      .some((field) => store[field] !== null)
  ) {
    errors.push("The Continente Online store identity or online-only location is invalid.");
  }

  const allowedMethods = new Set([
    "source_native", "barcode_exact", "name_brand_exact_unique", "manual_verified",
  ]);
  const mappingsValid = mappings.every((mapping) => {
    const product = allProducts.get(mapping.product_id);
    const confidence = Number(mapping.confidence);
    const valid =
      mapping.source_type === "continente" &&
      typeof mapping.external_product_id === "string" &&
      mapping.external_product_id.length > 0 &&
      UUID_PATTERN.test(mapping.product_id ?? "") &&
      mapping.verified === true &&
      allowedMethods.has(mapping.match_method) &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1 &&
      product?.active === true;
    if (!valid) return false;
    if (mapping.match_method === "source_native") {
      return product.source_type === "continente" &&
        product.external_id === mapping.external_product_id;
    }
    return true;
  });
  if (!mappingsValid) errors.push("One or more mappings are unverified or do not resolve to the expected product.");

  const pricesValid = Boolean(store) && prices.every((price) => {
    const sku = typeof price.external_id === "string" && price.external_id.startsWith("online:")
      ? price.external_id.slice("online:".length)
      : "";
    const mapping = mappingBySku.get(sku);
    const amount = cents(price.price);
    const capturedAt = Date.parse(price.captured_at);
    const validFrom = Date.parse(price.valid_from);
    const validUntil = Date.parse(price.valid_until);
    return price.source_type === "continente" &&
      sku.length > 0 &&
      mapping?.product_id === price.product_id &&
      price.store_id === store.id &&
      amount !== null &&
      price.currency === "EUR" &&
      price.verification_status === "verified" &&
      Number.isFinite(capturedAt) &&
      validFrom === capturedAt &&
      Number.isFinite(validUntil) &&
      validUntil > capturedAt &&
      validUntil - capturedAt === WINDOW_MS;
  });
  if (!pricesValid) errors.push("One or more prices fail the source, store, amount, currency, verification, or 36-hour checks.");

  const mappingsHavePrices = mappings.every((mapping) =>
    (pricesBySku.get(mapping.external_product_id) ?? []).some((price) =>
      price.product_id === mapping.product_id,
    ),
  );
  if (!mappingsHavePrices) errors.push("One or more mappings have no corresponding current Continente price.");

  const historyHasEveryCurrentPrice = Boolean(store) && prices.every((price) => {
    const amount = cents(price.price);
    return history.some((entry) =>
      entry.product_id === price.product_id &&
      entry.store_id === store.id &&
      cents(entry.price) === amount,
    );
  });
  if (!historyHasEveryCurrentPrice) errors.push("One or more current prices have no matching historical value.");

  const duplicates = productDuplicates + mappingDuplicates + priceDuplicates + historyDuplicates;
  if (duplicates !== 0) errors.push("Duplicate source identities or identical history entries were found.");

  return {
    ok: errors.length === 0,
    counts: {
      sourceNativeProducts: sourceProducts.length,
      mappedProducts: new Set(mappings.map((mapping) => mapping.product_id)).size,
      mappings: mappings.length,
      prices: prices.length,
      historyEntriesForMappedOnlineProducts: history.length,
      onlineStores: onlineStores.length,
    },
    duplicates: {
      products: productDuplicates,
      mappings: mappingDuplicates,
      prices: priceDuplicates,
      history: historyDuplicates,
      total: duplicates,
    },
    checks: {
      storeIsOnlineAndUnlocated: Boolean(store) &&
        store.name === "Continente Online" &&
        store.active === true &&
        store.store_type === "online" &&
        ["district", "municipality", "parish", "latitude", "longitude", "address"]
          .every((field) => store[field] === null),
      mappingsResolveToProducts: mappingsValid,
      everyMappingHasAPrice: mappingsHavePrices,
      allPricesVerifiedInEurWith36HourValidity: pricesValid,
      everyCurrentPriceHasHistory: historyHasEveryCurrentPrice,
      noDuplicates: duplicates === 0,
    },
    errors,
  };
}