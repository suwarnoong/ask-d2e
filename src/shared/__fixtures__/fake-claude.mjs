#!/usr/bin/env node
const mode = process.env.FAKE_CLAUDE_MODE ?? "success";

let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (mode === "hang") {
    setInterval(() => {}, 1000); // keep the event loop alive — never exits on its own, caller must kill it
    return;
  }
  if (mode === "nonzero") {
    process.stderr.write("simulated claude CLI failure");
    process.exit(1);
  }
  if (mode === "badjson") {
    process.stdout.write("not json at all");
    process.exit(0);
  }
  if (mode === "missing-result") {
    process.stdout.write(JSON.stringify({ ok: true }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ result: `echo:${input}` }));
  process.exit(0);
});
