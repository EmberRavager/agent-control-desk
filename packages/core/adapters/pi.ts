import type {
  AgentAdapter,
  AdapterEvent,
  RunHandle,
  StartRun,
} from "../../contracts/index.js";
import { publicSnippet } from "../native-context.js";
import { launch, terminate } from "./process.js";
import { readJsonLines } from "./json-lines.js";

type Launcher = { executable: string; args: string[] };
type Pending = {
  command: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Dialog = {
  method: string;
  choices: Map<string, string>;
  timer?: ReturnType<typeof setTimeout>;
};
class RejectedCommand extends Error {
  constructor(readonly command: string) {
    super("Pi rejected command");
  }
}

/** Native Pi RPC, including the session-level settled event (validated on 0.84.3). */
export class PiAdapter implements AgentAdapter {
  constructor(
    private readonly launcher?: Launcher,
    private readonly timeoutMs = 30000,
    private readonly stopTimeoutMs = 5000,
  ) {}
  async start({ task, agent, onEvent }: StartRun): Promise<RunHandle> {
    if (
      task.sessionId &&
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(task.sessionId)
    )
      throw Error("Pi session id is not a full UUID");
    const args = this.launcher?.args || [
      "--mode",
      "rpc",
      ...(task.sessionId ? ["--session", task.sessionId] : []),
    ];
    const proc = launch(
      this.launcher?.executable || agent.executable,
      args,
      task.cwd,
    );
    const requests = new Map<string, Pending>(),
      dialogs = new Map<string, Dialog>();
    let submitted = false,
      terminal = false,
      disposed = false,
      next = 0,
      output = false,
      messageDelta = false,
      lastReason = "";
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const emit = (event: AdapterEvent) => {
      if (!disposed) onEvent(event);
    };
    const write = (value: unknown) => {
      if (disposed || proc.stdin.destroyed) throw Error("Pi connection closed");
      proc.stdin.write(JSON.stringify(value) + "\n");
    };
    function dispose() {
      if (disposed) return;
      disposed = true;
      stopReading();
      for (const entry of requests.values()) {
        clearTimeout(entry.timer);
        entry.reject(Error("Pi connection closed"));
      }
      requests.clear();
      for (const dialog of dialogs.values()) clearTimeout(dialog.timer);
      dialogs.clear();
      void terminate(proc).catch(() => {});
    }
    function finish(
      type: "completed" | "cancelled" | "failed",
      text?: string,
      notSubmitted = false,
    ) {
      if (terminal || disposed) return;
      terminal = true;
      resolveDone();
      emit({
        type,
        text,
        ...(type === "failed" && (!submitted || notSubmitted)
          ? { taskNotSubmitted: true }
          : {}),
      });
      dispose();
    }
    const rpc = (
      command: string,
      params: Record<string, unknown> = {},
    ): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = "acd-" + ++next;
        const timer = setTimeout(() => {
          requests.delete(id);
          reject(Error("Pi command timeout"));
        }, this.timeoutMs);
        requests.set(id, { command, resolve, reject, timer });
        try {
          write({ id, type: command, ...params });
        } catch (error) {
          clearTimeout(timer);
          requests.delete(id);
          reject(error);
        }
      });
    const cancelDialog = (id: string, expired = false) => {
      const dialog = dialogs.get(id);
      if (!dialog) return;
      clearTimeout(dialog.timer);
      dialogs.delete(id);
      try {
        write({ type: "extension_ui_response", id, cancelled: true });
      } catch {}
      if (expired)
        emit({
          type: "question_resolved",
          requestId: id,
          text: "Pi 的输入请求已过期或取消，等待后续反馈。",
        });
    };
    const assistant = (message: any) => {
      if (message?.role !== "assistant") return;
      lastReason =
        typeof message.stopReason === "string" ? message.stopReason : "";
      if (!messageDelta && Array.isArray(message.content)) {
        const text = message.content
          .filter(
            (item: any) =>
              item?.type === "text" && typeof item.text === "string",
          )
          .map((item: any) => item.text)
          .join("");
        if (text) {
          output = true;
          emit({ type: "output", text: text + "\n" });
        }
      }
    };
    const stopReading = readJsonLines(
      proc.stdout,
      (value) => {
        if (terminal || disposed) return;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          finish("failed", "Pi 返回了无法识别的协议记录。");
          return;
        }
        const event = value as Record<string, any>;
        if (event.type === "response") {
          const pending =
            typeof event.id === "string" ? requests.get(event.id) : undefined;
          if (!pending) {
            if (event.command === "parse")
              finish("failed", "Pi 拒绝了协议输入，执行状态待核对。");
            return;
          }
          requests.delete(event.id);
          clearTimeout(pending.timer);
          if (
            event.command !== pending.command ||
            typeof event.success !== "boolean"
          ) {
            pending.reject(Error("Invalid Pi response"));
            return;
          }
          if (event.success) pending.resolve(event.data);
          else pending.reject(new RejectedCommand(pending.command));
        } else if (!submitted) return;
        else if (
          event.type === "message_start" &&
          event.message?.role === "assistant"
        )
          messageDelta = false;
        else if (
          event.type === "message_update" &&
          event.assistantMessageEvent?.type === "text_delta" &&
          typeof event.assistantMessageEvent.delta === "string"
        ) {
          messageDelta = true;
          output = true;
          emit({ type: "output", text: event.assistantMessageEvent.delta });
        } else if (event.type === "message_end") assistant(event.message);
        else if (event.type === "agent_end") {
          if (Array.isArray(event.messages)) {
            const last = [...event.messages]
              .reverse()
              .find((message) => message?.role === "assistant");
            if (last) {
              if (!output) assistant(last);
              else
                lastReason =
                  typeof last.stopReason === "string" ? last.stopReason : "";
            }
          }
          // A low-level run may still retry or compact. It is never the completion gate.
        } else if (event.type === "agent_settled") {
          if (lastReason === "stop") finish("completed");
          else if (lastReason === "aborted")
            finish("cancelled", "Pi 已确认停止，已有修改保留。");
          else
            finish(
              "failed",
              "Pi 已结束本轮，但未返回正常完成结果，请核对原生输出。",
            );
        } else if (event.type === "tool_execution_start")
          emit({
            type: "progress",
            text:
              "Pi 正在使用工具：" +
              publicSnippet(String(event.toolName || "工具"), 80),
          });
        else if (event.type === "auto_retry_start")
          emit({ type: "progress", text: "Pi 正在重试原生模型请求。" });
        else if (event.type === "compaction_start")
          emit({ type: "progress", text: "Pi 正在整理上下文。" });
        else if (event.type === "auto_retry_end" && event.success === false)
          lastReason = "error";
        else if (event.type === "extension_ui_request") {
          const id = event.id,
            method = event.method;
          if (typeof id !== "string" || id.length > 200) return;
          if (
            [
              "notify",
              "setStatus",
              "setWidget",
              "setTitle",
              "set_editor_text",
              "setFooter",
              "setHeader",
              "setWorkingMessage",
            ].includes(method)
          ) {
            if (method === "notify" && typeof event.message === "string")
              emit({
                type: "progress",
                text: publicSnippet(event.message, 1000),
              });
            return;
          }
          if (dialogs.has(id) || dialogs.size >= 30) {
            finish("failed", "Pi 返回了冲突或过多的输入请求。");
            return;
          }
          if (!["confirm", "select", "input"].includes(method)) {
            write({ type: "extension_ui_response", id, cancelled: true });
            emit({
              type: "progress",
              text: "Pi 的此类界面交互暂不支持，已取消该交互。",
            });
            return;
          }
          const choices = new Map<string, string>(),
            choiceLabels: Record<string, string> = {};
          if (method === "confirm") {
            choices.set("accept", "true");
            choices.set("decline", "false");
            choices.set("cancel", "cancel");
            Object.assign(choiceLabels, {
              accept: "确认",
              decline: "拒绝",
              cancel: "取消",
            });
          } else if (method === "select") {
            if (
              !Array.isArray(event.options) ||
              !event.options.length ||
              event.options.length > 50 ||
              event.options.some(
                (option: unknown) => typeof option !== "string",
              )
            ) {
              write({ type: "extension_ui_response", id, cancelled: true });
              return;
            }
            event.options.forEach((option: string, index: number) => {
              const key = "option-" + (index + 1);
              choices.set(key, option);
              choiceLabels[key] = publicSnippet(option, 500);
            });
            choices.set("cancel", "cancel");
            choiceLabels.cancel = "取消选择";
          }
          const dialog: Dialog = { method, choices };
          dialogs.set(id, dialog);
          if (
            typeof event.timeout === "number" &&
            Number.isFinite(event.timeout) &&
            event.timeout >= 0
          ) {
            dialog.timer = setTimeout(
              () => cancelDialog(id, true),
              Math.min(event.timeout, 2147483647),
            );
            dialog.timer.unref();
          }
          const text = [
            event.title,
            event.message,
            method === "input" ? event.placeholder : undefined,
          ]
            .filter((item) => typeof item === "string" && item.trim())
            .join("\n");
          emit({
            type: "question",
            requestId: id,
            input: method === "input",
            text: publicSnippet(text || "Pi 请求补充信息", 2000),
            choices: [...choices.keys()],
            choiceLabels,
          });
        }
      },
      () => finish("failed", "Pi 协议连接已结束或记录无效，执行状态待核对。"),
    );
    proc.stderr.resume();
    proc.on("error", () =>
      finish("failed", "Pi 程序无法启动，请检查安装与执行权限。"),
    );
    proc.stdin.on("error", () =>
      finish("failed", "Pi 输入连接中断，执行状态待核对。"),
    );
    proc.on("close", () =>
      finish("failed", "Pi 已断开且没有明确结束事件，请核对执行结果。"),
    );
    const handle: RunHandle = {
      steer: async (text) => {
        if (terminal || disposed) throw Error("Pi 没有活动执行。");
        await rpc("steer", { message: text });
      },
      stop: async () => {
        if (terminal || disposed) throw Error("Pi 没有可确认的活动连接。");
        for (const id of [...dialogs.keys()]) cancelDialog(id, true);
        void rpc("abort").catch(() => {
          if (!terminal)
            finish("failed", "Pi 停止请求未确认，请核对原生执行。");
        });
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
          finish("failed", "Pi 未在时限内确认停止，请人工核对，已有修改保留。");
        } finally {
          clearTimeout(timer);
        }
      },
      async answer(requestId, choice) {
        const id = String(requestId),
          dialog = dialogs.get(id);
        if (!dialog || terminal || disposed) throw Error("Pi 输入请求已失效。");
        if (dialog.method !== "input" && !dialog.choices.has(choice))
          throw Error("Pi 选项无效。");
        const answer =
          dialog.method === "input" ? choice : dialog.choices.get(choice)!;
        write({
          type: "extension_ui_response",
          id,
          ...(choice === "cancel" && dialog.method !== "input"
            ? { cancelled: true }
            : dialog.method === "confirm"
              ? { confirmed: answer === "true" }
              : { value: answer }),
        });
        clearTimeout(dialog.timer);
        dialogs.delete(id);
      },
      dispose,
    };
    try {
      const state = await rpc("get_state");
      if (!state?.model) {
        finish("failed", "Pi 尚未配置可用模型，请先在 Pi 中选择模型。", true);
        return handle;
      }
      if (typeof state.sessionId !== "string" || !state.sessionId)
        throw Error("Pi missing session");
      if (state.isStreaming || state.isCompacting)
        throw Error("Pi session not idle");
      emit({ type: "session", sessionId: state.sessionId });
      submitted = true;
      const result = await rpc("prompt", { message: task.goal });
      if (result?.disposition === "handled")
        finish("failed", "Pi 已由扩展处理该输入，但没有可核验的执行结果。");
    } catch (error) {
      finish(
        "failed",
        "Pi 未能接收任务或协议连接失败，请检查原生模型与登录配置。",
        error instanceof RejectedCommand && error.command === "prompt",
      );
    }
    return handle;
  }
}
