import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readRawBody } from "./rawBody.js";

function fakeReq(chunks: string[]): EventEmitter {
  const emitter = new EventEmitter();
  queueMicrotask(() => {
    for (const c of chunks) emitter.emit("data", Buffer.from(c));
    emitter.emit("end");
  });
  return emitter;
}

test("readRawBody concatenates chunks into the exact original body string", async () => {
  const req = fakeReq(['{"type": "event_callback", ', '"event": {"text": "hi"}}']);
  const body = await readRawBody(req as any);
  assert.equal(body, '{"type": "event_callback", "event": {"text": "hi"}}');
});

test("readRawBody preserves exact spacing/formatting (no re-serialization)", async () => {
  const raw = 'token=abc&text=how%20does%20it%20work';
  const req = fakeReq([raw]);
  const body = await readRawBody(req as any);
  assert.equal(body, raw);
});

test("readRawBody rejects on stream error", async () => {
  const emitter = new EventEmitter();
  queueMicrotask(() => emitter.emit("error", new Error("boom")));
  await assert.rejects(() => readRawBody(emitter as any), /boom/);
});
