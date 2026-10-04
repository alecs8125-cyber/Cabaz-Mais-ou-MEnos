import {
  parseContinenteProductHtml,
} from "./continente-parser.js";
import type {
  ContinenteAdapterAudit,
  ContinenteIdStability,
  ContinentePageAttempt,
  ContinenteProductObservation,
} from "./continente-types.js";

const DEFAULT_BASE_URL = "https://www.continente.pt";
const MAX_PRODUCT_LIMIT = 200;
const MAX_STABILITY_READS = 20;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_SITEMAP_BYTES = 16 * 1024 * 1024;
const MAX_PRODUCT_HTML_BYTES = 2 * 1024 * 1024;
const PRODUCT_PATH_PREFIX = "/produto/";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TRANSIENT_RETRIES = 2;
const MAX_PRODUCT_REDIRECTS = 3;

export interface ContinenteAdapterOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestDelayMs?: number;
  readonly now?: () => Date;
  readonly maxProductPageRequests?: number;
}

interface FetchTextResult {
  readonly status: number;
  readonly location: string | null;
  readonly text: string;
}

interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly { readonly allow: boolean; readonly value: string }[];
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseRobotsGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let agents: string[] = [];
  let rules: { allow: boolean; value: string }[] = [];

  const commit = () => {
    if (agents.length) groups.push({ agents, rules });
    agents = [];
    rules = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0]?.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (rules.length) commit();
      agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && agents.length) {
      rules.push({ allow: key === "allow", value });
    }
  }
  commit();
  return groups;
}

function robotsRuleMatches(rule: string, path: string): boolean {
  if (!rule) return false;
  const isEndAnchored = rule.endsWith("$");
  const pattern = (isEndAnchored ? rule.slice(0, -1) : rule)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const expression = new RegExp(`^${pattern}${isEndAnchored ? "$" : ""}`);
  return expression.test(path);
}

export function robotsAllowsPath(
  robotsText: string,
  path: string,
  userAgent = "CabazContinenteDryRun",
): boolean {
  const groups = parseRobotsGroups(robotsText);
  const specificGroups = groups.filter((group) =>
    group.agents.some((agent) =>
      agent !== "*" && userAgent.toLowerCase().includes(agent)
    )
  );
  const applicableGroups = specificGroups.length
    ? specificGroups
    : groups.filter((group) => group.agents.includes("*"));
  const matchingRules = applicableGroups
    .flatMap((group) => group.rules)
    .filter((rule) => rule.value && robotsRuleMatches(rule.value, path))
    .sort((left, right) =>
      right.value.replace(/\*/g, "").length - left.value.replace(/\*/g, "").length
    );
  if (!matchingRules.length) return true;
  const longestLength = matchingRules[0]!.value.replace(/\*/g, "").length;
  const longestRules = matchingRules.filter(
    (rule) => rule.value.replace(/\*/g, "").length === longestLength,
  );
  return longestRules.some((rule) => rule.allow);
}

function isSameSiteHttps(candidate: string, baseUrl: URL): URL | null {
  try {
    const url = new URL(candidate, baseUrl);
    if (url.protocol !== "https:" || url.origin !== baseUrl.origin) return null;
    return url;
  } catch {
    return null;
  }
}

function getLocationValues(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const location = htmlDecode(match[1] ?? "").trim();
    if (location) values.push(location);
  }
  return values;
}

function parseProductSitemaps(xml: string, baseUrl: URL): string[] {
  const productSitemaps: string[] = [];
  for (const location of getLocationValues(xml)) {
    const url = isSameSiteHttps(location, baseUrl);
    if (!url || !/product/i.test(url.pathname)) continue;
    productSitemaps.push(url.toString());
  }
  return [...new Set(productSitemaps)].sort((left, right) => left.localeCompare(right));
}

function validProductUrl(input: string, baseUrl: URL): string | null {
  const url = isSameSiteHttps(input, baseUrl);
  if (
    !url ||
    !url.pathname.toLowerCase().startsWith(PRODUCT_PATH_PREFIX) ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.toString();
}

function productUrlsFromSitemap(xml: string, baseUrl: URL): string[] {
  const urls = new Set<string>();
  for (const location of getLocationValues(xml)) {
    const productUrl = validProductUrl(location, baseUrl);
    if (productUrl) urls.add(productUrl);
  }
  return [...urls].sort((left, right) => left.localeCompare(right));
}

function productIdFromUrl(input: string): string | null {
  try {
    return /-([1-9]\d*)\.html$/i.exec(new URL(input).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function isTransientTimeout(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const error = cause as Error & { code?: string };
  return error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.code === "UND_ERR_CONNECT_TIMEOUT" ||
    error.code === "ETIMEDOUT" ||
    /timed?\s*out|timeout/i.test(error.message);
}

export interface ContinenteSitemapPlan {
  readonly robotsUrl: string;
  readonly sitemapIndexUrl: string;
  readonly productSitemaps: readonly string[];
  readonly retries: number;
}

export interface ContinenteSitemapBatch {
  readonly sitemapUrl: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly totalUrls: number;
  readonly selectedUrls: readonly string[];
  readonly skippedKnown: number;
  readonly firstPassAttempts: readonly ContinentePageAttempt[];
  readonly stability: ContinenteIdStability;
  readonly stoppedReason: string | null;
  readonly productPageRequests: number;
  readonly retries: number;
}

export interface ContinenteProductUrlBatch {
  readonly requestedUrls: readonly string[];
  readonly firstPassAttempts: readonly ContinentePageAttempt[];
  readonly stability: ContinenteIdStability;
  readonly stoppedReason: string | null;
  readonly productPageRequests: number;
  readonly retries: number;
}

async function readLimitedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`response_exceeds_${maximumBytes}_bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`response_exceeds_${maximumBytes}_bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export class ContinenteAdapter {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly requestDelayMs: number;
  private readonly now: () => Date;
  private readonly maxProductPageRequests: number;
  private productPageRequests = 0;
  private retries = 0;
  private readonly sitemapCache = new Map<string, readonly string[]>();

  constructor(options: ContinenteAdapterOptions = {}) {
    this.baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if (this.baseUrl.protocol !== "https:") {
      throw new Error("Continente crawling requires HTTPS.");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestDelayMs = Math.max(0, options.requestDelayMs ?? 1_000);
    this.now = options.now ?? (() => new Date());
    this.maxProductPageRequests = options.maxProductPageRequests ?? Number.POSITIVE_INFINITY;
    if (
      this.maxProductPageRequests !== Number.POSITIVE_INFINITY &&
      (!Number.isSafeInteger(this.maxProductPageRequests) || this.maxProductPageRequests < 1)
    ) {
      throw new Error("maxProductPageRequests must be a positive safe integer.");
    }
  }

  async discoverProductSitemaps(): Promise<ContinenteSitemapPlan> {
    const startRetries = this.retries;
    const robotsUrl = new URL("/robots.txt", this.baseUrl);
    const robotsText = await this.getRequiredText(robotsUrl, MAX_ROBOTS_BYTES);
    const productPath = `${PRODUCT_PATH_PREFIX}produto-de-teste-1.html`;
    if (!robotsAllowsPath(robotsText.text, productPath)) {
      throw new Error(`robots.txt disallows ${productPath}; no product pages were requested.`);
    }

    const sitemapDirective = robotsText.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^sitemap\s*:/i.test(line));
    if (!sitemapDirective) throw new Error("robots.txt did not declare a sitemap.");
    const sitemapIndex = isSameSiteHttps(
      sitemapDirective.slice(sitemapDirective.indexOf(":") + 1).trim(),
      this.baseUrl,
    );
    if (!sitemapIndex) throw new Error("The declared sitemap is not on the HTTPS site origin.");

    const indexText = await this.getRequiredText(sitemapIndex, MAX_SITEMAP_BYTES);
    const productSitemaps = parseProductSitemaps(indexText.text, this.baseUrl);
    if (!productSitemaps.length) {
      throw new Error("The sitemap index contained no same-site product sitemaps.");
    }
    return {
      robotsUrl: robotsUrl.toString(),
      sitemapIndexUrl: sitemapIndex.toString(),
      productSitemaps,
      retries: this.retries - startRetries,
    };
  }

  async runSitemapBatch(
    sitemapUrl: string,
    inputOffset: number,
    inputLimit: number,
    inputStabilityReads = 0,
    knownProductIds: ReadonlySet<string> = new Set(),
    inputMaxProductUrls = Number.POSITIVE_INFINITY,
    resumeAfterUrl: string | null = null,
  ): Promise<ContinenteSitemapBatch> {
    if (!Number.isSafeInteger(inputOffset) || inputOffset < 0) {
      throw new Error("The sitemap batch offset must be a non-negative safe integer.");
    }
    const limit = Math.min(MAX_PRODUCT_LIMIT, Math.max(1, Math.floor(inputLimit)));
    const stabilityReads = Math.min(
      MAX_STABILITY_READS,
      Math.max(0, Math.floor(inputStabilityReads)),
    );
    const safeSitemapUrl = isSameSiteHttps(sitemapUrl, this.baseUrl);
    if (!safeSitemapUrl || !/product/i.test(safeSitemapUrl.pathname)) {
      throw new Error("The selected sitemap is not a same-site HTTPS product sitemap.");
    }

    const startRequests = this.productPageRequests;
    const startRetries = this.retries;
    let productUrls = this.sitemapCache.get(safeSitemapUrl.toString());
    if (!productUrls) {
      const sitemapText = await this.getRequiredText(safeSitemapUrl, MAX_SITEMAP_BYTES);
      productUrls = productUrlsFromSitemap(sitemapText.text, this.baseUrl);
      this.sitemapCache.set(safeSitemapUrl.toString(), productUrls);
    }
    let startOffset = inputOffset;
    if (resumeAfterUrl) {
      const bookmarkIndex = productUrls.indexOf(resumeAfterUrl);
      if (bookmarkIndex < 0) {
        throw new Error("The last product URL bookmark is absent from its sitemap; resume stopped safely.");
      }
      startOffset = bookmarkIndex + 1;
    }
    const selectedUrls: string[] = [];
    const crawlUrls: string[] = [];
    for (const url of productUrls.slice(startOffset, startOffset + limit)) {
      selectedUrls.push(url);
      const id = productIdFromUrl(url);
      if ((!id || !knownProductIds.has(id)) && crawlUrls.length < inputMaxProductUrls) {
        crawlUrls.push(url);
      }
      if (crawlUrls.length >= inputMaxProductUrls && inputMaxProductUrls > 0) break;
    }
    const skippedKnown = selectedUrls.length - crawlUrls.length;
    const result = await this.runProductUrls(crawlUrls, stabilityReads);
    return {
      sitemapUrl: safeSitemapUrl.toString(),
      offset: startOffset,
      nextOffset: startOffset + selectedUrls.length,
      totalUrls: productUrls.length,
      selectedUrls,
      skippedKnown,
      ...result,
      productPageRequests: this.productPageRequests - startRequests,
      retries: this.retries - startRetries,
    };
  }

  async runProductUrls(
    urls: readonly string[],
    inputStabilityReads = 0,
  ): Promise<ContinenteProductUrlBatch> {
    const stabilityTarget = Math.min(
      MAX_STABILITY_READS,
      Math.max(0, Math.floor(inputStabilityReads)),
    );
    const startRequests = this.productPageRequests;
    const startRetries = this.retries;
    const firstPassAttempts: ContinentePageAttempt[] = [];
    let stoppedReason: string | null = null;
    for (const inputUrl of urls) {
      const url = validProductUrl(inputUrl, this.baseUrl);
      if (!url) {
        firstPassAttempts.push({
          url: inputUrl,
          outcome: "invalid_page",
          status: null,
          redirectLocation: null,
          observation: null,
          error: "unsafe_product_url",
        });
        continue;
      }
      if (firstPassAttempts.length > 0) await this.delay();
      const attempt = await this.readProductPage(url);
      firstPassAttempts.push(attempt);
      if (attempt.outcome === "blocked") {
        stoppedReason = "Stopped on an HTTP block or anti-bot challenge; no workaround was attempted.";
        break;
      }
      if (attempt.error === "product_page_request_budget_exceeded") {
        stoppedReason = "Stopped at the configured product-page request budget.";
        break;
      }
    }
    const stability = await this.verifyIdStability(
      firstPassAttempts,
      stabilityTarget,
      stoppedReason !== null,
    );
    return {
      requestedUrls: urls,
      firstPassAttempts,
      stability,
      stoppedReason,
      productPageRequests: this.productPageRequests - startRequests,
      retries: this.retries - startRetries,
    };
  }

  async runAudit(
    inputLimit = MAX_PRODUCT_LIMIT,
    inputStabilityReads = MAX_STABILITY_READS,
    inputOffset = 0,
  ): Promise<ContinenteAdapterAudit> {
    const limit = Math.min(MAX_PRODUCT_LIMIT, Math.max(1, Math.floor(inputLimit)));
    const stabilityTarget = Math.min(
      MAX_STABILITY_READS,
      Math.max(0, Math.floor(inputStabilityReads)),
    );
    if (!Number.isSafeInteger(inputOffset) || inputOffset < 0) {
      throw new Error("The sitemap batch offset must be a non-negative safe integer.");
    }
    const startOffset = inputOffset;
    const startRequests = this.productPageRequests;
    const startRetries = this.retries;
    const robotsUrl = new URL("/robots.txt", this.baseUrl);
    const robotsText = await this.getRequiredText(robotsUrl, MAX_ROBOTS_BYTES);
    const productPath = `${PRODUCT_PATH_PREFIX}produto-de-teste-1.html`;
    const robotsAllowsProductPages = robotsAllowsPath(robotsText.text, productPath);
    if (!robotsAllowsProductPages) {
      throw new Error(`robots.txt disallows ${productPath}; no product pages were requested.`);
    }

    const sitemapDirective = robotsText.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^sitemap\s*:/i.test(line));
    if (!sitemapDirective) throw new Error("robots.txt did not declare a sitemap.");
    const sitemapIndex = isSameSiteHttps(
      sitemapDirective.slice(sitemapDirective.indexOf(":") + 1).trim(),
      this.baseUrl,
    );
    if (!sitemapIndex) throw new Error("The declared sitemap is not on the HTTPS site origin.");

    const indexText = await this.getRequiredText(sitemapIndex, MAX_SITEMAP_BYTES);
    const productSitemaps = parseProductSitemaps(indexText.text, this.baseUrl);
    if (!productSitemaps.length) {
      throw new Error("The sitemap index contained no same-site product sitemaps.");
    }

    let sampledSitemapUrl: string | null = null;
    let productSitemapsRead = 0;
    let productUrlsScanned = 0;
    const sampledProductUrls: string[] = [];
    for (const sitemapUrl of productSitemaps) {
      const sitemapText = await this.getRequiredText(new URL(sitemapUrl), MAX_SITEMAP_BYTES);
      const productUrls = productUrlsFromSitemap(sitemapText.text, this.baseUrl);
      productSitemapsRead += 1;
      if (!productUrls.length) continue;
      const localStart = Math.max(0, startOffset - productUrlsScanned);
      if (localStart < productUrls.length && sampledProductUrls.length < limit) {
        sampledSitemapUrl ??= sitemapUrl;
        sampledProductUrls.push(
          ...productUrls.slice(
            localStart,
            localStart + (limit - sampledProductUrls.length),
          ),
        );
      }
      productUrlsScanned += productUrls.length;
      if (sampledProductUrls.length >= limit) break;
    }

    const uniqueSample = [...new Set(sampledProductUrls)].slice(0, limit);
    const firstPassAttempts: ContinentePageAttempt[] = [];
    let stoppedReason: string | null = null;
    let consecutiveNetworkErrors = 0;
    for (const url of uniqueSample) {
      if (firstPassAttempts.length > 0) await this.delay();
      const attempt = await this.readProductPage(url);
      firstPassAttempts.push(attempt);
      if (attempt.outcome === "network_error") {
        consecutiveNetworkErrors += 1;
        if (consecutiveNetworkErrors >= 3) {
          stoppedReason = "Stopped after three consecutive product-page network errors.";
          break;
        }
      } else {
        consecutiveNetworkErrors = 0;
      }
      if (attempt.outcome === "blocked") {
        stoppedReason = "Stopped on an HTTP block or anti-bot challenge; no workaround was attempted.";
        break;
      }
    }

    const stability = await this.verifyIdStability(
      firstPassAttempts,
      stabilityTarget,
      stoppedReason !== null,
    );
    return {
      robotsUrl: robotsUrl.toString(),
      robotsAllowsProductPages,
      sitemapIndexUrl: sitemapIndex.toString(),
      productSitemaps,
      productSitemapsRead,
      productUrlsScanned,
      startOffset,
      sampledSitemapUrl,
      sampledProductUrls: uniqueSample,
      firstPassAttempts,
      stability,
      stoppedReason,
      productPageRequests: this.productPageRequests - startRequests,
      retries: this.retries - startRetries,
    };
  }

  private async getRequiredText(url: URL, maximumBytes: number): Promise<FetchTextResult> {
    const response = await this.request(url);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GET ${url.pathname} failed with HTTP ${response.status}.`);
    }
    const text = await readLimitedText(response, maximumBytes);
    return {
      status: response.status,
      location: response.headers.get("location"),
      text,
    };
  }

  private async request(url: URL, productPage = false): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      if (productPage && this.productPageRequests >= this.maxProductPageRequests) {
        throw new Error("product_page_request_budget_exceeded");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      if (productPage) this.productPageRequests += 1;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "user-agent": "CabazContinenteDryRun/1.0 (public product price validation)",
          },
        });
      } catch (cause) {
        clearTimeout(timeout);
        if (attempt < MAX_TRANSIENT_RETRIES && isTransientTimeout(cause)) {
          this.retries += 1;
          await this.delayForRetry(attempt);
          continue;
        }
        throw cause;
      }
      clearTimeout(timeout);
      if (
        attempt < MAX_TRANSIENT_RETRIES &&
        (response.status === 408 || response.status === 429 || response.status >= 500)
      ) {
        await response.body?.cancel();
        this.retries += 1;
        await this.delayForRetry(attempt);
        continue;
      }
      return response;
    }
  }

  private async readProductPage(
    url: string,
    redirectDepth = 0,
  ): Promise<ContinentePageAttempt> {
    try {
      const safeUrl = validProductUrl(url, this.baseUrl);
      if (!safeUrl) {
        return {
          url,
          outcome: "invalid_page",
          status: null,
          redirectLocation: null,
          observation: null,
          error: "unsafe_product_url",
        };
      }
      const response = await this.request(new URL(safeUrl), true);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const target = location ? validProductUrl(location, this.baseUrl) : null;
        const sameProduct = target !== null &&
          productIdFromUrl(target) !== null &&
          productIdFromUrl(target) === productIdFromUrl(safeUrl);
        if (sameProduct && redirectDepth < MAX_PRODUCT_REDIRECTS) {
          const followed = await this.readProductPage(target, redirectDepth + 1);
          return { ...followed, url: safeUrl, redirectLocation: target };
        }
        return {
          url: safeUrl,
          outcome: "redirect",
          status: response.status,
          redirectLocation: location,
          observation: null,
          error: sameProduct ? "product_redirect_limit_exceeded" : "unsafe_redirect_not_followed",
        };
      }
      if (!response.ok) {
        const errorBody = await readLimitedText(response, 8 * 1024).catch(() => "");
        const blocked = response.status === 401 ||
          response.status === 403 ||
          response.status === 429 ||
          isChallengePage(errorBody);
        return {
          url: safeUrl,
          outcome: blocked ? "blocked" : "http_error",
          status: response.status,
          redirectLocation: null,
          observation: null,
          error: `HTTP ${response.status}`,
        };
      }

      const html = await readLimitedText(response, MAX_PRODUCT_HTML_BYTES);
      if (isChallengePage(html)) {
        return {
          url: safeUrl,
          outcome: "blocked",
          status: response.status,
          redirectLocation: null,
          observation: null,
          error: "anti_bot_challenge_detected",
        };
      }
      const parsed = parseContinenteProductHtml(html, safeUrl, this.now());
      if (!parsed.observation) {
        return {
          url: safeUrl,
          outcome: "invalid_page",
          status: response.status,
          redirectLocation: null,
          observation: null,
          error: parsed.invalidReason,
        };
      }
      return {
        url: safeUrl,
        outcome: "product",
        status: response.status,
        redirectLocation: null,
        observation: parsed.observation,
        error: null,
      };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "unknown_network_error";
      return {
        url,
        outcome: error.startsWith("response_exceeds_") ? "invalid_page" : "network_error",
        status: null,
        redirectLocation: null,
        observation: null,
        error,
      };
    }
  }

  private async delayForRetry(attempt: number): Promise<void> {
    const retryDelay = Math.min(1_000, 250 * (2 ** attempt));
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }

  private async verifyIdStability(
    firstPass: readonly ContinentePageAttempt[],
    target: number,
    blocked: boolean,
  ): Promise<ContinenteIdStability> {
    if (blocked || target === 0) {
      return { target, attempted: 0, stable: 0, changed: 0, failed: 0, details: [] };
    }
    const byExternalId = new Map<string, ContinenteProductObservation>();
    for (const attempt of firstPass) {
      const observation = attempt.observation;
      if (!observation?.externalProductId) continue;
      if (!byExternalId.has(observation.externalProductId)) {
        byExternalId.set(observation.externalProductId, observation);
      }
    }
    const candidates = [...byExternalId.values()].slice(0, target);
    const details: ContinenteIdStability["details"][number][] = [];
    let stable = 0;
    let changed = 0;
    let failed = 0;
    for (const observation of candidates) {
      await this.delay();
      const second = await this.readProductPage(observation.sourceReference);
      const secondId = second.observation?.externalProductId ?? null;
      const isStable = second.outcome === "product" &&
        secondId === observation.externalProductId &&
        second.observation?.sku === observation.sku &&
        second.observation?.mpn === observation.mpn &&
        second.observation?.urlProductId === observation.urlProductId;
      if (isStable) stable += 1;
      else if (second.outcome === "product") changed += 1;
      else failed += 1;
      details.push({
        url: observation.sourceReference,
        firstExternalProductId: observation.externalProductId!,
        secondExternalProductId: secondId,
        stable: isStable,
      });
      if (second.outcome === "blocked") break;
    }
    return {
      target,
      attempted: details.length,
      stable,
      changed,
      failed,
      details,
    };
  }

  private async delay(): Promise<void> {
    if (!this.requestDelayMs) return;
    await new Promise((resolve) => setTimeout(resolve, this.requestDelayMs));
  }
}

function isChallengePage(text: string): boolean {
  const sample = text.slice(0, 100_000);
  return /<title[^>]*>\s*(?:just a moment|access denied|verify you are human|robot check|security check)/i.test(sample) ||
    /cf-chl-|captcha required|unusual traffic|automated requests are not allowed/i.test(sample);
}
