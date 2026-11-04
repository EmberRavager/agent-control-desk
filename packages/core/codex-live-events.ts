import { translate } from "../i18n/index.cjs";
import type { Locale } from "../contracts/index.js";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { AgentConnection, NativeSession } from "../contracts/index.js";
import type { NativeReadResult } from "./native-observation.js";
import {
  emptyNativeContext,
  publicNativeContext,
  type NativeActivityContext,
} from "./native-context.js";
import { applyCodexRunEvent, type CodexRunEvents } from "./codex-run-events.js";

export interface OpenCodexRecord {
  path: string;
  pid: number;
}
export function parseOpenCodexRecords(output: string): OpenCodexRecord[] {
  let pid = 0,
    command = "",
    access = "";
  const result: OpenCodexRecord[] = [];
  for (const field of output.split("\0")) {
    const token = field.replace(/^\n+/, "");
    const value = token.slice(1);
    switch (token[0]) {
      case "p":
        pid = Number(value);
        command = "";
        break;
      case "c":
        command = value;
        break;
      case "f":
        access = "";
        break;
      case "a":
        access = value;
        break;
      case "n":
        if (
          /^(codex|ChatGPT)/i.test(command) &&
          ["w", "u"].includes(access) &&
          Number.isSafeInteger(pid) &&
          pid > 0 &&
          /^rollout-.*\.jsonl$/.test(basename(value))
        )
          result.push({ path: value, pid });
        break;
    }
  }
  return result;
}
export async function openCodexRecords(
  signal: AbortSignal,
): Promise<OpenCodexRecord[]> {
  if (process.platform === "win32")
    throw Error("当前 Windows 版本尚未接入执行记录的进程核验");
  const uid = process.getuid?.();
  if (uid === undefined) throw Error("无法核验执行记录所属用户");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "lsof",
      [
        "-nP",
        "-F0pcfan",
        "-a",
        "-u",
        String(uid),
        "-c",
        "codex",
        "-c",
        "ChatGPT",
      ],
      { signal, timeout: 4000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (!error || (error as { code?: string | number }).code === 1)
          resolve(stdout);
        else reject(Error("无法核验 Codex 执行记录的写入进程"));
      },
    );
  });
  return parseOpenCodexRecords(output);
}

type RequestRange = { start: number; end: number; hash: string };
type TurnOffsets = {
  offset: number;
  turnStart?: number;
  requestRange?: RequestRange;
  requestRanges?: RequestRange[];
};
type Cursor = TurnOffsets & {
  dev: number;
  ino: number;
  completed?: (TurnOffsets & { turnId: string })[];
  state?: CodexRunEvents;
};
/** Incremental projection. The cache retains offsets and runtime fields, never record bodies. */
export class CodexRunEventReader {
  private cursors = new Map<string, Cursor>();
  private reading = new Map<string, Promise<CodexRunEvents>>();
  read(
    path: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<CodexRunEvents> {
    const current = this.reading.get(path);
    if (current)
      return current.then((state) => {
        signal.throwIfAborted();
        if (state.sessionId !== sessionId) throw Error("会话标识不一致");
        return { ...state };
      });
    const pending = this.project(path, sessionId, signal).finally(() =>
      this.reading.delete(path),
    );
    this.reading.set(path, pending);
    return pending;
  }
  private async project(
    path: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<CodexRunEvents> {
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw Error("执行记录不是普通文件");
      const before = this.cursors.get(path);
      const cursor: Cursor =
        before &&
        before.state?.sessionId === sessionId &&
        before.dev === stat.dev &&
        before.ino === stat.ino &&
        before.offset <= stat.size
          ? { ...before }
          : { dev: stat.dev, ino: stat.ino, offset: 0 };
      const buffer = Buffer.alloc(64 * 1024);
      let prefix = Buffer.alloc(0);
      let position = cursor.offset,
        parts: Buffer[] = [],
        bytes = 0,
        dropping = false;
      while (position < stat.size) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, stat.size - position),
          position,
        );
        if (!bytesRead) break;
        let start = 0;
        while (start < bytesRead) {
          const index = buffer.indexOf(10, start);
          const end = index < 0 || index >= bytesRead ? bytesRead : index;
          const part = buffer.subarray(start, end);
          if (prefix.length < 512)
            prefix = Buffer.concat([
              prefix,
              part.subarray(0, 512 - prefix.length),
            ]);
          if (!dropping) {
            bytes += part.length;
            if (bytes <= 512 * 1024) parts.push(Buffer.from(part));
            else {
              parts = [];
              dropping = true;
            }
          }
          if (end < bytesRead) {
            if (!dropping) {
              const line = Buffer.concat(parts).toString("utf8");
              if (
                /"type"\s*:\s*"(?:session_meta|event_msg)"/.test(
                  line.slice(0, 512),
                )
              ) {
                try {
                  JSON.parse(line);
                } catch {
                  if (cursor.state)
                    cursor.state = {
                      ...cursor.state,
                      status: "unknown",
                      progress: "执行事件不完整，状态待核验",
                    };
                }
                const previous = cursor.state;
                cursor.state = applyCodexRunEvent(
                  line,
                  sessionId,
                  cursor.state,
                );
                if (
                  cursor.state?.status === "running" &&
                  cursor.state.turnId !== previous?.turnId
                ) {
                  cursor.turnStart = cursor.offset;
                  cursor.requestRange = undefined;
                  cursor.requestRanges = [];
                } else if (
                  cursor.state?.status === "idle" &&
                  previous?.status !== "idle" &&
                  cursor.state.turnId &&
                  cursor.turnStart !== undefined
                ) {
                  const turnId = cursor.state.turnId;
                  cursor.completed = [
                    ...(cursor.completed || []).filter(
                      (turn) => turn.turnId !== turnId,
                    ),
                    {
                      turnId,
                      turnStart: cursor.turnStart,
                      offset: position + end + 1,
                      requestRange: cursor.requestRange,
                      requestRanges: cursor.requestRanges,
                    },
                  ].slice(-8);
                }
              }
              if (
                cursor.state?.status === "running" &&
                cursor.turnStart !== undefined &&
                /"(?:type|role)"\s*:\s*"(?:user_message|user)"/.test(line)
              ) {
                const request = publicNativeContext([line]).request;
                if (request) {
                  const range = {
                    start: cursor.offset,
                    end: position + end + 1,
                    hash: createHash("sha256").update(request).digest("hex"),
                  };
                  cursor.requestRange ||= range;
                  if (cursor.requestRanges?.at(-1)?.hash !== range.hash)
                    cursor.requestRanges = [
                      ...(cursor.requestRanges || []),
                      range,
                    ].slice(-3);
                }
              }
            } else if (
              cursor.state &&
              /"type"\s*:\s*"event_msg"/.test(prefix.toString("utf8"))
            ) {
              cursor.state = {
                ...cursor.state,
                status: "unknown",
                progress: "执行事件超过读取上限，状态待核验",
              };
            }
            parts = [];
            prefix = Buffer.alloc(0);
            bytes = 0;
            dropping = false;
            cursor.offset = position + end + 1;
          }
          start = end < bytesRead ? end + 1 : bytesRead;
        }
        position += bytesRead;
      }
      this.cursors.set(path, cursor);
      if (!cursor.state) throw Error("执行记录缺少可核验的会话标识");
      return { ...cursor.state };
    } finally {
      await file.close();
    }
  }
  async context(
    path: string,
    sessionId: string,
    turnId: string | undefined,
    signal: AbortSignal,
  ): Promise<NativeActivityContext> {
    const state = await this.read(path, sessionId, signal);
    const cursor = this.cursors.get(path);
    const completed = cursor?.completed?.find((turn) => turn.turnId === turnId);
    if (turnId && state.turnId !== turnId && !completed)
      throw Error("会话已进入新一轮执行，请刷新后重试。");
    const range =
      state.turnId === turnId && state.status === "running"
        ? cursor
        : (completed ?? cursor);
    if (!cursor || range?.turnStart === undefined) return emptyNativeContext();
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const stat = await file.stat();
      if (
        stat.dev !== cursor.dev ||
        stat.ino !== cursor.ino ||
        stat.size < cursor.offset
      )
        throw Error("会话记录已变化，请刷新后重试。");
      const end = range.offset;
      const start = Math.max(range.turnStart, end - 2 * 1024 * 1024);
      const length = Math.min(2 * 1024 * 1024, end - start);
      const buffer = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      signal.throwIfAborted();
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start > range.turnStart) lines.shift();
      lines.pop();
      const context = publicNativeContext(lines);
      // The original request is a stable anchor, independent of the moving
      // execution tail. Keep only its file range between observation polls.
      context.request = "";
      context.requests = [];
      const ranges = new Map(
        [range.requestRange, ...(range.requestRanges || [])]
          .filter((request) => request !== undefined)
          .map((request) => [request.start, request]),
      );
      for (const requestRange of ranges.values()) {
        if (
          requestRange.start < range.turnStart ||
          requestRange.end > end ||
          requestRange.end - requestRange.start > 256 * 1024
        )
          continue;
        const requestBuffer = Buffer.alloc(
          requestRange.end - requestRange.start,
        );
        const requestRead = await file.read(
          requestBuffer,
          0,
          requestBuffer.length,
          requestRange.start,
        );
        signal.throwIfAborted();
        if (requestRead.bytesRead !== requestBuffer.length) continue;
        const request = publicNativeContext([
          requestBuffer.toString("utf8").trimEnd(),
        ]).request;
        if (requestRange === range.requestRange) context.request = request;
        if (
          request &&
          range.requestRanges?.some(
            (recent) => recent.start === requestRange.start,
          )
        )
          context.requests.push(request);
      }
      context.truncated ||= start > range.turnStart || bytesRead < length;
      return context;
    } finally {
      await file.close();
    }
  }
  retain(paths: Set<string>) {
    for (const path of this.cursors.keys())
      if (!paths.has(path)) this.cursors.delete(path);
  }
}

const activityWindowMs = 5 * 60 * 1000;

type TrackedRecord = {
  path: string;
  sessionId: string;
  pid: number;
  seenAt: number;
  activeSeen: boolean;
  lastState?: CodexRunEvents;
};
export class CodexLiveEvents {
  private readonly reader = new CodexRunEventReader();
  private tracked = new Map<string, TrackedRecord>();
  constructor(
    private readonly root = join(homedir(), ".codex", "sessions"),
    private readonly list = openCodexRecords,
    private readonly alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    private readonly locale: () => Locale = () => "zh-CN",
  ) {}
  async context(
    sessionId: string,
    turnId: string | undefined,
  ): Promise<NativeActivityContext> {
    const record = [...this.tracked.values()].find(
      (item) => item.sessionId === sessionId && item.activeSeen,
    );
    if (!record) return emptyNativeContext();
    return this.reader.context(
      record.path,
      sessionId,
      turnId,
      new AbortController().signal,
    );
  }
  async read(
    agent: AgentConnection,
    _cwd: string,
    signal: AbortSignal,
  ): Promise<NativeReadResult> {
    const tr = (source: string, values?: Record<string, string | number>) =>
      translate(this.locale(), source, values);
    const records = await this.list(signal);
    const root = await realpath(this.root).catch(() => {
      throw Error(tr("本机未找到可核验的 Codex 执行记录目录"));
    });
    const now = Date.now();
    const writers = new Map<string, OpenCodexRecord>();
    for (const record of records) {
      const path = await realpath(record.path).catch(() => "");
      const part = relative(root, path);
      if (
        !path ||
        !part ||
        part === ".." ||
        part.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) ||
        isAbsolute(part)
      )
        continue;
      const match = basename(path).match(
        /-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i,
      );
      if (!match || !this.alive(record.pid)) continue;
      writers.set(path, record);
      if (!this.tracked.has(path))
        this.tracked.set(path, {
          path,
          sessionId: match[1],
          pid: record.pid,
          seenAt: now,
          activeSeen: false,
        });
    }
    const sessions: NativeSession[] = [],
      excludedSessionIds: string[] = [];
    let verified = 0;
    let failures = 0;
    for (const [path, tracked] of this.tracked) {
      if (
        !writers.has(path) &&
        (!tracked.activeSeen || now - tracked.seenAt > activityWindowMs)
      ) {
        this.tracked.delete(path);
        continue;
      }
      let state: CodexRunEvents;
      try {
        state = await this.reader.read(path, tracked.sessionId, signal);
      } catch {
        if (signal.aborted) signal.throwIfAborted();
        failures++;
        if (!tracked.activeSeen || !tracked.lastState) {
          this.tracked.delete(path);
          continue;
        }
        state = {
          ...tracked.lastState,
          status: "unknown",
          progress: tr("执行记录暂时不可读，状态待核验"),
        };
      }
      if (state.internal) {
        excludedSessionIds.push(
          "native-" +
            createHash("sha256")
              .update(agent.id + ":" + state.sessionId)
              .digest("hex")
              .slice(0, 24),
        );
        tracked.activeSeen = false;
        tracked.lastState = state;
        continue;
      }
      const completionObserved =
        Boolean(tracked.lastState) &&
        state.status === "idle" &&
        state.endedReason === "completed" &&
        Boolean(state.turnId) &&
        (tracked.lastState!.turnId !== state.turnId ||
          tracked.lastState!.status !== "idle");
      tracked.lastState = state;
      verified++;
      const writer = writers.get(path);
      const confirmed = writer && this.alive(writer.pid);
      const eventAge = now - Date.parse(state.eventAt || "");
      const recentActivity = eventAge >= 0 && eventAge <= activityWindowMs;
      if (
        ((state.status === "running" && recentActivity) ||
          completionObserved) &&
        confirmed
      ) {
        tracked.activeSeen = true;
      }
      if (
        confirmed &&
        tracked.activeSeen &&
        (state.status === "running" || completionObserved)
      )
        tracked.seenAt = now;
      if (state.status !== "running" && now - tracked.seenAt > activityWindowMs)
        tracked.activeSeen = false;
      if (!tracked.activeSeen) continue;
      const status =
        state.status === "running" && (!confirmed || !recentActivity)
          ? "unknown"
          : state.status;
      sessions.push({
        id:
          "native-" +
          createHash("sha256")
            .update(agent.id + ":" + state.sessionId)
            .digest("hex")
            .slice(0, 24),
        agentId: agent.id,
        sessionId: state.sessionId,
        turnId: state.turnId,
        title:
          "Codex · " +
          (basename(state.cwd) || tr("本机会话")) +
          " · " +
          state.sessionId.slice(-6),
        cwd: state.cwd,
        status,
        endedReason: state.endedReason,
        completionObserved,
        progress:
          state.status === "running" && status === "unknown"
            ? confirmed
              ? tr("缺少近期执行事件，当前状态待核验")
              : tr("未检测到写入进程，当前状态待核验")
            : tr(state.progress),
        observedAt: new Date().toISOString(),
        eventAt: state.eventAt,
      });
    }
    this.reader.retain(new Set(this.tracked.keys()));
    const verifiedSource = Boolean(
      verified &&
      !failures &&
      (writers.size ||
        sessions.some(
          (session) => session.status === "idle" && session.endedReason,
        )),
    );
    return {
      source: "run-events",
      state: verifiedSource ? "connected" : "unavailable",
      message:
        writers.size && verified
          ? tr(
              failures
                ? "部分执行记录未核验，已确认执行 {count} 个会话"
                : "已核验 Codex 执行记录，正在执行 {count} 个会话",
              {
                count: sessions.filter(
                  (session) => session.status === "running",
                ).length,
              },
            )
          : tr("未取得可核验的 Codex 当前执行记录"),
      sessions,
      excludedSessionIds,
    };
  }
}
