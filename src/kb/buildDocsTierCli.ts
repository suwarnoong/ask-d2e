import { buildDocsTier } from "./buildDocsTier.js";
import { required, optional } from "../shared/config.js";

const result = buildDocsTier({
  docsRoot: required("DOCS_ROOT"),
  kbRoot: required("KB_ROOT"),
  snapshotId: optional("SNAPSHOT_ID", "develop"),
});

console.log(
  `Wrote ${result.docsWritten} docs, ${result.troubleshootingEntries} troubleshooting entries, ` +
    `${result.manifestEntries} manifest entries to ${result.outputDir}`,
);

if (result.docsWritten === 0) {
  console.error("No docs were found — check DOCS_ROOT.");
  process.exit(1);
}
