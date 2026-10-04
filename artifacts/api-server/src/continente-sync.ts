import { ContinenteAdapter } from "./services/price-import/continente-adapter.js";
import { parseContinenteSyncOptions } from "./services/price-import/continente-sync-options.js";
import { SupabaseContinenteSyncRepository } from "./services/price-import/continente-sync-repository.js";
import { syncContinenteObservations } from "./services/price-import/continente-sync.js";

async function main(): Promise<void> {
  const options = parseContinenteSyncOptions(process.argv.slice(2));
  const repository = new SupabaseContinenteSyncRepository(options.commit);
  if (options.commit) {
    const preflight = await repository.preflight();
    if (preflight.blockers.length) throw new Error(`Commit blocked before crawling/writing: ${preflight.blockers.join(" ")}`);
  }
  const audit = await new ContinenteAdapter().runAudit(options.limit, Math.min(20, options.limit), options.offset);
  const expectedRereads = Math.min(20, new Set(audit.firstPassAttempts.flatMap(
    (attempt) => attempt.observation?.externalProductId ? [attempt.observation.externalProductId] : [],
  )).size);
  if (audit.stoppedReason || audit.stability.changed || audit.stability.failed ||
      expectedRereads === 0 || audit.stability.attempted < expectedRereads) {
    throw new Error("Crawl blocked or identity reread incomplete/unstable; no synchronization writes performed.");
  }
  const observations = audit.firstPassAttempts.flatMap((attempt) => attempt.observation ? [attempt.observation] : []);
  const report = await syncContinenteObservations(observations, repository);
  console.log(JSON.stringify({
    ...report, requested: options.limit, offset: options.offset,
    crawl: {
      pages: audit.firstPassAttempts.length, stableIds: audit.stability.stable,
      outcomes: audit.firstPassAttempts.map((attempt) => ({ url: attempt.url, outcome: attempt.outcome })),
    },
  }, null, 2));
  if (report.counts.errors || (options.commit && report.blockers.length)) process.exitCode = 2;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Continente sync failed.");
  process.exitCode = 1;
});