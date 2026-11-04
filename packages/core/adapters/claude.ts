import type {
  AgentAdapter,
  AdapterEvent,
  RunHandle,
  StartRun,
} from "../../contracts/index.js";
import { launch, terminate } from "./process.js";
import { readJsonLines } from "./json-lines.js";

type Launcher = { executable: string; args: string[] };

/** Documented headless mode. Mid-turn steering and interactive approval remain unsupported. */
export class ClaudeAdapter implements AgentAdapter {
  constructor(
    private readonly launcher?: Launcher,
    private readonly stopTimeoutMs = 5000,
  ) {}
  async start({ task, agent, onEvent }: StartRun): Promise<RunHandle> {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "default",
    ];
    if (task.sessionId) args.push("--resume", task.sessionId);
    const proc = launch(
      this.launcher?.executable ?? agent.executable,
      this.launcher?.args ?? args,
      task.cwd,
    );
    let terminal = false,
      stopping = false,
      disposed = false,
      hasOutput = false;
    let stopReading = () => {};
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const emit = (event: AdapterEvent) => {
      if (!disposed) onEvent(event);
    };
    function dispose() {
      if (disposed) return;
      disposed = true;
      stopReading();
      void terminate(proc).catch(() => {});
    }
    function finish(
      type: "completed" | "cancelled" | "failed",
      text?: string,
      taskNotSubmitted = false,
    ) {
      if (terminal || disposed) return;
      terminal = true;
      resolveDone();
      emit({
        type,
        text,
        ...(taskNotSubmitted ? { taskNotSubmitted: true } : {}),
      });
      dispose();
    }
    stopReading = readJsonLines(
      proc.stdout,
      (value) => {
        if (terminal || disposed) return;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          finish("failed", "Claude 返回了无法识别的协议记录。");
          return;
        }
        const event = value as Record<string, any>;
        // Forwarded child runs do not define the result of the main task.
        if (event.parent_tool_use_id != null) return;
        if (typeof event.session_id === "string" && event.session_id)
          emit({ type: "session", sessionId: event.session_id });
        if (event.type === "assistant" && Array.isArray(event.message?.content))
          for (const item of event.message.content)
            if (item?.type === "text" && typeof item.text === "string") {
              hasOutput = true;
              emit({ type: "output", text: item.text + "\n" });
            }
        if (event.type === "result") {
          if (!hasOutput && typeof event.result === "string")
            emit({ type: "output", text: event.result });
          const denied =
            Array.isArray(event.permission_denials) &&
            event.permission_denials.length > 0;
          const success =
            event.subtype === "success" && event.is_error === false && !denied;
          finish(
            success ? "completed" : "failed",
            denied
              ? "Claude 的工具权限被拒绝；此适配器暂不支持交互授权，请在原生端处理。"
              : success
                ? undefined
                : "Claude 未返回明确成功结果，请核对原生输出与模型配置。",
          );
        }
      },
      () => {
        if (!stopping)
          finish("failed", "Claude 协议连接已结束或记录无效，执行状态待核对。");
      },
    );
    proc.stderr.resume();
    proc.on("error", () =>
      finish("failed", "Claude 程序无法启动，请检查安装与执行权限。", true),
    );
    proc.stdin.on("error", () =>
      finish("failed", "Claude 输入连接中断，执行状态待核对。"),
    );
    // close follows stdout drainage; exit can precede the final protocol record.
    proc.on("close", () =>
      finish(
        stopping ? "cancelled" : "failed",
        stopping
          ? "Claude 进程已停止，已有修改保留。"
          : "Claude 已退出且未返回明确结果，请核对原生执行。",
      ),
    );
    proc.stdin.end(task.goal);
    return {
      async steer() {
        throw Error(
          "Claude headless adapter cannot accept mid-turn input; stop and resume explicitly.",
        );
      },
      stop: async () => {
        if (terminal || disposed) throw Error("Claude 没有可确认的活动执行。");
        stopping = true;
        void terminate(proc).catch(() => {
          if (!terminal)
            finish("failed", "Claude 进程停止未确认，请核对原生执行。");
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
          finish("failed", "Claude 未在时限内退出，请人工核对，已有修改保留。");
        } finally {
          clearTimeout(timer);
        }
      },
      async answer() {
        throw Error(
          "Interactive approval is not supported by the Claude headless adapter.",
        );
      },
      dispose,
    };
  }
}
