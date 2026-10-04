import { parseAuchanProductHtml } from "./auchan-parser.js";
import type {
  AuchanAdapterAudit,
  AuchanIdStability,
  AuchanPageAttempt,
  AuchanProductObservation,
} from "./auchan-types.js";

const DEFAULT_BASE_URL = "https://www.auchan.pt";
const MAX_TOTAL_PRODUCT_REQUESTS = 100;
const MAX_STABILITY_READS = 20;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_SITEMAP_BYTES = 16 * 1024 * 1024;
const MAX_PRODUCT_HTML_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PRODUCT_REDIRECTS = 2;

export interface AuchanAdapterOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestDelayMs?: number;
  readonly now?: () => Date;
  readonly maxProductPageRequests?: number;
}

interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly { readonly allow: boolean; readonly value: string }[];
}

function decodeEntities(value: string): string {
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
  const anchored = rule.endsWith("$");
  const pattern = (anchored ? rule.slice(0, -1) : rule)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
}

export function auchanRobotsAllowsPath(
  robotsText: string,
  path: string,
  userAgent = "CabazAuchanPublicDryRun",
): boolean {
  const groups = parseRobotsGroups(robotsText);
  const specific = groups.filter((group) =>
    group.agents.some((agent) =>
      agent !== "*" && userAgent.toLowerCase().includes(agent)
    )
  );
  const applicable = specific.length
    ? specific
    : groups.filter((group) => group.agents.includes("*"));
  const matches = applicable
    .flatMap((group) => group.rules)
    .filter((rule) => rule.value && robotsRuleMatches(rule.value, path))
    .sort((left, right) =>
      right.value.replace(/\*/g, "").length - left.value.replace(/\*/g, "").length
    );
  if (!matches.length) return true;
  const longest = matches[0]!.value.replace(/\*/g, "").length;
  return matches
    .filter((rule) => rule.value.replace(/\*/g, "").length === longest)
    .some((rule) => rule.allow);
}

function sameSiteHttps(input: string, baseUrl: URL): URL | null {
  try {
    const url = new URL(input, baseUrl);
    return url.protocol === "https:" && url.origin === baseUrl.origin ? url : null;
  } catch {
    return null;
  }
}

function locationValues(xml: string): string[] {
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeEntities(match[1] ?? "").trim())
    .filter(Boolean);
}

function productSitemaps(xml: string, baseUrl: URL): string[] {
  const urls = new Set<string>();
  for (const location of locationValues(xml)) {
    const url = sameSiteHttps(location, baseUrl);
    if (url && /product/i.test(url.pathname)) urls.add(url.toString());
  }
  return [...urls].sort((left, right) => left.localeCompare(right));
}

function validProductUrl(input: string, baseUrl: URL): string | null {
  const url = sameSiteHttps(input, baseUrl);
  if (
    !url ||
    !url.pathname.toLowerCase().startsWith("/pt/") ||
    !/\/[1-9]\d*\.html$/i.test(url.pathname) ||
    url.search ||
    url.hash
  ) return null;
  return url.toString();
}

function productIdFromUrl(input: string): string | null {
  try {
    return /\/([1-9]\d*)\.html$/i.exec(new URL(input).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readLimitedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
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

function isChallengePage(text: string): boolean {
  const sample = text.slice(0, 100_000);
  return /<title[^>]*>\s*(?:just a moment|access denied|verify you are human|robot check|security check)/i.test(sample) ||
    /cf-chl-|captcha required|unusual traffic|automated requests are not allowed/i.test(sample);
}

function boundedInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export class AuchanAdapter {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly requestDelayMs: number;
  private readonly now: () => Date;
  private readonly maxProductPageRequests: number;
  private productPageRequests = 0;
  private robotsText = "";

  constructor(options: AuchanAdapterOptions = {}) {
    this.baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if (this.baseUrl.protocol !== "https:") {
      throw new Error("Auchan public-page reads require HTTPS.");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestDelayMs = Math.max(0, options.requestDelayMs ?? 1_000);
    this.now = options.now ?? (() => new Date());
    this.maxProductPageRequests = Math.min(
      MAX_TOTAL_PRODUCT_REQUESTS,
      options.maxProductPageRequests ?? MAX_TOTAL_PRODUCT_REQUESTS,
    );
    if (!Number.isSafeInteger(this.maxProductPageRequests) || this.maxProductPageRequests < 1) {
      throw new Error("maxProductPageRequests must be an integer between 1 and 100.");
    }
  }

  async runAudit(
    inputTotalPageBudget = MAX_TOTAL_PRODUCT_REQUESTS,
    inputStabilityReads = MAX_STABILITY_READS,
    inputOffset = 0,
  ): Promise<AuchanAdapterAudit> {
    const pageBudget = Math.min(
      this.maxProductPageRequests,
      boundedInteger(inputTotalPageBudget, 1, MAX_TOTAL_PRODUCT_REQUESTS),
    );
    const stabilityTarget = Math.min(
      MAX_STABILITY_READS,
      Math.max(0, Math.floor(inputStabilityReads)),
      Math.max(0, pageBudget - 1),
    );
    if (!Number.isSafeInteger(inputOffset) || inputOffset < 0) {
      throw new Error("The sitemap offset must be a non-negative safe integer.");
    }
    const startRequests = this.productPageRequests;
    const robotsUrl = new URL("/robots.txt", this.baseUrl);
    this.robotsText = await this.getRequiredText(robotsUrl, MAX_ROBOTS_BYTES);
    const sitemapLine = this.robotsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^sitemap\s*:/i.test(line));
    if (!sitemapLine) throw new Error("robots.txt did not declare a sitemap.");
    const sitemapIndex = sameSiteHttps(
      sitemapLine.slice(sitemapLine.indexOf(":") + 1).trim(),
      this.baseUrl,
    );
    if (!sitemapIndex) {
      throw new Error("The declared sitemap is not on the HTTPS Auchan origin.");
    }
    const indexText = await this.getRequiredText(sitemapIndex, MAX_SITEMAP_BYTES);
    const sitemapUrls = productSitemaps(indexText, this.baseUrl);
    if (!sitemapUrls.length) throw new Error("No same-site product sitemaps were declared.");

    let sitemapReads = 0;
    let productUrlsScanned = 0;
    let sampledSitemapUrl: string | null = null;
    const sampledUrls: string[] = [];
    for (const sitemapUrl of sitemapUrls) {
      const sitemapText = await this.getRequiredText(new URL(sitemapUrl), MAX_SITEMAP_BYTES);
      const urls = locationValues(sitemapText)
        .map((location) => validProductUrl(location, this.baseUrl))
        .filter((url): url is string => url !== null);
      const uniqueUrls = [...new Set(urls)].sort((left, right) => left.localeCompare(right));
      sitemapReads += 1;
      const localOffset = Math.max(0, inputOffset - productUrlsScanned);
      if (localOffset < uniqueUrls.length && sampledUrls.length < pageBudget - stabilityTarget) {
        sampledSitemapUrl ??= sitemapUrl;
        sampledUrls.push(
          ...uniqueUrls.slice(
            localOffset,
            localOffset + pageBudget - stabilityTarget - sampledUrls.length,
          ),
        );
      }
      productUrlsScanned += uniqueUrls.length;
      if (sampledUrls.length >= pageBudget - stabilityTarget) break;
    }

    const selectedUrls = [...new Set(sampledUrls)];
    const robotsAllowsProductPages = selectedUrls.length > 0
      ? auchanRobotsAllowsPath(this.robotsText, new URL(selectedUrls[0]!).pathname)
      : false;
    if (selectedUrls.length && !robotsAllowsProductPages) {
      throw new Error("robots.txt disallows the selected product path; no product pages were requested.");
    }

    const firstPassAttempts: AuchanPageAttempt[] = [];
    let stoppedReason: string | null = null;
    let consecutiveNetworkErrors = 0;
    for (const url of selectedUrls) {
      if (firstPassAttempts.length) await this.delay();
      const attempt = await this.readProductPage(url);
      firstPassAttempts.push(attempt);
      if (attempt.outcome === "network_error") {
        consecutiveNetworkErrors += 1;
        if (consecutiveNetworkErrors >= 3) {
          stoppedReason = "Stopped after three consecutive network errors.";
          break;
        }
      } else {
        consecutiveNetworkErrors = 0;
      }
      if (attempt.outcome === "blocked") {
        stoppedReason = "Stopped on a block or anti-bot challenge; no workaround was attempted.";
        break;
      }
      if (attempt.outcome === "request_budget_exhausted") {
        stoppedReason = "Stopped at the configured product-page request budget.";
        break;
      }
    }

    const stability = await this.verifyIdStability(
      firstPassAttempts,
      stabilityTarget,
      stoppedReason !== null,
      pageBudget,
    );
    return {
      robotsUrl: robotsUrl.toString(),
      robotsAllowsProductPages,
      sitemapIndexUrl: sitemapIndex.toString(),
      productSitemaps: sitemapUrls,
      productSitemapsRead: sitemapReads,
      productUrlsScanned,
      startOffset: inputOffset,
      sampledSitemapUrl,
      sampledProductUrls: selectedUrls,
      firstPassAttempts,
      stability,
      stoppedReason,
      productPageRequests: this.productPageRequests - startRequests,
    };
  }

  private async getRequiredText(url: URL, maximumBytes: number): Promise<string> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/plain,application/xml,text/html;q=0.9,*/*;q=0.8",
        "user-agent": "CabazAuchanPublicDryRun/1.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new Error(`GET ${url.pathname} failed with HTTP ${response.status}.`);
    }
    return readLimitedText(response, maximumBytes);
  }

  private async readProductPage(
    inputUrl: string,
    redirectDepth = 0,
  ): Promise<AuchanPageAttempt> {
    const safeUrl = validProductUrl(inputUrl, this.baseUrl);
    if (!safeUrl) {
      return {
        url: inputUrl,
        outcome: "invalid_page",
        status: null,
        redirectLocation: null,
        observation: null,
        error: "unsafe_product_url",
      };
    }
    if (!auchanRobotsAllowsPath(this.robotsText, new URL(safeUrl).pathname)) {
      return {
        url: safeUrl,
        outcome: "blocked",
        status: null,
        redirectLocation: null,
        observation: null,
        error: "robots_disallow",
      };
    }
    if (this.productPageRequests >= this.maxProductPageRequests) {
      return {
        url: safeUrl,
        outcome: "request_budget_exhausted",
        status: null,
        redirectLocation: null,
        observation: null,
        error: "product_page_request_budget_exceeded",
      };
    }
    this.productPageRequests += 1;
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(safeUrl), {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "user-agent": "CabazAuchanPublicDryRun/1.0",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      return {
        url: safeUrl,
        outcome: "network_error",
        status: null,
        redirectLocation: null,
        observation: null,
        error: cause instanceof Error ? cause.name : "network_error",
      };
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      let target: string | null = null;
      if (location) {
        try {
          target = validProductUrl(new URL(location, safeUrl).toString(), this.baseUrl);
        } catch {
          target = null;
        }
      }
      const sameProduct = target !== null &&
        productIdFromUrl(target) === productIdFromUrl(safeUrl);
      if (sameProduct && redirectDepth < MAX_PRODUCT_REDIRECTS) {
        await this.delay();
        const followed = await this.readProductPage(target!, redirectDepth + 1);
        return {
          ...followed,
          url: safeUrl,
          redirectLocation: target,
          observation: followed.observation
            ? { ...followed.observation, sourceReference: safeUrl }
            : null,
        };
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
      const body = await readLimitedText(response, 8 * 1024).catch(() => "");
      const blocked = [401, 403, 429].includes(response.status) || isChallengePage(body);
      return {
        url: safeUrl,
        outcome: blocked ? "blocked" : "http_error",
        status: response.status,
        redirectLocation: null,
        observation: null,
        error: `HTTP ${response.status}`,
      };
    }

    let html: string;
    try {
      html = await readLimitedText(response, MAX_PRODUCT_HTML_BYTES);
    } catch (cause) {
      return {
        url: safeUrl,
        outcome: "invalid_page",
        status: response.status,
        redirectLocation: null,
        observation: null,
        error: cause instanceof Error ? cause.message : "invalid_html",
      };
    }
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
    const parsed = parseAuchanProductHtml(html, safeUrl, this.now());
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
  }

  private async verifyIdStability(
    firstPass: readonly AuchanPageAttempt[],
    target: number,
    blocked: boolean,
    pageBudget: number,
  ): Promise<AuchanIdStability> {
    if (blocked || target === 0) {
      return { target, attempted: 0, stable: 0, changed: 0, failed: 0, details: [] };
    }
    const seen = new Set<string>();
    const candidates: AuchanProductObservation[] = [];
    for (const attempt of firstPass) {
      const observation = attempt.observation;
      if (!observation?.externalProductId || seen.has(observation.externalProductId)) continue;
      seen.add(observation.externalProductId);
      candidates.push(observation);
    }
    const details: AuchanIdStability["details"][number][] = [];
    let stable = 0;
    let changed = 0;
    let failed = 0;
    for (const observation of candidates.slice(0, target)) {
      await this.delay();
      const second = await this.readProductPage(observation.sourceReference);
      const secondId = second.observation?.externalProductId ?? null;
      const isStable = second.outcome === "product" &&
        secondId === observation.externalProductId &&
        second.observation?.sku === observation.sku &&
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
      if (
        second.outcome === "blocked" ||
        second.outcome === "request_budget_exhausted" ||
        this.productPageRequests >= pageBudget
      ) break;
    }
    return { target, attempted: details.length, stable, changed, failed, details };
  }

  private async delay(): Promise<void> {
    if (!this.requestDelayMs) return;
    await new Promise((resolve) => setTimeout(resolve, this.requestDelayMs));
  }
}