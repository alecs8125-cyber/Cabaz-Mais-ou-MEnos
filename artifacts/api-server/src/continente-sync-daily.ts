import { ContinenteAdapter } from "./services/price-import/continente-adapter.js";
import { parseContinenteDailyOptions } from "./services/price-import/continente-sync-daily-options.js";
import {
  runContinenteDailySync,
} from "./services/price-import/continente-sync-daily.js";
import {
  SupabaseContinenteSyncRepository,
} from "./services/price-import/continente-sync-repository.js";

async function main(): Promise<void> {
  const options = parseContinenteDailyOptions(process.argv.slice(2));
  const repository = new SupabaseContinenteSyncRepository(options.commit);
  const adapter = new ContinenteAdapter({
    maxProductPageRequests: options.limit * (options.commit ? 3 : 1),
  });
  const report = await runContinenteDailySync(options, repository, adapter);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((cause) => {
  const message = cause instanceof Error ? cause.message : "Unexpected Continente daily sync error.";
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});