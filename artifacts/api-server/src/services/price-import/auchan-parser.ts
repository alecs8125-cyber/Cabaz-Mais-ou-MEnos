import type {
  AuchanParseResult,
  AuchanProductObservation,
} from "./auchan-types.js";

type JsonRecord = Record<string, unknown>;

const GTIN_KEYS = new Set(["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "ean", "barcode"]);
const REGULAR_PRICE_KEYS = new Set([
  "listprice",
  "regularprice",
  "pricewithoutdiscount",
  "originalprice",
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
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&ccedil;/gi, "ç")
    .replace(/&atilde;/gi, "ã")
    .replace(/&otilde;/gi, "õ")
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ecirc;/gi, "ê")
    .replace(/&ocirc;/gi, "ô")
    .replace(/&acirc;/gi, "â")
    .replace(/&agrave;/gi, "à")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const value = Number(code);
      return value <= 0x10ffff ? String.fromCodePoint(value) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => {
      const value = Number.parseInt(code, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : "";
    });
}

function readProducts(value: unknown, result: JsonRecord[] = []): JsonRecord[] {
  if (Array.isArray(value)) {
    for (const entry of value) readProducts(entry, result);
    return result;
  }
  if (!isRecord(value)) return result;
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.includes("Product")) result.push(value);
  for (const child of Object.values(value)) readProducts(child, result);
  return result;
}

function readJsonLdProducts(html: string): JsonRecord[] {
  const products: JsonRecord[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype\s*=\s*["']?application\/ld\+json/i.test(match[1] ?? "")) continue;
    try {
      readProducts(JSON.parse(decodeHtmlEntities(match[2] ?? "")), products);
    } catch {
      // Ignore unrelated or malformed JSON-LD blocks.
    }
  }
  return products;
}

function positiveId(value: unknown): string | null {
  const text = asText(value);
  return text && /^\d+$/.test(text) && BigInt(text) > 0n ? text : null;
}

function urlProductId(inputUrl: string): string | null {
  try {
    return /\/([1-9]\d*)\.html$/i.exec(new URL(inputUrl).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
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

function readBarcode(product: JsonRecord): string | null {
  const candidates = new Set<string>();
  for (const [key, value] of Object.entries(product)) {
    if (!GTIN_KEYS.has(key.toLowerCase())) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      const gtin = validGtin(entry);
      if (gtin) candidates.add(gtin);
    }
  }
  const properties = Array.isArray(product.additionalProperty)
    ? product.additionalProperty
    : [];
  for (const property of properties) {
    if (!isRecord(property) || typeof property.name !== "string") continue;
    if (!GTIN_KEYS.has(property.name.trim().toLowerCase())) continue;
    const gtin = validGtin(property.value);
    if (gtin) candidates.add(gtin);
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}

function readBrand(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const brand = readBrand(candidate);
      if (brand) return brand;
    }
  }
  if (isRecord(value)) return asText(value.name);
  return null;
}

function readOffers(product: JsonRecord): JsonRecord[] {
  const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
  return offers.filter(isRecord);
}

function decimalPrice(value: unknown): string | null {
  const text = asText(value);
  if (!text || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0 ? text : null;
}

function readPrice(offers: readonly JsonRecord[]): {
  readonly price: string | null;
  readonly currency: "EUR" | null;
} {
  for (const offer of offers) {
    const price = decimalPrice(offer.price);
    if (price && asText(offer.priceCurrency)?.toUpperCase() === "EUR") {
      return { price, currency: "EUR" };
    }
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
    const specifications = Array.isArray(record.priceSpecification)
      ? record.priceSpecification
      : [record.priceSpecification];
    for (const specification of specifications) {
      if (!isRecord(specification)) continue;
      const type = asText(specification.priceType)?.toLowerCase() ?? "";
      if (/(?:list|regular|strikethrough|reference)/.test(type)) {
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

function normalizePackageUnit(value: string): string | null {
  const unit = value.toLowerCase();
  if (unit === "un" || unit.startsWith("unid")) return "un";
  if (["kg", "g", "mg", "l", "ml", "cl"].includes(unit)) return unit;
  return null;
}

function packageFromText(value: string): {
  readonly quantity: number;
  readonly unit: string;
} | null {
  const text = value.trim().toLowerCase().replace(",", ".");
  const multipack =
    /(\d+(?:\.\d+)?)\s*(?:x|×)\s*(\d+(?:\.\d+)?)\s*(kg|g|mg|l|ml|cl|unidades?|un|unid)\b/i.exec(text);
  if (multipack) {
    const quantity = Number(multipack[1]) * Number(multipack[2]);
    const unit = normalizePackageUnit(multipack[3]!);
    return Number.isFinite(quantity) && unit ? { quantity, unit } : null;
  }
  const match =
    /(\d+(?:\.\d+)?)\s*(kg|g|mg|l|ml|cl|unidades?|un|unid)\b/i.exec(text);
  if (!match) return null;
  const quantity = Number(match[1]);
  const unit = normalizePackageUnit(match[2]!);
  return Number.isFinite(quantity) && unit ? { quantity, unit } : null;
}

function readPackage(
  product: JsonRecord,
  name: string,
): { readonly quantity: number | null; readonly unit: string | null } {
  const values: string[] = [];
  for (const key of ["weight", "size", "volume", "netContent", "packageQuantity"]) {
    const value = product[key];
    if (typeof value === "string" || typeof value === "number") values.push(String(value));
    else if (isRecord(value)) {
      const amount = asText(value.value) ?? asText(value.name);
      const code = asText(value.unitCode)?.toUpperCase();
      const unit = code === "KGM" ? "kg"
        : code === "GRM" ? "g"
        : code === "MGM" ? "mg"
        : code === "LTR" ? "l"
        : code === "MLT" ? "ml"
        : code === "CLT" ? "cl"
        : code === "C62" ? "un"
        : asText(value.unitText);
      if (amount && unit) values.push(`${amount} ${unit}`);
    }
  }
  const properties = Array.isArray(product.additionalProperty)
    ? product.additionalProperty
    : [];
  for (const property of properties) {
    if (!isRecord(property) || !PACKAGE_PROPERTY_PATTERN.test(asText(property.name) ?? "")) {
      continue;
    }
    const value = property.value;
    if (typeof value === "string" || typeof value === "number") values.push(String(value));
  }
  values.push(name);
  for (const value of values) {
    const parsed = packageFromText(value);
    if (parsed) return { quantity: parsed.quantity, unit: parsed.unit };
  }
  return { quantity: null, unit: null };
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

function hasReferencePriceEvidence(html: string): boolean {
  const text = decodeHtmlEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
  return text.includes("2650-435") &&
    /pre[cç]os? apresentados.{0,300}refer[eê]ncia/i.test(text) &&
    /loja que serve|c[oó]digo postal/i.test(text);
}

export function parseAuchanProductHtml(
  html: string,
  inputUrl: string,
  capturedAt: Date,
): AuchanParseResult {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return { observation: null, invalidReason: "product_url_invalid", productSchemaFound: false };
  }

  const urlId = urlProductId(url.toString());
  const products = readJsonLdProducts(html);
  const product =
    products.find((candidate) => positiveId(candidate.sku) === urlId) ??
    (products.length === 1 ? products[0] : undefined);
  if (!product) {
    return { observation: null, invalidReason: "product_schema_missing", productSchemaFound: false };
  }
  const sku = positiveId(product.sku);
  const name = asText(product.name);
  if (!name) {
    return { observation: null, invalidReason: "product_name_missing", productSchemaFound: true };
  }

  const offers = readOffers(product);
  const priceResult = readPrice(offers);
  const regularPrice = readRegularPrice(product, offers, priceResult.price);
  const packageInfo = readPackage(product, name);
  const externalProductId = sku && urlId && sku === urlId ? sku : null;
  const scopeEvidence = hasReferencePriceEvidence(html);
  const image = Array.isArray(product.image) ? product.image[0] : product.image;
  const observation: AuchanProductObservation = {
    sourceType: "auchan",
    externalProductId,
    externalProductIdReason: externalProductId
      ? null
      : !sku || !urlId
        ? "sku_or_url_id_missing"
        : "sku_url_id_mismatch",
    sourceReference: url.toString(),
    name,
    brand: readBrand(product.brand),
    barcode: readBarcode(product),
    sku,
    urlProductId: urlId,
    price: priceResult.price,
    currency: priceResult.currency,
    regularPrice,
    promotion: readPromotion(product, offers, regularPrice),
    packageQuantity: packageInfo.quantity,
    packageUnit: packageInfo.unit,
    availability: asText(offers[0]?.availability),
    image: typeof image === "string" ? image.trim() || null : null,
    capturedAt: capturedAt.toISOString(),
    priceScope: scopeEvidence ? "reference_only_2650_435" : "unknown",
    priceScopeEvidence: scopeEvidence,
  };

  return { observation, invalidReason: null, productSchemaFound: true };
}

export function isAuchanPriceValid(observation: AuchanProductObservation): boolean {
  return observation.price !== null && observation.currency === "EUR";
}