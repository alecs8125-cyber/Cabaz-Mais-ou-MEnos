import { AuchanAdapter } from "./services/price-import/auchan-adapter.js";
import {
  createSupabaseAuchanReadClient,
  SupabaseAuchanMappingRepository,
} from "./services/price-import/supabase-auchan-read.js";
import { SupabaseContinenteProductCatalog } from "./services/price-import/supabase-continente-catalog.js";
import { runAuchanDailySync } from "./services/price-import/auchan-sync-daily.js";
import { SupabaseAuchanSyncRepository } from "./services/price-import/supabase-auchan-sync-repository.js";

function readLimit(args: readonly string[]): number {
  const argument = args.find((value) => value.startsWith("--limit="));
  if (!argument) return 100;
  const limit = Number(argument.slice("--limit=".length));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer between 1 and 100.");
  }
  return limit;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const allowed = args.every((value) =>
    value === "--resume" ||
    value === "--commit" ||
    value === "--dry-run" ||
    /^--limit=\d+$/.test(value)
  );
  if (!allowed) {
    throw new Error("Supported arguments are --limit=N, --resume, --dry-run, and --commit.");
  }
  const commit = args.includes("--commit");
  const dryRun = args.includes("--dry-run");
  if (commit && dryRun) throw new Error("Choose either --commit or --dry-run, not both.");
  const limit = readLimit(args);
  const resume = args.includes("--resume");
  if (commit && !resume) {
    throw new Error("Auchan daily commits require --resume; manual offsets are not supported.");
  }

  const repository = new SupabaseAuchanSyncRepository(commit);
  const readClient = createSupabaseAuchanReadClient();
  const adapter = new AuchanAdapter({
    maxProductPageRequests: limit * 2,
  });
  const report = await runAuchanDailySync(
    repository,
    adapter,
    new SupabaseContinenteProductCatalog(readClient),
    new SupabaseAuchanMappingRepository(readClient),
    { limit, resume, commit },
  );
  console.log(JSON.stringify({
    execution: report.ok
      ? commit ? "auchan-daily-bounded-commit" : "auchan-daily-read-only-dry-run"
      : commit ? "auchan-daily-commit-blocked" : "auchan-daily-dry-run-blocked",
    ...report,
    requestPolicy: {
      websiteRequests: "GET only; no cookies or postal-code setter requests",
      pageRequestBudget: report.productPageRequestBudget,
      globalProductLimit: limit,
      maximumWriteSublot: 20,
      priceWritePath: "upsert_auchan_reference_price_with_history only",
      storeCreationAllowed: false,
      sqlExecuted: false,
    },
  }, null, 2));
  if (!report.ok) process.exitCode = 2;
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Unexpected Auchan daily sync error.";
  console.error(
    `Auchan daily sync stopped: ${message.replace(/https?:\/\/\S+/gi, "[source URL]")}`,
  );
  process.exitCode = 1;
});