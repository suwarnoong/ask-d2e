import { buildSnapshot, readPinSources } from "./buildSnapshot.js";
import { required, optional } from "../shared/config.js";

const d2eRoot = required("D2E_ROOT");
const snapshotId = required("SNAPSHOT_ID");

const result = buildSnapshot({
  kbRoot: required("KB_ROOT"),
  snapshotId,
  d2eTag: optional("D2E_TAG", snapshotId),
  isDevelop: optional("IS_DEVELOP", "false") === "true",
  ...readPinSources(d2eRoot),
});

console.log(
  `Snapshot ${result.entry.id} (${result.entry.d2eTag}) pins atlas3=${result.entry.pins.atlas3} ` +
    `trex=${result.entry.pins.trex}`,
);
console.log(
  `Wrote ${result.docsWritten} docs, ${result.troubleshootingEntries} troubleshooting entries, ` +
    `${result.manifestEntries} manifest entries`,
);
