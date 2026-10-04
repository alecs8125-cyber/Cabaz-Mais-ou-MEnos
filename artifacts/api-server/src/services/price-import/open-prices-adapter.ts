import type {
  ExternalPriceObservation,
  PriceImportSourceAdapter,
} from "./types.js";

const DEFAULT_API_BASE_URL = "https://prices.openfoodfacts.org/api/v1";
const API_PAGE_SIZE = 100;
const MAX_API_PAGES = 500;
const MAX_LOCATION_IDS_PER_QUERY = 100;
const MAX_OBSERVATIONS = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const SOURCE_TYPE = "open_prices";
const STORE_SOURCE_TYPE = "openstreetmap";

type JsonRecord = Record<string, unknown>;

interface ApiPage {
  readonly items: readonly unknown[];
  readonly page: number;
  readonly pages: number;
  readonly size: number;
  readonly total: number;
}

interface PortugalLocation {
  readonly id: string;
  readonly osmType: "NODE" | "WAY" | "RELATION";
  readonly osmId: string;
  readonly countryCode: "PT";
}

interface OpenPriceRecord extends JsonRecord {
  readonly id: unknown;
  readonly date: unknown;
  readonly created: unknown;
}

export interface OpenPricesAdapterOptions {
  readonly apiBaseUrl?: string;
  readonly fetchImplementation?: typeof fetch;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveIntegerText(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value) > 0n ? value : null;
  } catch {
    return null;
  }
}

function osmExternalStoreId(
  osmType: unknown,
  osmId: unknown,
): string | null {
  const id = positiveIntegerText(osmId);
  if (!id || typeof osmType !== "string") return null;

  // Only NODE -> n<ID> has exact matches in the active Supabase store data.
  // Other OSM types remain unmapped until their external_id format is verified.
  return osmType.toUpperCase() === "NODE" ? `n${id}` : null;
}

function parsePage(
  value: unknown,
  expectedPage: number,
  resource: string,
): ApiPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !Number.isSafeInteger(value.page) ||
    !Number.isSafeInteger(value.pages) ||
    !Number.isSafeInteger(value.size) ||
    !Number.isSafeInteger(value.total)
  ) {
    throw new Error(`Open Prices devolveu uma página inválida para ${resource}.`);
  }

  const page = value.page as number;
  const pages = value.pages as number;
  const size = value.size as number;
  const total = value.total as number;
  if (
    page !== expectedPage ||
    pages < 1 ||
    pages > MAX_API_PAGES ||
    size < 1 ||
    size > API_PAGE_SIZE ||
    total < 0 ||
    value.items.length > size
  ) {
    throw new Error(`Open Prices devolveu paginação inválida para ${resource}.`);
  }

  return { items: value.items, page, pages, size, total };
}

function readLocation(value: unknown): PortugalLocation | null {
  if (!isRecord(value)) {
    throw new Error("Open Prices devolveu uma localização inválida.");
  }
  if (value.type !== "OSM" || value.osm_address_country_code !== "PT") {
    return null;
  }

  const id = positiveIntegerText(value.id);
  const osmId = positiveIntegerText(value.osm_id);
  const osmType =
    typeof value.osm_type === "string" ? value.osm_type.toUpperCase() : "";
  if (
    !id ||
    !osmId ||
    (osmType !== "NODE" && osmType !== "WAY" && osmType !== "RELATION")
  ) {
    throw new Error("Open Prices devolveu uma localização OSM com identificadores inválidos.");
  }

  return { id, osmType, osmId, countryCode: "PT" };
}

function readObservation(
  value: unknown,
  locations: ReadonlyMap<string, PortugalLocation>,
): ExternalPriceObservation | null {
  if (!isRecord(value)) {
    throw new Error("Open Prices devolveu um preço inválido.");
  }

  const locationId =
    positiveIntegerText(value.location_id) ??
    (isRecord(value.location) ? positiveIntegerText(value.location.id) : null);
  const location = locationId ? locations.get(locationId) : undefined;
  if (!location || location.countryCode !== "PT") return null;

  const embeddedLocation = isRecord(value.location) ? value.location : null;
  if (
    !embeddedLocation ||
    embeddedLocation.osm_address_country_code !== "PT" ||
    embeddedLocation.type !== "OSM"
  ) {
    return null;
  }
  const embeddedLocationId = positiveIntegerText(embeddedLocation.id);
  const embeddedOsmId = positiveIntegerText(embeddedLocation.osm_id);
  const embeddedOsmType =
    typeof embeddedLocation.osm_type === "string"
      ? embeddedLocation.osm_type.toUpperCase()
      : "";
  if (
    embeddedLocationId !== location.id ||
    embeddedOsmId !== location.osmId ||
    embeddedOsmType !== location.osmType
  ) {
    throw new Error("Open Prices devolveu uma localização inconsistente no preço.");
  }

  const externalStoreId = osmExternalStoreId(location.osmType, location.osmId);
  const externalId = positiveIntegerText(value.id);
  if (!externalId) {
    throw new Error("Open Prices devolveu um preço sem identificadores OSM válidos.");
  }
  if (value.type !== "PRODUCT" || value.currency !== "EUR") return null;

  const barcode = typeof value.product_code === "string" ? value.product_code : null;
  if (barcode === null) {
    throw new Error("Open Prices devolveu um preço de produto sem product_code textual.");
  }
  if (typeof value.price !== "number" && typeof value.price !== "string") {
    throw new Error("Open Prices devolveu um preço com formato inválido.");
  }
  if (typeof value.date !== "string") {
    throw new Error("Open Prices devolveu um preço sem data textual.");
  }

  const priceIsDiscounted =
    value.price_is_discounted === undefined || value.price_is_discounted === null
      ? null
      : typeof value.price_is_discounted === "boolean"
        ? value.price_is_discounted
        : null;
  if (
    value.price_is_discounted !== undefined &&
    value.price_is_discounted !== null &&
    typeof value.price_is_discounted !== "boolean"
  ) {
    throw new Error("Open Prices devolveu price_is_discounted com formato inválido.");
  }

  const priceWithoutDiscount =
    value.price_without_discount === undefined
      ? undefined
      : value.price_without_discount === null ||
          typeof value.price_without_discount === "number" ||
          typeof value.price_without_discount === "string"
        ? value.price_without_discount
        : null;
  if (
    value.price_without_discount !== undefined &&
    value.price_without_discount !== null &&
    typeof value.price_without_discount !== "number" &&
    typeof value.price_without_discount !== "string"
  ) {
    throw new Error("Open Prices devolveu price_without_discount com formato inválido.");
  }

  const promotion = priceIsDiscounted === true ? "discounted" : null;
  const observation: ExternalPriceObservation = {
    sourceType: SOURCE_TYPE,
    externalId,
    sourceReference: `${DEFAULT_API_BASE_URL}/prices/${encodeURIComponent(externalId)}`,
    barcode,
    storeSourceType: STORE_SOURCE_TYPE,
    externalStoreId,
    storeMappingUnverified: externalStoreId === null,
    sourceStoreOsmType: location.osmType,
    sourceStoreOsmId: location.osmId,
    price: value.price,
    currency: "EUR",
    promotion,
    priceIsDiscounted,
    capturedAt: value.date,
    validFrom: null,
    validUntil: null,
    ...(priceWithoutDiscount !== undefined ? { priceWithoutDiscount } : {}),
  };
  return observation;
}

function compareRecentPrices(left: OpenPriceRecord, right: OpenPriceRecord): number {
  const dateOrder = String(right.date ?? "").localeCompare(String(left.date ?? ""));
  if (dateOrder !== 0) return dateOrder;

  const createdOrder = String(right.created ?? "").localeCompare(
    String(left.created ?? ""),
  );
  if (createdOrder !== 0) return createdOrder;
  return String(right.id ?? "").localeCompare(String(left.id ?? ""));
}

export class OpenPricesAdapter implements PriceImportSourceAdapter {
  readonly sourceType = SOURCE_TYPE;
  readonly mode = "external" as const;
  readonly requiresValidUntil = false;
  /** Cabaz policy for dry-run eligibility; this value is not supplied by Open Prices. */
  readonly validityWindowDays = 7;

  private readonly apiBaseUrl: URL;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: OpenPricesAdapterOptions = {}) {
    this.apiBaseUrl = new URL(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    if (
      this.apiBaseUrl.protocol !== "https:" ||
      this.apiBaseUrl.username ||
      this.apiBaseUrl.password ||
      this.apiBaseUrl.search ||
      this.apiBaseUrl.hash
    ) {
      throw new Error("A base URL da API Open Prices tem de ser HTTPS e não conter credenciais.");
    }
    this.apiBaseUrl.pathname = this.apiBaseUrl.pathname.replace(/\/+$/, "");
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async fetchObservations(): Promise<readonly ExternalPriceObservation[]> {
    const locations = await this.fetchPortugalLocations();
    if (locations.size === 0) return [];

    const locationIds = [...locations.keys()];
    const records: OpenPriceRecord[] = [];
    for (
      let index = 0;
      index < locationIds.length;
      index += MAX_LOCATION_IDS_PER_QUERY
    ) {
      const locationIdGroup = locationIds.slice(
        index,
        index + MAX_LOCATION_IDS_PER_QUERY,
      );
      const page = await this.fetchPage(
        "prices",
        {
          location_id__in: locationIdGroup.join(","),
          type: "PRODUCT",
          product_code__isnull: "false",
          currency: "EUR",
          order_by: "-date,-created",
        },
        1,
      );
      records.push(...page.items.map((item) => {
        if (!isRecord(item)) {
          throw new Error("Open Prices devolveu um item de preço inválido.");
        }
        return item as OpenPriceRecord;
      }));
    }

    return records
      .sort(compareRecentPrices)
      .map((record) => readObservation(record, locations))
      .filter((observation): observation is ExternalPriceObservation =>
        observation !== null
      )
      .slice(0, MAX_OBSERVATIONS);
  }

  private async fetchPortugalLocations(): Promise<Map<string, PortugalLocation>> {
    const firstPage = await this.fetchPage(
      "locations",
      {
        type: "OSM",
        osm_address_country__like: "Portugal",
        price_count__gte: "1",
        order_by: "id",
      },
      1,
    );
    const pages = [firstPage];
    for (let pageNumber = 2; pageNumber <= firstPage.pages; pageNumber += 1) {
      pages.push(
        await this.fetchPage(
          "locations",
          {
            type: "OSM",
            osm_address_country__like: "Portugal",
            price_count__gte: "1",
            order_by: "id",
          },
          pageNumber,
        ),
      );
    }

    const locations = new Map<string, PortugalLocation>();
    for (const page of pages) {
      for (const value of page.items) {
        const location = readLocation(value);
        if (location) locations.set(location.id, location);
      }
    }
    return locations;
  }

  private async fetchPage(
    resource: "locations" | "prices",
    parameters: Readonly<Record<string, string>>,
    pageNumber: number,
  ): Promise<ApiPage> {
    const url = new URL(
      resource,
      `${this.apiBaseUrl.toString().replace(/\/?$/, "/")}`,
    );
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("size", String(API_PAGE_SIZE));
    url.searchParams.set("page", String(pageNumber));

    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error(`A leitura Open Prices de ${resource} falhou.`);
    }
    if (!response.ok) {
      throw new Error(
        `A leitura Open Prices de ${resource} falhou com HTTP ${response.status}.`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Open Prices devolveu JSON inválido para ${resource}.`);
    }
    return parsePage(body, pageNumber, resource);
  }
}