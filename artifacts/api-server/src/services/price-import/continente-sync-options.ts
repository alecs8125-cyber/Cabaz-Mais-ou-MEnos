export interface ContinenteSyncOptions {
  readonly commit: boolean;
  readonly limit: number;
  readonly offset: number;
}

export function parseContinenteSyncOptions(args: readonly string[]): ContinenteSyncOptions {
  const flags = args.filter((arg) => arg !== "--");
  if (new Set(flags).size !== flags.length ||
      flags.some((arg) => arg !== "--commit" && !/^--(?:limit|offset)=/.test(arg))) {
    throw new Error("Use only --limit=N, --offset=N and optional --commit.");
  }
  const read = (name: string, fallback: number) => {
    const values = flags.filter((arg) => arg.startsWith(`--${name}=`));
    if (values.length > 1) throw new Error(`Repeated --${name}.`);
    const value = values.length ? Number(values[0]!.split("=")[1]) : fallback;
    if (!Number.isSafeInteger(value) || value < (name === "limit" ? 1 : 0)) {
      throw new Error(`Invalid --${name}.`);
    }
    return value;
  };
  const commit = flags.includes("--commit");
  const limit = read("limit", 20);
  const offset = read("offset", 0);
  if (limit > 200) throw new Error("--limit cannot exceed 200.");
  // No default batch can ever write: both bounds must be deliberately supplied.
  if (commit && (limit > 20 || !flags.some((arg) => arg.startsWith("--limit=")) ||
      !flags.some((arg) => arg.startsWith("--offset=")))) {
    throw new Error("Commit requires explicit --limit=1..20 and --offset=N.");
  }
  return { commit, limit, offset };
}