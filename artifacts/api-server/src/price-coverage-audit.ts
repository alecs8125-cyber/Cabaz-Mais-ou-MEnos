import { buildPriceCoverageAuditReport } from "./services/price-import/price-coverage-audit.js";
import {
  createSupabasePriceCoverageReadClient,
  readPriceCoverageAuditInput,
} from "./services/price-import/supabase-price-coverage-read.js";

async function main(): Promise<void> {
  const asOf = new Date();
  const client = createSupabasePriceCoverageReadClient();
  const input = await readPriceCoverageAuditInput(client);
  const report = buildPriceCoverageAuditReport(input, asOf);
  console.log(JSON.stringify(report, null, 2));
  if (
    !report.expectedScopes.continenteOnline.ok ||
    !report.expectedScopes.auchanAmadoraReference.ok
  ) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error
    ? error.message
    : "Unexpected read-only price coverage audit failure.";
  console.error(`Price coverage audit stopped: ${message}`);
  process.exitCode = 1;
});