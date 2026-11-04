import type { Readable } from "node:stream";

/** LF-only JSONL with bounded records, preserving fragmented UTF-8 and U+2028. */
export function readJsonLines(
  input: Readable,
  onValue: (value: unknown) => void,
  onFailure: () => void,
  maxBytes = 4 * 1024 * 1024,
) {
  let parts: Buffer[] = [],
    size = 0,
    closed = false;
  const fail = () => {
    if (!closed) {
      cleanup();
      onFailure();
    }
  };
  const data = (chunk: Buffer) => {
    let start = 0;
    while (!closed && start < chunk.length) {
      const newline = chunk.indexOf(10, start),
        end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      size += part.length;
      if (size > maxBytes) {
        fail();
        return;
      }
      parts.push(part);
      if (newline < 0) return;
      const line = Buffer.concat(parts, size)
        .toString("utf8")
        .replace(/\r$/, "");
      parts = [];
      size = 0;
      if (line.trim()) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          fail();
          return;
        }
        onValue(value);
      }
      start = end + 1;
    }
  };
  // EOF without a prior terminal event is connection loss, even after a full LF.
  const end = () => fail();
  function cleanup() {
    closed = true;
    input.off("data", data);
    input.off("end", end);
    input.off("error", fail);
    parts = [];
    size = 0;
  }
  input.on("data", data);
  input.on("end", end);
  input.on("error", fail);
  return cleanup;
}
