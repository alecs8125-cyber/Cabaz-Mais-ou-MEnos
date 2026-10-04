import type { ContinenteProductObservation } from "./continente-types.js";

type JsonRecord = Record<string, unknown>;

export interface ContinenteParseResult {
  readonly observation: ContinenteProductObservation | null;
  readonly invalidReason: string | null;
  readonly productSchemaFound: boolean;
}

const GTIN_KEYS = new Set(["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "ean", "barcode"]);
const REGULAR_PRICE_KEYS = new Set([
  "regularprice",
  "listprice",
  "pricewithoutdiscount",
  "originalprice",
  "pricebeforediscount",
  "strikethroughprice",
]);
const PACKAGE_PROPERTY_PATTERN =
  /(?:package|packaging|net.?content|quantity|format|weight|volume|size|quantidade|embalagem|formato|peso|conte[uú]do)/i;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function readSchemaProducts(value: unknown, products: JsonRecord[] = []): JsonRecord[] {
  if (Array.isArray(value)) {
    for (const item of value) readSchemaProducts(item, products);
    return products;
  }
  if (!isRecord(value)) return products;

  const type = value["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((entry) => entry === "Product")) products.push(value);
  for (const child of Object.values(value)) readSchemaProducts(child, products);
  return products;
}

function parseJsonLd(html: string): JsonRecord[] {
  const products: JsonRecord[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype\s*=\s*["']?application\/ld\+json/i.test(match[1] ?? "")) continue;
    try {
      readSchemaProducts(JSON.parse(decodeHtmlEntities(match[2] ?? "")), products);
    } catch {
      // Other valid JSON-LD blocks may still contain the product record.
    }
  }
  return products;
}

function readEmbeddedProducts(value: unknown, products: JsonRecord[] = []): JsonRecord[] {
  if (Array.isArray(value)) {
    for (const item of value) readEmbeddedProducts(item, products);
    return products;
  }
  if (!isRecord(value)) return products;
  const hasProductFields =
    typeof value.name === "string" &&
    (
      value.sku !== undefined ||
      value.mpn !== undefined ||
      value.gtin !== undefined ||
      value.gtin8 !== undefined ||
      value.gtin12 !== undefined ||
      value.gtin13 !== undefined ||
      value.gtin14 !== undefined ||
      value.ean !== undefined ||
      value.offers !== undefined
    );
  if (hasProductFields) products.push(value);
  for (const child of Object.values(value)) readEmbeddedProducts(child, products);
  return products;
}

function extractAssignedJson(script: string, startAt: number): unknown | null {
  const objectStart = script.indexOf("{", startAt);
  if (objectStart < 0) return null;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = objectStart; index < script.length; index += 1) {
    const character = script[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(script.slice(objectStart, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseEmbeddedScriptProducts(html: string): JsonRecord[] {
  const products: JsonRecord[] = [];
  const assignment =
    /(?:window\s*\.\s*)?(?:__INITIAL_STATE__|__NEXT_DATA__|productData|productDetails|pdpData|digitalData|product)\s*=\s*/gi;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? "";
    const content = match[2] ?? "";
    if (/\btype\s*=\s*["']?application\/json/i.test(attributes)) {
      try {
        readEmbeddedProducts(JSON.parse(decodeHtmlEntities(content)), products);
      } catch {
        // Ignore malformed or unrelated public JSON blocks.
      }
    }
    assignment.lastIndex = 0;
    for (const assignmentMatch of content.matchAll(assignment)) {
      const start = (assignmentMatch.index ?? 0) + assignmentMatch[0].length;
      const value = extractAssignedJson(content, start);
      if (value !== null) readEmbeddedProducts(value, products);
    }
  }
  return products;
}

function readMeta(html: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of (match[1] ?? "").matchAll(
      /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    )) {
      attributes.set(
        (attribute[1] ?? "").toLowerCase(),
        decodeHtmlEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""),
      );
    }
    const key = attributes.get("property") ?? attributes.get("name") ?? "";
    const content = attributes.get("content");
    if (key && content) result.set(key.toLowerCase(), content.trim());
  }
  return result;
}

function positiveId(value: unknown): string | null {
  const text = asText(value);
  return text && /^\d+$/.test(text) && BigInt(text) > 0n ? text : null;
}

function validGtin(value: unknown): string | null {
  const text = asText(value);
  if (!text || !/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(text)) return null;
  const digits = [...text].map(Number);
  const checkDigit = digits.pop();
  let sum = 0;
  let weight = 3;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += digits[index]! * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === checkDigit ? text : null;
}

function readProductBarcode(product: JsonRecord): string | null {
  // Never inherit GTIN from nested recommendations/variants of a different SKU.
  const barcodes = new Set<string>();
  const add = (value: unknown) => {
    for (const candidate of Array.isArray(value) ? value : [value]) {
      const valid = validGtin(candidate);
      if (valid) barcodes.add(valid);
    }
  };
  for (const [key, value] of Object.entries(product)) {
    if (GTIN_KEYS.has(key.toLowerCase())) add(value);
  }
  const properties = Array.isArray(product.additionalProperty) ? product.additionalProperty : [];
  for (const property of properties) {
    if (isRecord(property) && typeof property.name === "string" &&
        GTIN_KEYS.has(property.name.toLowerCase().trim())) add(property.value);
  }
  return barcodes.size === 1 ? [...barcodes][0]! : null;
}

function readBrand(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const brand = readBrand(candidate);
      if (brand) return brand;
    }
    return null;
  }
  if (isRecord(value)) return asText(value.name);
  return null;
}

function readImage(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "string") return candidate.trim() || null;
  if (isRecord(candidate)) return asText(candidate.url) ?? asText(candidate.contentUrl);
  return null;
}

function readOffers(product: JsonRecord): JsonRecord[] {
  const offers = product.offers;
  const candidates = Array.isArray(offers) ? offers : [offers];
  return candidates.filter(isRecord);
}

function decimalPrice(value: unknown): string | null {
  const text = asText(value);
  if (!text || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0 ? text : null;
}

function offerPrice(offers: readonly JsonRecord[]): {
  readonly price: string | null;
  readonly currency: "EUR" | null;
} {
  for (const offer of offers) {
    const price = decimalPrice(offer.price);
    const currency = asText(offer.priceCurrency)?.toUpperCase();
    if (price && currency === "EUR") return { price, currency: "EUR" };
  }
  return { price: null, currency: null };
}

function readRegularPrice(
  product: JsonRecord,
  offers: readonly JsonRecord[],
  currentPrice: string | null,
): string | null {
  const candidates: unknown[] = [];
  for (const record of [product, ...offers]) {
    for (const [key, value] of Object.entries(record)) {
      if (REGULAR_PRICE_KEYS.has(key.toLowerCase())) candidates.push(value);
    }
    const specifications = record.priceSpecification;
    for (const specification of Array.isArray(specifications)
      ? specifications
      : [specifications]) {
      if (!isRecord(specification)) continue;
      const priceType = asText(specification.priceType)?.toLowerCase() ?? "";
      if (
        priceType.includes("list") ||
        priceType.includes("regular") ||
        priceType.includes("strikethrough") ||
        priceType.includes("reference")
      ) {
        candidates.push(specification.price);
      }
    }
  }
  for (const candidate of candidates) {
    const price = decimalPrice(candidate);
    if (price && currentPrice && Number(price) > Number(currentPrice)) return price;
  }
  return null;
}

function packageFromText(value: string | null): {
  readonly quantity: number;
  readonly unit: string;
} | null {
  if (!value) return null;
  const text = value.trim().toLowerCase().replace(",", ".");
  const multipack = /(\d+(?:\.\d+)?)\s*(?:x|×)\s*(\d+(?:\.\d+)?)\s*(kg|g|mg|l|ml|cl|unidades?|un|unid)\b/i.exec(text);
  if (multipack) {
    const total = Number(multipack[1]) * Number(multipack[2]);
    const unit = normalizePackageUnit(multipack[3]);
    return Number.isFinite(total) && unit ? { quantity: total, unit } : null;
  }
  const match = /(\d+(?:\.\d+)?)\s*(kg|g|mg|l|ml|cl|unidades?|un|unid)\b/i.exec(text);
  if (!match) return null;
  const quantity = Number(match[1]);
  const unit = normalizePackageUnit(match[2]);
  return Number.isFinite(quantity) && unit ? { quantity, unit } : null;
}

function normalizePackageUnit(value: string | null): string | null {
  if (!value) return null;
  const unit = value.toLowerCase();
  if (unit === "un" || unit.startsWith("unid")) return "un";
  if (unit === "kg") return "kg";
  if (unit === "g") return "g";
  if (unit === "mg") return "mg";
  if (unit === "l") return "l";
  if (unit === "ml") return "ml";
  if (unit === "cl") return "cl";
  return null;
}

function readQuantityValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return asText(value);
  if (!isRecord(value)) return null;
  const amount = asText(value.value) ?? asText(value.name);
  const unitCode = asText(value.unitCode)?.toUpperCase();
  const unit = unitCode === "KGM" ? "kg"
    : unitCode === "GRM" ? "g"
    : unitCode === "MGM" ? "mg"
    : unitCode === "LTR" ? "l"
    : unitCode === "MLT" ? "ml"
    : unitCode === "CLT" ? "cl"
    : unitCode === "C62" ? "un"
    : asText(value.unitText);
  return amount && unit ? `${amount} ${unit}` : amount;
}

function readPackage(
  product: JsonRecord,
  name: string | null,
): { readonly quantity: number | null; readonly unit: string | null } {
  const possibleValues: string[] = [];
  for (const key of ["weight", "size", "volume", "netContent", "packageQuantity"]) {
    const value = readQuantityValue(product[key]);
    if (value) possibleValues.push(value);
  }
  const properties = product.additionalProperty;
  for (const property of Array.isArray(properties) ? properties : [properties]) {
    if (!isRecord(property)) continue;
    if (!PACKAGE_PROPERTY_PATTERN.test(asText(property.name) ?? "")) continue;
    const value = readQuantityValue(property.value);
    if (value) possibleValues.push(value);
  }
  if (name) possibleValues.push(name);

  for (const value of possibleValues) {
    const parsed = packageFromText(value);
    if (parsed) return { quantity: parsed.quantity, unit: parsed.unit };
  }
  return { quantity: null, unit: null };
}

function readPricePerUnit(offers: readonly JsonRecord[]): string | null {
  for (const offer of offers) {
    const specifications = offer.priceSpecification;
    for (const specification of Array.isArray(specifications)
      ? specifications
      : [specifications]) {
      if (!isRecord(specification)) continue;
      const quantity = isRecord(specification.referenceQuantity)
        ? specification.referenceQuantity
        : null;
      if (!quantity) continue;
      const value = asText(quantity.value);
      const unitCode = asText(quantity.unitCode)?.toUpperCase();
      const unit = unitCode === "KGM" ? "kg"
        : unitCode === "LTR" ? "l"
        : unitCode === "MLT" ? "ml"
        : unitCode === "C62" ? "un"
        : asText(quantity.unitText);
      const price = decimalPrice(specification.price);
      if (value && unit && price) return `${price} EUR/${unit}`;
    }
  }
  return null;
}

function readPromotion(
  product: JsonRecord,
  offers: readonly JsonRecord[],
  regularPrice: string | null,
): string | null {
  if (regularPrice) return "discounted";
  for (const record of [product, ...offers]) {
    if (record.priceIsDiscounted === true || record.isDiscounted === true) {
      return "discounted";
    }
    for (const key of ["promotion", "promo", "discountDescription"]) {
      const value = asText(record[key]);
      if (value) return value;
    }
  }
  return null;
}

function urlProductId(url: URL): string | null {
  return /-(\d+)\.html$/i.exec(url.pathname)?.[1] ?? null;
}

function samePositiveId(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left === right;
}

function fallbackMetaObservation(
  html: string,
  meta: ReadonlyMap<string, string>,
  url: URL,
  capturedAt: string,
): ContinenteProductObservation | null {
  const name = meta.get("og:title")?.replace(/\s*\|\s*continente online.*$/i, "").trim() ?? null;
  const price = decimalPrice(meta.get("product:price:amount"));
  const currency =
    meta.get("product:price:currency")?.toUpperCase() === "EUR" ? "EUR" : null;
  if (!name && !price) return null;

  const urlId = urlProductId(url);
  const sku = positiveId(meta.get("product:retailer_item_id")) ??
    positiveId(meta.get("product:product_id"));
  const mpn = positiveId(meta.get("product:mpn"));
  const externalProductId =
    sku && mpn && samePositiveId(sku, mpn) && samePositiveId(sku, urlId) ? sku : null;
  return {
    sourceType: "continente",
    externalProductId,
    externalProductIdReason: externalProductId ? null : "id_not_confirmed_in_product_schema",
    sourceReference: url.toString(),
    name,
    brand: meta.get("product:brand") ?? null,
    barcode: null,
    sku,
    mpn,
    urlProductId: urlId,
    price,
    currency: price && currency ? "EUR" : null,
    promotion: null,
    regularPrice: null,
    packageQuantity: null,
    packageUnit: null,
    availability: meta.get("product:availability") ?? null,
    image: meta.get("og:image") ?? null,
    pricePerUnit: null,
    capturedAt,
    priceScope: "online",
  };
}

export function parseContinenteProductHtml(
  html: string,
  inputUrl: string,
  capturedAt: Date,
): ContinenteParseResult {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return { observation: null, invalidReason: "product_url_invalid", productSchemaFound: false };
  }

  const meta = readMeta(html);
  const products = parseJsonLd(html);
  const embeddedProducts = parseEmbeddedScriptProducts(html);
  const urlId = urlProductId(url);
  const schemaProduct =
    products.find((candidate) =>
      positiveId(candidate.sku) === urlId ||
      positiveId(candidate.mpn) === urlId
    ) ?? products[0];
  const embeddedProduct =
    embeddedProducts.find((candidate) =>
      positiveId(candidate.sku) === urlId ||
      positiveId(candidate.mpn) === urlId
    ) ??
    (embeddedProducts.length === 1 ? embeddedProducts[0] : undefined);
  const product = schemaProduct ?? embeddedProduct;
  if (!product) {
    const fallback = fallbackMetaObservation(html, meta, url, capturedAt.toISOString());
    return fallback
      ? { observation: fallback, invalidReason: null, productSchemaFound: false }
      : { observation: null, invalidReason: "product_schema_missing", productSchemaFound: false };
  }

  const name = asText(product.name) ?? meta.get("og:title") ?? null;
  const brand = readBrand(product.brand) ?? meta.get("product:brand") ?? null;
  const sku = positiveId(product.sku) ?? positiveId(meta.get("product:retailer_item_id"));
  const mpn = positiveId(product.mpn) ?? positiveId(meta.get("product:mpn"));
  const offers = readOffers(product);
  const extractedPrice = offerPrice(offers);
  const productPrice = decimalPrice(product.price);
  const productCurrency = asText(product.priceCurrency)?.toUpperCase();
  const price = extractedPrice.price ??
    (productCurrency === "EUR" ? productPrice : null) ??
    decimalPrice(meta.get("product:price:amount"));
  const currency = extractedPrice.currency ??
    (productPrice && productCurrency === "EUR" ? "EUR" : null) ??
    (meta.get("product:price:currency")?.toUpperCase() === "EUR" ? "EUR" : null);
  const regularPrice = readRegularPrice(product, offers, price);
  const externalProductId =
    sku && mpn && samePositiveId(sku, mpn) && samePositiveId(sku, urlId) ? sku : null;
  const externalProductIdReason = externalProductId
    ? null
    : !sku || !mpn || !urlId
      ? "sku_mpn_or_url_id_missing"
      : sku !== mpn
        ? "sku_mpn_mismatch"
        : "url_id_mismatch";
  const packageInfo = readPackage(product, name);
  const availability =
    asText(offers[0]?.availability) ?? meta.get("product:availability") ?? null;
  const description = offers.map((offer) => asText(offer.description)).find(Boolean) ?? null;
  const embeddedBarcodes = new Set(embeddedProducts
    .filter((candidate) => positiveId(candidate.sku) === urlId && positiveId(candidate.mpn) === urlId)
    .map(readProductBarcode)
    .filter((value): value is string => value !== null));
  const schemaHasBarcodeField = Object.entries(product).some(
    ([key, value]) => GTIN_KEYS.has(key.toLowerCase()) && value !== null && value !== undefined,
  );
  const barcode = readProductBarcode(product) ??
    (!schemaHasBarcodeField && embeddedBarcodes.size === 1 ? [...embeddedBarcodes][0]! : null);

  const observation: ContinenteProductObservation = {
    sourceType: "continente",
    externalProductId,
    externalProductIdReason,
    sourceReference: url.toString(),
    name,
    brand,
    barcode,
    sku,
    mpn,
    urlProductId: urlId,
    price,
    currency: price && currency === "EUR" ? "EUR" : null,
    promotion: readPromotion(product, offers, regularPrice) ?? description,
    regularPrice,
    packageQuantity: packageInfo.quantity,
    packageUnit: packageInfo.unit,
    availability,
    image: readImage(product.image) ?? meta.get("og:image") ?? null,
    pricePerUnit: readPricePerUnit(offers),
    capturedAt: capturedAt.toISOString(),
    priceScope: "online",
  };

  return {
    observation,
    invalidReason: null,
    productSchemaFound: schemaProduct !== undefined,
  };
}

export function isContinentePriceValid(
  observation: ContinenteProductObservation,
): boolean {
  return observation.price !== null && observation.currency === "EUR";
}