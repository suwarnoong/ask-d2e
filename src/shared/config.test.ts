import { test } from "node:test";
import assert from "node:assert/strict";
import { required, optional, parseWebhooks, positiveNumber, taskModel } from "./config.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("required returns trimmed value when set", () => {
  withEnv({ FOO: "  bar  " }, () => {
    assert.equal(required("FOO"), "bar");
  });
});

test("required throws when missing", () => {
  withEnv({ FOO: undefined }, () => {
    assert.throws(() => required("FOO"), /Missing required environment variable: FOO/);
  });
});

test("required throws when empty/whitespace", () => {
  withEnv({ FOO: "   " }, () => {
    assert.throws(() => required("FOO"), /Missing required environment variable: FOO/);
  });
});

test("optional returns fallback when unset", () => {
  withEnv({ FOO: undefined }, () => {
    assert.equal(optional("FOO", "fallback"), "fallback");
  });
});

test("optional returns trimmed value when set", () => {
  withEnv({ FOO: " val " }, () => {
    assert.equal(optional("FOO", "fallback"), "val");
  });
});

test("parseWebhooks splits on commas and newlines and trims", () => {
  assert.deepEqual(
    parseWebhooks("https://a\nhttps://b, https://c"),
    ["https://a", "https://b", "https://c"],
  );
});

test("parseWebhooks throws on empty result", () => {
  assert.throws(() => parseWebhooks("   ,\n  "), /must contain at least one URL/);
});

test("positiveNumber parses a valid override", () => {
  withEnv({ N: "42" }, () => {
    assert.equal(positiveNumber("N", "10"), 42);
  });
});

test("positiveNumber uses fallback when unset", () => {
  withEnv({ N: undefined }, () => {
    assert.equal(positiveNumber("N", "10"), 10);
  });
});

test("positiveNumber throws on non-finite or non-positive", () => {
  withEnv({ N: "-1" }, () => {
    assert.throws(() => positiveNumber("N", "10"), /must be a positive number/);
  });
  withEnv({ N: "not-a-number" }, () => {
    assert.throws(() => positiveNumber("N", "10"), /must be a positive number/);
  });
});

test("taskModel prefers task-specific env, then CLAUDE_MODEL, then fallback", () => {
  withEnv({ REFRESH_MODEL: "task-model", CLAUDE_MODEL: "shared-model" }, () => {
    assert.equal(taskModel("REFRESH_MODEL", "hardcoded"), "task-model");
  });
  withEnv({ REFRESH_MODEL: undefined, CLAUDE_MODEL: "shared-model" }, () => {
    assert.equal(taskModel("REFRESH_MODEL", "hardcoded"), "shared-model");
  });
  withEnv({ REFRESH_MODEL: undefined, CLAUDE_MODEL: undefined }, () => {
    assert.equal(taskModel("REFRESH_MODEL", "hardcoded"), "hardcoded");
  });
});
