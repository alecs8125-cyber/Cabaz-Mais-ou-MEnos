import {
  createSupabasePriceCoverageReadClient,
  readPriceCoverageAuditInput,
} from "./services/price-import/supabase-price-coverage-read.js";
import { buildPriceSourceHealthReport } from "./services/price-import/price-source-health.js";
import {
  createSupabasePriceSourceHealthReadClient,
  readPriceSourceHealthData,
} from "./services/price-import/supabase-price-source-health-read.js";

async function main(): Promise<void> {
  const auditInput = await readPriceCoverageAuditInput(
    createSupabasePriceCoverageReadClient(),
  );
  const healthClient = createSupabasePriceSourceHealthReadClient();
  const readResult = await readPriceSourceHealthData(healthClient);
  const asOf = new Date();
  const report = buildPriceSourceHealthReport(
    auditInput.stores,
    auditInput.prices,
    readResult,
    asOf,
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.sources.every((source) => source.ok)) process.exitCode = 2;
}

main().catch((error: unknown) => {
  const message = error instanceof Error
    ? error.message
    : "Unexpected read-only price source health check failure.";
  console.error(`Price source health check stopped: ${message}`);
  process.exitCode = 1;
});
