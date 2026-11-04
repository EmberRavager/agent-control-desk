import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readJsonLines } from "../packages/core/adapters/json-lines.js";

test("native JSONL preserves byte-split UTF8, U+2028 and CRLF; a clean terminal can detach EOF", () => {
  const stream = new PassThrough(),
    values: unknown[] = [];
  let failures = 0;
  const stop = readJsonLines(
    stream,
    (value) => values.push(value),
    () => failures++,
  );
  const input = Buffer.from('{"text":"你好\u2028world"}\r\n\n');
  for (const byte of input) stream.write(Buffer.from([byte]));
  assert.deepEqual(values, [{ text: "你好\u2028world" }]);
  stop();
  stream.end();
  assert.equal(failures, 0);
});

test("native JSONL rejects malformed, oversized and incomplete records once, including EOF without a terminal", async () => {
  for (const input of [
    "{bad}\n",
    '{"text":"oversized"}\n',
    '{"n":1}',
    '{"n":1}\n',
  ]) {
    const stream = new PassThrough();
    let failures = 0;
    readJsonLines(
      stream,
      () => {},
      () => failures++,
      input.includes("oversized") ? 8 : 100,
    );
    stream.end(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(failures, 1, input);
    stream.emit("data", Buffer.from("{bad}\n"));
    assert.equal(failures, 1);
  }
});
