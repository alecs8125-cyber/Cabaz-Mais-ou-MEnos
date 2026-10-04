import { verifyContinenteSnapshot } from "./continente-verification-core.mjs";

const PAGE_SIZE = 500;
const MAX_PAGES = 200;
const PRODUCT_ID_CHUNK_SIZE = 50;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function configuration() {
  const rawUrl = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceKey) {
    throw new Error("Read-only verification requires the configured Supabase URL and service-role secret.");
  }
  const url = new URL(rawUrl);
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname) {
    throw new Error("Configured Supabase URL is invalid.");
  }
  if (
    !/^(sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+)$/.test(serviceKey)
  ) {
    throw new Error("Configured server key is not a recognized service-role key.");
  }
  return { baseUrl: url, serviceKey };
}

async function getJson(resource, accept = "application/json") {
  const { baseUrl, serviceKey } = configuration();
  const url = new URL(resource, baseUrl);
  const headers = { apikey: serviceKey, accept };
  if (serviceKey.startsWith("eyJ")) headers.authorization = `Bearer ${serviceKey}`;
  const response = await fetch(url, { method: "GET", headers, cache: "no-store" });
  if (!response.ok) {
    let code = "";
    try {
      const body = await response.json();
      if (typeof body?.code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(body.code)) {
        code = ` (${body.code})`;
      }
    } catch {}
    throw new Error(`Read-only request failed for ${new URL(resource, baseUrl).pathname}: HTTP ${response.status}${code}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Read-only request returned invalid JSON for ${new URL(resource, baseUrl).pathname}.`);
  }
}

async function readRows(table, select, filters = {}) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ select, order: "id.asc", limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), ...filters });
    const result = await getJson(`/rest/v1/${table}?${params.toString()}`);
    if (!Array.isArray(result)) throw new Error(`Read-only request returned a non-list for ${table}.`);
    rows.push(...result);
    if (result.length < PAGE_SIZE) return rows;
  }
  throw new Error(`Read-only verification exceeded the pagination safety limit for ${table}.`);
}

async function readMappedProducts(productIds) {
  const uniqueIds = [...new Set(productIds)];
  const result = [];
  for (let start = 0; start < uniqueIds.length; start += PRODUCT_ID_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(start, start + PRODUCT_ID_CHUNK_SIZE);
    if (chunk.some((id) => !UUID_PATTERN.test(id))) {
      throw new Error("A mapping contains an invalid product UUID.");
    }
    const filter = `in.(${chunk.join(",")})`;
    result.push(...await readRows("products", "id,name,active,source_type,external_id", {
      id: filter,
    }));
  }
  return result;
}

async function readHistory(productIds, storeId) {
  const uniqueIds = [...new Set(productIds)];
  const result = [];
  for (let start = 0; start < uniqueIds.length; start += PRODUCT_ID_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(start, start + PRODUCT_ID_CHUNK_SIZE);
    if (chunk.some((id) => !UUID_PATTERN.test(id))) {
      throw new Error("A mapping contains an invalid product UUID.");
    }
    const filter = `in.(${chunk.join(",")})`;
    result.push(...await readRows("price_history", "product_id,store_id,price,captured_at", {
      product_id: filter,
      store_id: `eq.${storeId}`,
    }));
  }
  return result;
}

async function main() {
  const onlineStores = await readRows(
    "stores",
    "id,name,active,store_type,source_type,external_id,district,municipality,parish,latitude,longitude,address",
    { source_type: "eq.continente", external_id: "eq.online" },
  );
  const sourceProducts = await readRows(
    "products",
    "id,name,active,source_type,external_id",
    { source_type: "eq.continente" },
  );
  const mappings = await readRows(
    "external_product_mappings",
    "id,source_type,external_product_id,product_id,match_method,confidence,verified",
    { source_type: "eq.continente" },
  );
  const prices = await readRows(
    "prices",
    "id,product_id,store_id,price,currency,captured_at,valid_from,valid_until,source_type,external_id,verification_status",
    { source_type: "eq.continente" },
  );
  const mappedProducts = await readMappedProducts(mappings.map((mapping) => mapping.product_id));
  const history = onlineStores.length === 1
    ? await readHistory(mappings.map((mapping) => mapping.product_id), onlineStores[0].id)
    : [];

  const report = verifyContinenteSnapshot({
    sourceProducts,
    mappedProducts,
    mappings,
    prices,
    onlineStores,
    history,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown verification error.";
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});