import type {
  AgentAdapter,
  AdapterEvent,
  RunHandle,
  StartRun,
} from "../../contracts/index.js";
import { publicSnippet } from "../native-context.js";
import { launch, terminate } from "./process.js";
import { readJsonLines } from "./json-lines.js";

type Rpc = {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string };
};
type Launcher = { executable: string; args: string[] };
type Approval = {
  method: string;
  choices: string[];
  questionId?: string;
  allowText?: boolean;
};

/** One owned App Server transport and one identified turn per ACD execution. */
export class CodexAdapter implements AgentAdapter {
  constructor(
    private readonly launcher?: Launcher,
    private readonly timeoutMs = 30000,
    private readonly stopTimeoutMs = 5000,
  ) {}
  async start({ task, agent, onEvent }: StartRun): Promise<RunHandle> {
    const proc = launch(
      this.launcher?.executable ?? agent.executable,
      this.launcher?.args ?? ["app-server"],
      task.cwd,
    );
    const requests = new Map<
      string | number,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const approvals = new Map<string | number, Approval>();
    const early: Rpc[] = [];
    let next = 0,
      threadId = "",
      turnId = "",
      phase: "handshake" | "starting" | "active" = "handshake",
      submitted = false,
      terminal = false,
      disposed = false,
      earlyBytes = 0;
    let stopReading = () => {};
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => (resolveStarted = resolve));
    const waitUntilStarted = async (timeoutMs: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          started,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Codex turn did not start in time.")),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const emit = (event: AdapterEvent) => {
      if (!disposed) onEvent(event);
    };
    const write = (message: Rpc) => {
      if (disposed || proc.stdin.destroyed)
        throw Error("Agent connection is closed.");
      proc.stdin.write(JSON.stringify(message) + "\n");
    };
    function dispose() {
      if (disposed) return;
      disposed = true;
      resolveStarted();
      resolveDone();
      stopReading();
      for (const request of requests.values()) {
        clearTimeout(request.timer);
        request.reject(Error("Agent connection disposed."));
      }
      requests.clear();
      approvals.clear();
      early.length = 0;
      void terminate(proc).catch(() => {});
    }
    function finish(type: "completed" | "cancelled" | "failed", text?: string) {
      if (terminal || disposed) return;
      terminal = true;
      resolveStarted();
      resolveDone();
      emit({
        type,
        text,
        ...(type === "failed" && !submitted ? { taskNotSubmitted: true } : {}),
      });
      dispose();
    }
    const rpc = (method: string, params: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          requests.delete(id);
          reject(Error(`Codex request timed out: ${method}`));
        }, this.timeoutMs);
        requests.set(id, { resolve, reject, timer });
        try {
          write({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          requests.delete(id);
          reject(error);
        }
      });
    const rejectRequest = (message: Rpc) => {
      write({
        id: message.id,
        error: {
          code: -32601,
          message: "This request is not supported by ACD for the active turn.",
        },
      });
      emit({
        type: "progress",
        text: "Codex 的此类请求暂不支持，已拒绝该请求。",
      });
    };
    const scoped = (params: any) =>
      params.threadId === threadId &&
      (params.turnId ?? params.turn?.id) === turnId;
    function activity(message: Rpc) {
      if (terminal || disposed) return;
      const p =
        message.params &&
        typeof message.params === "object" &&
        !Array.isArray(message.params)
          ? message.params
          : {};
      if (message.method === "serverRequest/resolved") {
        if (p.threadId === threadId && approvals.delete(p.requestId))
          emit({
            type: "question_resolved",
            requestId: p.requestId,
            text: "Codex 的问题已结束，等待执行反馈。",
          });
        return;
      }
      if (!scoped(p)) {
        if (message.id !== undefined) rejectRequest(message);
        return;
      }
      if (message.id !== undefined && message.method) {
        if (
          [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
          ].includes(message.method)
        ) {
          const choices = ["accept", "decline", "cancel"];
          approvals.set(message.id, { method: message.method, choices });
          const network = p.networkApprovalContext;
          const scope =
            network && typeof network.host === "string"
              ? `请求网络访问：${String(network.protocol || "network")}://${network.host}`
              : typeof p.command === "string"
                ? p.command
                : typeof p.reason === "string"
                  ? p.reason
                  : "Codex 请求修改文件。";
          emit({
            type: "question",
            requestId: message.id,
            text: publicSnippet(scope, 2000),
            choices,
          });
        } else if (
          message.method === "item/tool/requestUserInput" &&
          Array.isArray(p.questions) &&
          p.questions.length === 1
        ) {
          const q = p.questions[0];
          if (
            !q ||
            typeof q.id !== "string" ||
            typeof q.question !== "string" ||
            q.isSecret === true ||
            (q.options != null &&
              (!Array.isArray(q.options) ||
                q.options.some((o: any) => !o || typeof o.label !== "string")))
          ) {
            rejectRequest(message);
            return;
          }
          const choices: string[] = (q.options || []).map(
            (option: any) => option.label,
          );
          const allowText = !choices.length || q.isOther === true;
          approvals.set(message.id, {
            method: message.method,
            choices,
            questionId: q.id,
            allowText,
          });
          emit({
            type: "question",
            requestId: message.id,
            text: publicSnippet(q.question, 2000),
            choices,
            input: allowText,
            choiceLabels: Object.fromEntries(
              choices.map((choice) => [choice, publicSnippet(choice, 500)]),
            ),
          });
        } else rejectRequest(message);
        return;
      }
      if (message.method === "turn/started") {
        resolveStarted();
        emit({ type: "session", sessionId: threadId, turnId });
      } else if (
        message.method === "item/agentMessage/delta" &&
        typeof p.delta === "string"
      )
        emit({ type: "output", text: p.delta });
      else if (
        message.method === "item/started" &&
        ["commandExecution", "fileChange"].includes(p.item?.type)
      )
        emit({
          type: "progress",
          text:
            p.item.type === "fileChange"
              ? "Codex 正在准备文件修改。"
              : "Codex 正在执行命令。",
        });
      else if (message.method === "turn/completed") {
        const status = p.turn?.status;
        finish(
          status === "completed"
            ? "completed"
            : status === "interrupted"
              ? "cancelled"
              : "failed",
          status === "completed"
            ? undefined
            : status === "interrupted"
              ? "Codex 已确认停止，已有修改保留。"
              : "Codex 未正常结束本轮，请核对原生执行结果。",
        );
      }
    }
    stopReading = readJsonLines(
      proc.stdout,
      (value) => {
        if (terminal || disposed) return;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          finish("failed", "Codex 返回了无法识别的协议记录。");
          return;
        }
        const message = value as Rpc;
        try {
          if (message.id !== undefined && !message.method) {
            const pending = requests.get(message.id);
            if (!pending) return;
            requests.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error)
              pending.reject(Error("Codex rejected the protocol request."));
            else pending.resolve(message.result);
            return;
          }
          if (phase === "active") activity(message);
          else if (phase === "starting") {
            earlyBytes += Buffer.byteLength(JSON.stringify(message));
            if (early.length >= 200 || earlyBytes > 4 * 1024 * 1024) {
              finish("failed", "Codex 启动事件超过限制，执行状态待核对。");
              return;
            }
            early.push(message);
          } else if (message.id !== undefined && message.method)
            rejectRequest(message);
        } catch {
          finish("failed", "Codex 协议处理失败，执行状态待核对。");
        }
      },
      () =>
        finish("failed", "Codex 协议连接已结束或记录无效，执行状态待核对。"),
    );
    proc.stderr.resume();
    proc.on("error", () =>
      finish("failed", "Codex 程序无法启动，请检查安装与执行权限。"),
    );
    proc.stdin.on("error", () =>
      finish("failed", "Codex 输入连接中断，执行状态待核对。"),
    );
    proc.on("close", () =>
      finish("failed", "Codex 已断开且未返回明确结束事件，请核对执行结果。"),
    );
    const handle: RunHandle = {
      steer: async (text) => {
        if (terminal || disposed || !turnId)
          throw Error("No active Codex turn to steer.");
        await waitUntilStarted(this.timeoutMs);
        if (terminal || disposed) throw Error("No active Codex turn to steer.");
        await rpc("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text }],
        });
      },
      stop: async () => {
        if (terminal || disposed || !turnId)
          throw Error("No active Codex turn.");
        // turn/start acknowledgement may precede the actual turn/started event.
        // An interrupt sent before that event is rejected by the native server.
        void (async () => {
          await waitUntilStarted(this.stopTimeoutMs);
          if (!terminal && !disposed)
            await rpc("turn/interrupt", { threadId, turnId });
        })().catch(() => {
          if (!terminal)
            finish("failed", "Codex 停止请求未确认，请核对原生执行。");
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
          finish(
            "failed",
            "Codex 未在时限内确认停止，请人工核对，已有修改保留。",
          );
        } finally {
          clearTimeout(timer);
        }
      },
      async answer(requestId, choice) {
        const pending = approvals.get(requestId);
        if (!pending || terminal || disposed)
          throw Error("This question has expired.");
        if (
          !choice.trim() ||
          (!pending.allowText && !pending.choices.includes(choice))
        )
          throw Error("Invalid approval decision.");
        write({
          id: requestId,
          result: pending.questionId
            ? { answers: { [pending.questionId]: { answers: [choice] } } }
            : { decision: choice },
        });
        approvals.delete(requestId);
      },
      dispose,
    };
    try {
      await rpc("initialize", {
        clientInfo: {
          name: "agent_control_desk",
          title: "Agent Control Desk",
          version: "0.1.0",
        },
      });
      write({ method: "initialized", params: {} });
      const params = {
        cwd: task.cwd,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      };
      const result = task.sessionId
        ? await rpc("thread/resume", { threadId: task.sessionId, ...params })
        : await rpc("thread/start", params);
      if (typeof result?.thread?.id !== "string" || !result.thread.id)
        throw Error("Codex did not return a thread identifier.");
      threadId = result.thread.id;
      emit({ type: "session", sessionId: threadId });
      phase = "starting";
      submitted = true;
      const turn = await rpc("turn/start", {
        threadId,
        input: [{ type: "text", text: task.goal }],
        cwd: task.cwd,
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [task.cwd],
          networkAccess: false,
        },
      });
      if (typeof turn?.turn?.id !== "string" || !turn.turn.id)
        throw Error("Codex did not return a turn identifier.");
      turnId = turn.turn.id;
      phase = "active";
      emit({ type: "session", sessionId: threadId, turnId });
      for (const message of early.splice(0)) activity(message);
    } catch (error) {
      finish(
        "failed",
        submitted
          ? "Codex 未能确认任务开始，执行状态待核对。"
          : "Codex 未能建立任务会话，请检查原生登录和配置。",
      );
      dispose();
      throw error;
    }
    return handle;
  }
}
