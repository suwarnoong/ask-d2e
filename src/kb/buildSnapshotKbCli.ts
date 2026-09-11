import { buildSnapshotKb } from "./buildSnapshotKb.js";
import { buildSharedContract } from "./buildSharedContract.js";
import { loadSnapshotRegistry } from "./snapshots.js";
import { required, optional, taskModel } from "../shared/config.js";

const kbRoot = required("KB_ROOT");
const snapshotId = required("SNAPSHOT_ID");
const entry = loadSnapshotRegistry(kbRoot).snapshots.find((s) => s.id === snapshotId);
if (!entry) throw new Error(`No snapshot "${snapshotId}" in snapshots.json`);

const auth = {
  claudeOauthToken: required("CLAUDE_CODE_OAUTH_TOKEN"),
  claudeModel: taskModel("SNAPSHOT_KB_MODEL", "claude-sonnet-4-5"),
};
const workRoot = required("WORK_ROOT");

const refs = {
  d2e: entry.isDevelop ? "develop" : entry.d2eTag,
  atlas3: entry.pins.atlas3,
  trex: entry.pins.trex,
};

const result = await buildSnapshotKb({ kbRoot, snapshotId, refs, auth, workRoot });
console.log(`Generated ${result.repos.map((r) => `${r.repoName}=${r.files}`).join(" ")}`);
console.log(`Manifest now indexes ${result.manifestEntries} files`);

if (optional("BUILD_SHARED_CONTRACT", "false") === "true") {
  const shared = await buildSharedContract({ kbRoot, workRoot, auth });
  console.log(`Contract tier: ${shared.files} files`);
}
