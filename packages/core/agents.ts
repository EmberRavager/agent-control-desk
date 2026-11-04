import type { Locale } from "../contracts/index.js";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, basename, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type {
  AgentConnection,
  AgentKind,
  AgentAdapter,
} from "../contracts/index.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { PiAdapter } from "./adapters/pi.js";
import { launch, terminate } from "./adapters/process.js";

const catalog: {
  kind: AgentKind;
  name: string;
  commands: string[];
  supported: boolean;
}[] = [
  { kind: "codex", name: "Codex", commands: ["codex"], supported: true },
  {
    kind: "claude",
    name: "Claude Code",
    commands: ["claude"],
    supported: true,
  },
  {
    kind: "opencode",
    name: "OpenCode",
    commands: ["opencode"],
    supported: true,
  },
  {
    kind: "openclaw",
    name: "OpenClaw",
    commands: ["openclaw"],
    supported: false,
  },
  {
    kind: "hermes",
    name: "Hermes Agent",
    commands: ["hermes"],
    supported: false,
  },
  { kind: "pi", name: "Pi", commands: ["pi"], supported: true },
  {
    kind: "deepseek-harness",
    name: "DeepSeek Harness",
    commands: ["dsh", "deepseek-harness"],
    supported: false,
  },
];

/** Passive discovery only: never launches a command or reads native agent configuration. */
export async function scanAgents(
  searchPaths?: string[],
): Promise<AgentConnection[]> {
  const home = homedir();
  const roots = searchPaths ?? [
    ...(process.env.PATH ?? "").split(delimiter),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".hermes", "hermes-agent", "venv", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS",
  ];
  const found: AgentConnection[] = [];
  const seen = new Set<string>();
  for (const entry of catalog) {
    const candidates = [...new Set(roots.filter(Boolean))].flatMap((root) =>
      entry.commands.flatMap((command) =>
        (process.platform === "win32" ? [".exe", ".cmd"] : [""]).map((suffix) =>
          join(root, command + suffix),
        ),
      ),
    );
    // Verified from this app's public CFBundleExecutable metadata; not its user data.
    if (
      !searchPaths &&
      process.platform === "darwin" &&
      entry.kind === "deepseek-harness"
    )
      candidates.push(
        "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
      );
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        const executable = await realpath(candidate);
        if (!(await stat(executable)).isFile() || seen.has(executable))
          continue;
        seen.add(executable);
        const wrapper = /\.(cmd|bat)$/i.test(executable);
        const supported = entry.supported && !wrapper;
        found.push({
          id: `${entry.kind}-${createHash("sha256").update(executable).digest("hex").slice(0, 12)}`,
          kind: entry.kind,
          name: entry.name,
          executable,
          selected: false,
          discoverySource: "scan",
          supported,
          available: supported,
          verification: supported ? "discovered" : "unsupported",
          verificationMessage: wrapper
            ? "已发现 Windows 命令包装器，尚未支持安全执行，请选择原生可执行程序。"
            : entry.supported
              ? "已发现安装；尚未验证程序启动、账号或模型权限。"
              : "已发现安装；执行适配尚未接入。",
          capabilities: {
            steer: supported && ["codex", "pi"].includes(entry.kind),
            resume: supported,
            approval:
              supported && ["codex", "opencode", "pi"].includes(entry.kind),
            input: supported && ["codex", "pi"].includes(entry.kind),
          },
        });
      } catch {
        /* Missing/non-executable candidates are not errors. */
      }
    }
  }
  return found;
}

/** Register a path explicitly chosen by the user; no process execution. */
export async function agentFromPath(
  candidate: string,
): Promise<AgentConnection> {
  if (!isAbsolute(candidate)) throw Error("请提供可执行程序的绝对路径");
  await access(candidate, constants.X_OK);
  const executable = await realpath(candidate);
  if (!(await stat(executable)).isFile()) throw Error("所选路径不是可执行文件");
  const command = basename(candidate).replace(/\.(exe|cmd|bat)$/i, "");
  const entry =
    catalog.find((e) => e.commands.includes(command)) ||
    (candidate ===
    "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
      ? catalog.find((e) => e.kind === "deepseek-harness")
      : undefined);
  const kind = entry?.kind || "custom",
    supported = Boolean(entry?.supported) && !/\.(cmd|bat)$/i.test(executable);
  return {
    id:
      kind +
      "-" +
      createHash("sha256").update(executable).digest("hex").slice(0, 12),
    kind,
    name: entry?.name || basename(candidate),
    executable,
    selected: false,
    available: supported,
    supported,
    discoverySource: "manual",
    verification: supported ? "discovered" : "unsupported",
    verificationMessage: supported
      ? "已添加程序路径，选择后检查能否启动。"
      : "已记录程序路径；执行协议尚未适配，不会调用该程序。",
    capabilities: {
      steer: supported && ["codex", "pi"].includes(kind),
      resume: supported,
      approval: supported && ["codex", "opencode", "pi"].includes(kind),
      input: supported && ["codex", "pi"].includes(kind),
    },
  };
}

/** Explicit readiness check after user selection. It never starts a model request. */
export async function verifyAgent(
  agent: AgentConnection,
): Promise<AgentConnection> {
  const supported =
    catalog.some((entry) => entry.kind === agent.kind && entry.supported) &&
    agent.supported !== false &&
    !/\.(cmd|bat)$/i.test(agent.executable);
  if (!supported)
    return {
      ...agent,
      supported: false,
      available: false,
      verification: "unsupported",
      verificationMessage: "执行适配尚未接入，不能确认可管理。",
    };
  return new Promise((resolve) => {
    let settled = false,
      size = 0,
      piVersion = "";
    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...agent,
        supported: true,
        available: ok,
        verification: ok ? "verified" : "failed",
        verificationMessage: message,
      });
    };
    // Use an empty project context. No shell and no user-provided argument text.
    let proc: ReturnType<typeof launch>;
    try {
      proc = launch(agent.executable, ["--version"], tmpdir());
    } catch {
      resolve({
        ...agent,
        supported: true,
        available: false,
        verification: "failed",
        verificationMessage: "程序无法启动。",
      });
      return;
    }
    const timer = setTimeout(() => {
      finish(false, "程序启动检查超时；尚未验证账号和模型权限。");
      void terminate(proc).catch(() => {});
    }, 3000);
    const output = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        finish(false, "程序启动检查输出异常，已终止检查。");
        void terminate(proc).catch(() => {});
      }
      // Deliberately discard output: unexpected wrappers may print sensitive data.
    };
    proc.stdout.on("data", (chunk: Buffer) => {
      output(chunk);
      if (agent.kind === "pi" && piVersion.length < 200)
        piVersion += chunk.toString("utf8").slice(0, 200 - piVersion.length);
    });
    proc.stderr.on("data", output);
    proc.on("error", () =>
      finish(false, "程序无法启动，请检查安装路径和执行权限。"),
    );
    proc.on("close", (code) => {
      if (agent.kind === "pi" && code === 0) {
        const match = piVersion
          .trim()
          .match(/^(?:pi(?: version)?\s+v?|v)?(\d+)\.(\d+)\.(\d+)$/i);
        const valid =
          match &&
          (Number(match[1]) > 0 ||
            Number(match[2]) > 84 ||
            (Number(match[2]) === 84 && Number(match[3]) >= 3));
        if (!valid) {
          finish(
            false,
            "Pi 需要可验证的 0.84.3 或更新版本，以可靠识别执行结束。",
          );
          return;
        }
      }
      finish(
        code === 0 && size > 0,
        code === 0 && size > 0
          ? "程序可启动，账号和模型权限待真实执行验证。"
          : "程序启动检查失败；尚未验证账号和模型权限。",
      );
    });
  });
}

export function createAdapter(
  kind: AgentKind,
  locale: () => Locale = () => "zh-CN",
): AgentAdapter {
  if (kind === "codex") return new CodexAdapter(undefined, 30000, 5000, locale);
  if (kind === "claude") return new ClaudeAdapter(undefined, 5000, locale);
  if (kind === "opencode")
    return new OpenCodeAdapter(undefined, 30000, 5000, locale);
  if (kind === "pi") return new PiAdapter(undefined, 30000, 5000, locale);
  throw new Error(`${kind} 的执行适配尚未接入。`);
}
