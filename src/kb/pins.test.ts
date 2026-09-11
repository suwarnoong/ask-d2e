import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAtlas3Pin, extractTrexPin, extractPins } from "./pins.js";

// Captured verbatim from the real tags on 2026-09-11.
const ATLAS_DEVELOP = JSON.stringify({ dependencies: { "@ohdsi/atlas3": "0.1.0-20260823112941-269a00a" } });
const ATLAS_V0181 = JSON.stringify({ dependencies: { "@ohdsi/atlas3": "0.1.0-20260817035540-9baa99a" } });
const ATLAS_V0171 = JSON.stringify({ dependencies: { "@ohdsi/atlas3": "0.1.0-20260707025242-3a0f3f3" } });
const ATLAS_NO_PIN = JSON.stringify({ dependencies: { react: "^18.0.0" } });

const TREX_DEVELOP = [
  "FROM ghcr.io/ohdsi/trexsql:${TREXSQL_REF} AS base",
  "ARG TREXSQL_REF=prod-sha-5ce42757279f969bca123f0128a5c967ff2e3bd4@sha256:e162d8282df32231b58297fd31fef8567272468c86a82c64d36ec76d0de0d6ca",
].join("\n");

const TREX_V0181 = [
  "FROM ghcr.io/ohdsi/trexsql:sha-dec4a9508dcc57597c64422d6a27a36daaf74e27@sha256:d7922fb4fa63aa3e74e5341df17552e5bd32d0b0af86882172528c9f9b5be9d9 AS base",
].join("\n");

const TREX_V016 = ["ENV TREXSQL_EXT_VERSION=0.2.3", "ENV TREXAS_PORT=9876"].join("\n");

test("extractAtlas3Pin reads the short commit from the version suffix", () => {
  assert.equal(extractAtlas3Pin(ATLAS_DEVELOP), "269a00a");
  assert.equal(extractAtlas3Pin(ATLAS_V0181), "9baa99a");
  assert.equal(extractAtlas3Pin(ATLAS_V0171), "3a0f3f3");
});

test("extractAtlas3Pin throws, naming the package, when the pin is absent", () => {
  assert.throws(() => extractAtlas3Pin(ATLAS_NO_PIN), /@ohdsi\/atlas3/);
});

test("extractAtlas3Pin throws on unparseable JSON rather than guessing", () => {
  assert.throws(() => extractAtlas3Pin("{ not json"), /parse/i);
});

test("extractAtlas3Pin throws on an unrecognised version format", () => {
  const raw = JSON.stringify({ dependencies: { "@ohdsi/atlas3": "latest" } });
  assert.throws(() => extractAtlas3Pin(raw), /unrecognised/i);
});

test("extractTrexPin reads the ARG form, including a target prefix", () => {
  assert.equal(extractTrexPin(TREX_DEVELOP), "5ce4275");
});

test("extractTrexPin reads the hardcoded FROM form", () => {
  assert.equal(extractTrexPin(TREX_V0181), "dec4a95");
});

test("extractTrexPin prefers the ARG when both forms are present", () => {
  const both = [TREX_DEVELOP, TREX_V0181].join("\n");
  assert.equal(extractTrexPin(both), "5ce4275");
});

test("extractTrexPin throws when the file pins no trexsql image at all", () => {
  assert.throws(() => extractTrexPin(TREX_V016), /trexsql/i);
});

test("extractPins returns both pins", () => {
  assert.deepEqual(extractPins({ atlasPackageJson: ATLAS_V0181, trexDockerfile: TREX_V0181 }), {
    atlas3: "9baa99a",
    trex: "dec4a95",
  });
});

test("extractPins propagates a failure rather than returning a partial pair", () => {
  assert.throws(() => extractPins({ atlasPackageJson: ATLAS_NO_PIN, trexDockerfile: TREX_V0181 }));
});
