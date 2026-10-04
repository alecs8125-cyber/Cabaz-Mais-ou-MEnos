export interface ContinenteFreshnessPolicy {
  readonly maximumAgeMs: number;
}

export interface ContinenteFreshnessResult {
  readonly fresh: boolean;
  readonly ageMs: number | null;
  readonly reason: "within_policy" | "too_old" | "invalid_timestamp";
}

export function createContinenteFreshnessPolicy(
  maximumAgeMs: number,
): ContinenteFreshnessPolicy {
  if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs <= 0) {
    throw new Error("maximumAgeMs must be a positive safe integer.");
  }
  return { maximumAgeMs };
}

/** Evaluates capture age only; it never invents a source valid-until timestamp. */
export function evaluateContinenteFreshness(
  capturedAt: string,
  now: Date,
  policy: ContinenteFreshnessPolicy,
): ContinenteFreshnessResult {
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs) || !Number.isFinite(now.getTime())) {
    return { fresh: false, ageMs: null, reason: "invalid_timestamp" };
  }
  const ageMs = now.getTime() - capturedMs;
  if (ageMs < 0 || ageMs > policy.maximumAgeMs) {
    return { fresh: false, ageMs, reason: "too_old" };
  }
  return { fresh: true, ageMs, reason: "within_policy" };
}