import { Readable, Writable } from "node:stream";
import type * as ACP from "@agentclientprotocol/sdk";
import type {
  AgentAdapter,
  AdapterEvent,
  RunHandle,
  StartRun,
} from "../../contracts/index.js";
import { publicSnippet } from "../native-context.js";
import { launch, terminate } from "./process.js";

type Launcher = { executable: string; args: string[] };
type Permission = {
  choices: Map<string, string>;
  finish: (value: ACP.RequestPermissionResponse, expired?: boolean) => void;
};

/** Stable ACP v1 over this execution's own stdio process. No HTTP server. */
export class OpenCodeAdapter implements AgentAdapter {
  constructor(
    private readonly launcher?: Launcher,
    private readonly timeoutMs = 30000,
    private readonly stopTimeoutMs = 5000,
  ) {}
  async start({ task, agent, onEvent }: StartRun): Promise<RunHandle> {
    const acp = await import("@agentclientprotocol/sdk");
    const proc = launch(
      this.launcher?.executable || agent.executable,
      this.launcher?.args || ["acp"],
      task.cwd,
    );
    let connection: ACP.ClientConnection | undefined,
      sessionId = task.sessionId || "",
      submitted = false,
      terminal = false,
      disposed = false,
      replaying = true;
    const permissions = new Map<string | number, Permission>();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const emit = (event: AdapterEvent) => {
      if (!disposed) onEvent(event);
    };
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const permission of permissions.values())
        permission.finish({ outcome: { outcome: "cancelled" } });
      permissions.clear();
      connection?.close();
      void terminate(proc).catch(() => {});
    }
    function finish(type: "completed" | "cancelled" | "failed", text?: string) {
      if (terminal || disposed) return;
      terminal = true;
      resolveDone();
      emit({
        type,
        text,
        ...(type === "failed" && !submitted ? { taskNotSubmitted: true } : {}),
      });
      dispose();
    }
    const labels: Record<string, string> = {
      allow_once: "允许这次操作",
      allow_always: "始终允许此操作",
      reject_once: "拒绝这次操作",
      reject_always: "始终拒绝此操作",
    };
    const client = acp
      .client({ name: "agent-control-desk" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        const { params, requestId } = ctx;
        if (
          terminal ||
          disposed ||
          replaying ||
          params.sessionId !== sessionId ||
          ctx.signal.aborted ||
          requestId === null
        )
          return { outcome: { outcome: "cancelled" as const } };
        if (
          !params.options.length ||
          params.options.length > 20 ||
          permissions.has(requestId)
        ) {
          finish(
            "failed",
            "OpenCode 返回了无法处理的授权请求，请在原生端核对。",
          );
          return { outcome: { outcome: "cancelled" as const } };
        }
        const choices = new Map<string, string>(),
          choiceLabels: Record<string, string> = {};
        for (const [index, option] of params.options.entries()) {
          const id = "option-" + (index + 1);
          choices.set(id, option.optionId);
          const repeated =
            params.options.filter((item) => item.kind === option.kind).length >
            1;
          choiceLabels[id] =
            (labels[option.kind] || "选择") +
            (repeated ? " · " + publicSnippet(option.name, 100) : "");
        }
        return new Promise<ACP.RequestPermissionResponse>((resolve) => {
          const cancel = () =>
            entry.finish({ outcome: { outcome: "cancelled" } }, true);
          const entry: Permission = {
            choices,
            finish: (value, expired = false) => {
              if (permissions.get(requestId) !== entry) return;
              permissions.delete(requestId);
              ctx.signal.removeEventListener("abort", cancel);
              resolve(value);
              if (expired)
                emit({
                  type: "question_resolved",
                  requestId,
                  text: "OpenCode 授权请求已结束，等待执行反馈。",
                });
            },
          };
          permissions.set(requestId, entry);
          ctx.signal.addEventListener("abort", cancel, { once: true });
          emit({
            type: "question",
            requestId,
            text: publicSnippet(
              params.toolCall.title || "OpenCode 请求工具授权",
              2000,
            ),
            choices: [...choices.keys()],
            choiceLabels,
          });
        });
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (
          terminal ||
          disposed ||
          replaying ||
          ctx.params.sessionId !== sessionId
        )
          return;
        const update = ctx.params.update;
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text"
        )
          emit({ type: "output", text: update.content.text });
        else if (update.sessionUpdate === "tool_call")
          emit({
            type: "progress",
            text: publicSnippet(update.title || "OpenCode 正在调用工具", 200),
          });
        else if (update.sessionUpdate === "tool_call_update")
          emit({
            type: "progress",
            text:
              update.status === "completed"
                ? "OpenCode 工具调用结束，等待后续反馈。"
                : "OpenCode 正在处理工具调用。",
          });
      });
    proc.stderr.resume();
    proc.on("error", () =>
      finish("failed", "OpenCode 程序无法启动，请检查安装与执行权限。"),
    );
    proc.stdin.on("error", () =>
      finish("failed", "OpenCode 输入连接中断，执行状态待核对。"),
    );
    proc.on("close", () =>
      finish("failed", "OpenCode 已断开且未返回明确结束事件，请核对执行结果。"),
    );
    connection = client.connect(
      acp.ndJsonStream(
        Writable.toWeb(proc.stdin),
        Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
        { maxMessageBytes: 4 * 1024 * 1024 },
      ),
    );
    void connection.closed.then(() => {
      if (!terminal && !disposed)
        finish("failed", "OpenCode 协议连接已关闭，执行状态待核对。");
    });
    const handle: RunHandle = {
      async steer() {
        throw Error("OpenCode ACP 不支持中途追加；请停止后显式续接。");
      },
      stop: async () => {
        if (terminal || disposed)
          throw Error("OpenCode 没有可确认的活动连接。");
        for (const permission of [...permissions.values()])
          permission.finish({ outcome: { outcome: "cancelled" } }, true);
        try {
          await connection!.agent.notify(acp.methods.agent.session.cancel, {
            sessionId,
          });
        } catch {
          if (!terminal)
            finish("failed", "OpenCode 停止请求未确认，请核对原生执行。");
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            done,
            new Promise<never>(
              (_, reject) =>
                (timer = setTimeout(
                  () => reject(Error("Stop timeout")),
                  this.stopTimeoutMs,
                )),
            ),
          ]);
        } catch {
          finish(
            "failed",
            "OpenCode 未在时限内确认停止，请人工核对，已有修改保留。",
          );
        } finally {
          clearTimeout(timer);
        }
      },
      async answer(requestId, choice) {
        const permission = permissions.get(requestId),
          nativeId = permission?.choices.get(choice);
        if (!permission || nativeId === undefined || terminal || disposed)
          throw Error("OpenCode 授权请求已失效或选项无效。");
        permission.finish({
          outcome: { outcome: "selected", optionId: nativeId },
        });
      },
      dispose,
    };
    const bounded = {
      cancellationSignal: AbortSignal.timeout(this.timeoutMs),
      stopWaitingOnCancel: true,
    };
    try {
      const initialized = await connection.agent.request(
        acp.methods.agent.initialize,
        {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: "agent-control-desk", version: "0.1.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        bounded,
      );
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION)
        throw Error("Unsupported ACP version");
      if (task.sessionId) {
        if (!initialized.agentCapabilities?.loadSession)
          throw Error("Session loading unavailable");
        await connection.agent.request(
          acp.methods.agent.session.load,
          { sessionId: task.sessionId, cwd: task.cwd, mcpServers: [] },
          bounded,
        );
      } else {
        const session = await connection.agent.request(
          acp.methods.agent.session.new,
          { cwd: task.cwd, mcpServers: [] },
          bounded,
        );
        sessionId = session.sessionId;
      }
      if (terminal || disposed) return handle;
      emit({ type: "session", sessionId });
      replaying = false;
      submitted = true;
      void connection.agent
        .request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: task.goal }],
        })
        .then((result) => {
          if (result.stopReason === "end_turn") finish("completed");
          else if (result.stopReason === "cancelled")
            finish("cancelled", "OpenCode 已确认停止，已有修改保留。");
          else
            finish(
              "failed",
              "OpenCode 未正常结束本轮，可能有部分结果，请核对后再继续。",
            );
        })
        .catch(() =>
          finish("failed", "OpenCode 执行连接或模型请求失败，请在原生端核对。"),
        );
    } catch {
      finish(
        "failed",
        task.sessionId
          ? "OpenCode 无法续接原会话，请检查原生版本、登录和会话状态。"
          : "OpenCode 未能建立任务会话，请检查原生登录与模型配置。",
      );
    }
    return handle;
  }
}
