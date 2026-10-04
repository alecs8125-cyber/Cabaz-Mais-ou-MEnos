export interface ContinenteDailyOptions {
  readonly limit: number;
  readonly resume: boolean;
  readonly commit: boolean;
}

export function parseContinenteDailyOptions(
  args: readonly string[],
): ContinenteDailyOptions {
  const flags = args.filter((arg) => arg !== "--");
  if (new Set(flags).size !== flags.length) {
    throw new Error("Duplicate daily sync flags are not allowed.");
  }
  const limitFlags = flags.filter((arg) => arg.startsWith("--limit="));
  if (limitFlags.length > 1) throw new Error("Repeated --limit.");
  if (flags.some((arg) =>
    arg !== "--resume" &&
    arg !== "--commit" &&
    arg !== "--dry-run" &&
    !/^--limit=\d+$/.test(arg)
  )) {
    throw new Error("Use optional --limit=1..100, --resume, and either --commit or --dry-run.");
  }
  if (flags.includes("--commit") && flags.includes("--dry-run")) {
    throw new Error("--commit and --dry-run are mutually exclusive.");
  }
  const limit = limitFlags.length ? Number(limitFlags[0]!.split("=")[1]) : 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100.");
  }
  const commit = flags.includes("--commit");
  const resume = flags.includes("--resume");
  if (commit && !resume) throw new Error("--commit requires --resume.");
  return { limit, resume, commit };
}