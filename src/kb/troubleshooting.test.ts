import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTroubleshooting, buildTroubleshootingIndex, renderTroubleshootingIndex } from "./troubleshooting.js";

function doc(content: string, outPath = "2-admin_guide/cli.md") {
  return { outPath, sourcePath: outPath, title: "CLI", content };
}

const WITH_SECTION = [
  "# CLI",
  "",
  "Prose about the CLI.",
  "",
  "## Troubleshooting",
  "",
  "### `illegal hardware instruction` when running `./d2e`",
  "",
  "**Cause:** The binary does not match your system architecture.",
  "",
  "**Resolution:** Check your architecture and re-download the correct binary.",
  "",
  "### Port 8001 already in use",
  "",
  "**Cause:** Another process holds the port.",
  "",
  "**Resolution:** Stop the other process or change CADDY__PORT.",
  "",
  "## Next steps",
  "",
  "Unrelated content that must not be swept in.",
].join("\n");

test("extractTroubleshooting finds every symptom in the section", () => {
  const entries = extractTroubleshooting(doc(WITH_SECTION));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].symptom, "`illegal hardware instruction` when running `./d2e`");
  assert.match(entries[0].cause, /does not match your system architecture/);
  assert.match(entries[0].resolution, /re-download the correct binary/);
  assert.equal(entries[0].sourcePath, "2-admin_guide/cli.md");
});

test("extractTroubleshooting stops at the next h2", () => {
  const entries = extractTroubleshooting(doc(WITH_SECTION));
  assert.deepEqual(entries.map((e) => e.symptom), [
    "`illegal hardware instruction` when running `./d2e`",
    "Port 8001 already in use",
  ]);
  assert.ok(entries.every((e) => !/Unrelated content/.test(e.resolution)));
});

test("extractTroubleshooting returns nothing for a doc with no such section", () => {
  assert.deepEqual(extractTroubleshooting(doc("# CLI\n\nJust prose.")), []);
});

test("extractTroubleshooting matches the heading case-insensitively", () => {
  const content = ["## troubleshooting", "", "### Thing broke", "", "**Resolution:** Fix it."].join("\n");
  assert.equal(extractTroubleshooting(doc(content)).length, 1);
});

test("extractTroubleshooting accepts Fix as a synonym for Resolution", () => {
  const content = ["## Troubleshooting", "", "### Thing broke", "", "**Fix:** Turn it off and on."].join("\n");
  assert.match(extractTroubleshooting(doc(content))[0].resolution, /Turn it off and on/);
});

test("extractTroubleshooting keeps an entry that states no cause", () => {
  const content = ["## Troubleshooting", "", "### Thing broke", "", "**Resolution:** Fix it."].join("\n");
  const entries = extractTroubleshooting(doc(content));
  assert.equal(entries[0].cause, "");
  assert.match(entries[0].resolution, /Fix it/);
});

test("extractTroubleshooting falls back to the prose body when the entry uses no labels", () => {
  const content = [
    "## Troubleshooting",
    "",
    "### create-postgres-cdm-schemas fails to start",
    "",
    "- create-postgres-cdm-schemas requires the following containers:",
    "  - d2e-minerva-postgres-1, d2e-data-flow-gen-1",
    "- If it is not running, check the container logs",
  ].join("\n");
  const entry = extractTroubleshooting(doc(content))[0];
  assert.equal(entry.cause, "");
  assert.match(entry.resolution, /check the container logs/);
  assert.doesNotMatch(entry.resolution, /^-/);
});

test("extractTroubleshooting keeps label-less prose that merely contains bold emphasis", () => {
  const content = [
    "## Troubleshooting",
    "",
    "### Data flows",
    "",
    "- To check job logs, open https://localhost:443/portal/systemadmin/jobs > Select the job run > Select **Logs**.",
  ].join("\n");
  const entry = extractTroubleshooting(doc(content))[0];
  assert.match(entry.resolution, /Select the job run/);
  assert.match(entry.resolution, /Logs/);
});

test("buildTroubleshootingIndex merges across docs, sorted by symptom", () => {
  const a = doc(["## Troubleshooting", "", "### Zebra fails", "", "**Resolution:** z"].join("\n"), "a.md");
  const b = doc(["## Troubleshooting", "", "### Apple fails", "", "**Resolution:** a"].join("\n"), "b.md");
  const index = buildTroubleshootingIndex([a, b]);
  assert.deepEqual(index.map((e) => e.symptom), ["Apple fails", "Zebra fails"]);
});

test("renderTroubleshootingIndex emits each entry with its source path", () => {
  const rendered = renderTroubleshootingIndex(extractTroubleshooting(doc(WITH_SECTION)));
  assert.match(rendered, /TROUBLESHOOTING INDEX/);
  assert.match(rendered, /Port 8001 already in use/);
  assert.match(rendered, /2-admin_guide\/cli\.md/);
});

test("renderTroubleshootingIndex says so when there is nothing indexed", () => {
  assert.match(renderTroubleshootingIndex([]), /no troubleshooting entries/i);
});
