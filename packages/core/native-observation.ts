import { createInterface } from "node:readline";
import { internalCodexSource } from "./codex-run-events.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AgentConnection,
  AgentObservation,
  NativeSession,
} from "../contracts/index.js";
import type { Runtime } from "./runtime.js";
import { launch, terminate } from "./adapters/process.js";

const loadedSchema = z.object({
  data: z.array(z.string()),
  nextCursor: z.string().nullable().optional(),
});
const threadSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
    source: z.unknown().optional(),
    name: z.string().nullish(),
    cwd: z.string(),
    status: z.object({
      type: z.enum(["active", "idle", "notLoaded", "systemError"]),
      activeFlags: z.array(z.string()).optional(),
    }),
  }),
});
export interface NativeReadResult {
  excludedSessionIds?: string[];
  source: "runtime-api" | "run-events";
  state: "connected" | "unavailable";
  message: string;
  sessions: NativeSession[];
}
export type ReadNativeSessions = (
  agent: AgentConnection,
  cwd: string,
  signal: AbortSignal,
) => Promise<NativeReadResult>;

/** Only connects to an existing native server; never starts/resumes a thread. */
export async function readCodexSessions(
  agent: AgentConnection,
  cwd: string,
  signal: AbortSignal,
  launcher = launch,
): Promise<NativeReadResult> {
  signal.throwIfAborted();
  const proc = launcher(agent.executable, ["app-server", "proxy"], cwd);
  const lines = createInterface({ input: proc.stdout });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 0,
    buffered = 0,
    failure: Error | undefined;
  function fail(error: Error) {
    failure ||= error;
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  }
  const cancel = () => fail(Error("原生会话同步已取消"));
  signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => fail(Error("Codex 原生会话同步超时")), 8000);
  proc.stderr.resume();
  proc.on("error", () => fail(Error("无法启动 Codex 只读连接代理")));
  proc.on("exit", () =>
    fail(Error("Codex 未提供可连接的控制端点，原生会话尚未同步")),
  );
  proc.stdin.on("error", () => fail(Error("Codex 原生会话连接已断开")));
  proc.stdout.on("data", (chunk: Buffer) => {
    const last = chunk.lastIndexOf(10);
    buffered = last < 0 ? buffered + chunk.length : chunk.length - last - 1;
    if (buffered > 4 * 1024 * 1024) fail(Error("Codex 会话响应超过读取上限"));
  });
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
      fail(Error("Codex 会话响应超过读取上限"));
      return;
    }
    try {
      const message = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(Error("Codex 只读会话接口不可用"));
      else request.resolve(message.result);
    } catch {
      fail(Error("Codex 会话协议响应不完整"));
    }
  });
  const rpc = (
    method: "initialize" | "thread/loaded/list" | "thread/read",
    params: unknown,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    await rpc("initialize", {
      clientInfo: { name: "agent_control_desk_observer", version: "0.1.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = loadedSchema.parse(
        await rpc("thread/loaded/list", {
          limit: 50,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const id of page.data) ids.add(id);
      cursor = page.nextCursor || undefined;
      if (ids.size > 200 || (cursor && cursors.has(cursor)))
        throw Error("Codex 已加载会话过多或分页异常，本轮未完成同步");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const result: NativeSession[] = [],
      excludedSessionIds: string[] = [];
    const observedAt = new Date().toISOString();
    const all = [...ids];
    for (let offset = 0; offset < all.length; offset += 5) {
      const batch = await Promise.all(
        all.slice(offset, offset + 5).map(async (id) => {
          const { thread } = threadSchema.parse(
            await rpc("thread/read", { threadId: id, includeTurns: false }),
          );
          if (thread.id !== id) throw Error("Codex 返回的会话标识不一致");
          if (internalCodexSource(thread.source)) {
            excludedSessionIds.push(
              "native-" +
                createHash("sha256")
                  .update(agent.id + ":" + id)
                  .digest("hex")
                  .slice(0, 24),
            );
            return null;
          }
          const waiting = thread.status.activeFlags?.some(
            (flag) =>
              flag === "waitingOnApproval" || flag === "waitingOnUserInput",
          );
          const status: NativeSession["status"] =
            thread.status.type === "active"
              ? waiting
                ? "waiting_input"
                : "running"
              : thread.status.type === "idle"
                ? "idle"
                : thread.status.type === "systemError"
                  ? "failed"
                  : "unknown";
          return {
            id:
              "native-" +
              createHash("sha256")
                .update(agent.id + ":" + id)
                .digest("hex")
                .slice(0, 24),
            agentId: agent.id,
            sessionId: id,
            title:
              thread.name?.trim().slice(0, 160) ||
              "Codex 会话 " + id.slice(0, 8),
            cwd: thread.cwd,
            status,
            observedAt,
            progress:
              status === "running"
                ? "Codex 正在执行"
                : status === "waiting_input"
                  ? "等待输入或授权，请在 Codex 中处理"
                  : status === "idle"
                    ? "会话当前空闲，不代表任务已验收完成"
                    : status === "failed"
                      ? "原生会话发生错误，请在 Codex 中查看"
                      : "原生会话未加载，当前状态未知",
          };
        }),
      );
      for (const session of batch) if (session) result.push(session);
    }
    return {
      source: "runtime-api",
      state: "connected",
      message: "已同步原生会话，仅供查看",
      sessions: result,
      excludedSessionIds,
    };
  } catch (error) {
    if (error instanceof z.ZodError)
      throw Error("Codex 会话接口版本不兼容，未完成同步");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    fail(Error("只读会话连接已结束"));
    lines.close();
    await terminate(proc);
  }
}

/** Native observations stay in memory and never become executable ACD tasks. */
export class NativeObserver {
  private timer?: ReturnType<typeof setInterval>;
  private working?: Promise<void>;
  private readonly controller = new AbortController();
  constructor(
    private readonly runtime: Runtime,
    private readonly read: ReadNativeSessions = readCodexSessions,
  ) {}
  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.timer.unref();
  }
  refresh(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    return (this.working ??= this.poll().finally(() => {
      this.working = undefined;
    }));
  }
  private async poll() {
    const selected = this.runtime
      .snapshot()
      .agents.filter((agent) => agent.selected);
    const previous = this.runtime.snapshot().observations || [];
    const results = await Promise.all(
      selected.map(async (agent): Promise<AgentObservation> => {
        if (agent.kind !== "codex")
          return {
            agentId: agent.id,
            state: "unsupported",
            message: "此 Agent 的原生会话观测尚未接入",
            sessions: [],
          };
        try {
          const result = await this.read(
            agent,
            this.runtime.store.directory,
            this.controller.signal,
          );
          return {
            agentId: agent.id,
            ...result,
            observedAt: new Date().toISOString(),
          };
        } catch (error) {
          return {
            agentId: agent.id,
            state: "unavailable",
            message: error instanceof Error ? error.message : "原生会话未同步",
            sessions: (
              previous.find((item) => item.agentId === agent.id)?.sessions || []
            ).map((session) => ({
              ...session,
              status: "unknown",
              progress: "连接已断开，当前状态未知",
            })),
          };
        }
      }),
    );
    if (this.controller.signal.aborted) return;
    const current = this.runtime
      .snapshot()
      .agents.filter((agent) => agent.selected)
      .map((agent) => agent.id);
    this.runtime.updateObservations(
      results.filter((item) => current.includes(item.agentId)),
    );
  }
  async close() {
    clearInterval(this.timer);
    this.controller.abort();
    await this.working;
  }
}
