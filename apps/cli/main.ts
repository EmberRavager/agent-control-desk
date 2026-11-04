import { randomUUID } from "node:crypto";
import { serviceLaunch } from "../../packages/core/service-launch.cjs";
import {
  modelProviders,
  requiresModelKey,
} from "../../packages/contracts/providers.js";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import { dataDirectory } from "../../packages/core/paths.js";
import type {
  Snapshot,
  SkillCatalog,
  SkillDetail,
  AllocationRequest,
  AgentCapability,
  Schedule,
  ScheduleRun,
  ScheduleInput,
} from "../../packages/contracts/index.js";

import { scheduleInputSchema } from "../../packages/contracts/schedules.js";

const PROTOCOL = 1;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export interface Descriptor {
  url: string;
  token: string;
  protocol: number;
  pid: number;
  capabilities?: string[];
}

export function validateDescriptor(input: unknown): Descriptor {
  const d = input as Partial<Descriptor> | null;
  if (
    !d ||
    d.protocol !== PROTOCOL ||
    typeof d.url !== "string" ||
    typeof d.token !== "string" ||
    !d.token ||
    !Number.isSafeInteger(d.pid) ||
    Number(d.pid) < 1 ||
    (d.capabilities !== undefined &&
      (!Array.isArray(d.capabilities) ||
        !d.capabilities.every((item) => typeof item === "string")))
  ) {
    throw new Error("本地服务描述无效或协议不兼容。请重启 ACD 服务。");
  }
  const url = new URL(d.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("本地服务地址无效。");
  }
  return d as Descriptor;
}

export async function readDescriptor(): Promise<Descriptor | null> {
  try {
    return validateDescriptor(
      JSON.parse(await readFile(join(dataDirectory(), "runtime.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("无法读取本地服务描述，请重启 ACD 服务。");
  }
}

export async function request<T = unknown>(
  d: Descriptor,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("无效 API 路径");
  if (
    (path === "/api/allocation" ||
      (path === "/api/messages" &&
        body &&
        typeof body === "object" &&
        ("targetAgentId" in body || "requiredCapabilities" in body))) &&
    !d.capabilities?.includes("agent-allocation")
  )
    throw Error("本地后台尚不支持任务分配规则，请先处理任务后重启 ACD。");

  if (
    path.startsWith("/api/schedules") &&
    !d.capabilities?.includes("schedules")
  )
    throw new Error(
      "本地后台尚无定时任务能力，请先处理进行中的任务，再停止并重新启动 ACD。",
    );
  if (
    path.startsWith("/api/notifications") &&
    !d.capabilities?.includes("notifications")
  )
    throw new Error("本地后台尚无消息提醒能力，请先处理任务后重启 ACD。");
  if (
    /^\/api\/wechat\/(?:login|configure)$/.test(path) &&
    body &&
    typeof body === "object" &&
    "completionReports" in body &&
    !d.capabilities?.includes("wechat-reports")
  )
    throw Error("本地后台尚不支持完成报告推送，请先处理任务后重启 ACD。");
  if (path === "/api/wechat/test" && !d.capabilities?.includes("wechat-test"))
    throw Error("本地后台尚不支持微信测试消息，请先处理任务后重启 ACD。");
  if (path.startsWith("/api/wechat") && !d.capabilities?.includes("wechat"))
    throw new Error(
      "本地后台尚无微信接入能力，请先处理进行中的任务，再停止并重新启动 ACD。",
    );
  if (
    path === "/api/messages" &&
    body &&
    typeof body === "object" &&
    "clientMessageId" in body &&
    !d.capabilities?.includes("message-idempotency")
  )
    throw new Error(
      "本地后台版本较旧，请先处理进行中的任务，再停止并重新启动 ACD 后重试。",
    );
  if (
    /^\/api\/messages\/[^/]+\/retry$/.test(path) &&
    !d.capabilities?.includes("routing-retry")
  )
    throw Error("本地后台尚不支持重新判断消息，请先处理任务后重启 ACD。");
  const response = await fetch(new URL(path, d.url), {
    method,
    headers: {
      Authorization: `Bearer ${d.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const value = (await response.json()) as { error?: unknown };
      if (typeof value.error === "string") message = value.error;
    } catch {}
    // Never include request headers, bodies, or descriptor content in diagnostics.
    throw new Error(message.replaceAll(d.token, "[redacted]"));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function reachable(): Promise<Descriptor | null> {
  const d = await readDescriptor();
  if (!d) return null;
  try {
    process.kill(d.pid, 0);
    const health = await request<{ protocol: number }>(d, "GET", "/api/health");
    if (health.protocol !== PROTOCOL)
      throw new Error("服务协议不兼容，请重启服务。");
    await request(d, "GET", "/api/state");
    return d;
  } catch (error) {
    if (error instanceof Error && error.message.includes("协议不兼容"))
      throw error;
    return null;
  }
}

export async function ensureService(): Promise<Descriptor> {
  const existing = await reachable();
  if (existing) return existing;
  const launch = serviceLaunch({
    root: repository,
    executable: process.execPath,
    compiled: import.meta.url.endsWith("/cli.mjs"),
  });
  const child = spawn(process.execPath, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  let startError: Error | undefined;
  child.once("error", (error) => {
    startError = error;
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (startError)
      throw new Error("无法启动本地服务。请检查 Node.js 和项目依赖。");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const d = await reachable();
    if (d) return d;
  }
  throw new Error("本地服务未能启动。运行 npm run daemon 查看启动错误。");
}

function print(value: unknown, json: boolean): void {
  stdout.write(
    json
      ? JSON.stringify(value) + "\n"
      : typeof value === "string"
        ? value + "\n"
        : JSON.stringify(value, null, 2) + "\n",
  );
}

function skillText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function printSkills(catalog: SkillCatalog, json: boolean): void {
  if (json) {
    print(catalog, true);
    return;
  }
  const lines = [
    catalog.scannedAt
      ? `技能目录：${catalog.skills.length} 项`
      : "尚未扫描技能。运行 acd skills scan。",
  ];
  for (const skill of catalog.skills) {
    const scopes = [
      ...new Set(
        skill.sources.map((source) =>
          source.scope === "global" ? "全局" : "项目",
        ),
      ),
    ].join(" / ");
    const agents =
      [...new Set(skill.sources.flatMap((source) => source.agents))].join(
        ", ",
      ) || "未关联";
    lines.push(
      `\n${skill.name}  [${scopes || "未知范围"}]${skill.valid ? "" : " [需检查]"}  #${skill.id}`,
    );
    if (skill.description)
      lines.push(`  ${skill.description.replace(/\s+/g, " ").slice(0, 140)}`);
    lines.push(`  路径：${skill.path}`, `  路径关联：${agents}（加载未验证）`);
    for (const warning of skill.warnings) lines.push(`  提示：${warning}`);
  }
  for (const warning of catalog.warnings) lines.push(`\n扫描提示：${warning}`);
  if (catalog.scannedAt)
    lines.push("\n已发现不等于已启用；本命令不安装、修改或执行技能。");
  print(skillText(lines.join("\n")), false);
}

function printSkill(detail: SkillDetail, json: boolean): void {
  if (json) {
    print(detail, true);
    return;
  }
  const lines = [
    `${detail.skill.name}  #${detail.skill.id}`,
    detail.skill.path,
  ];
  for (const warning of detail.skill.warnings) lines.push(`提示：${warning}`);
  lines.push("", detail.content);
  if (detail.truncated) lines.push("\n[预览已截断，完整内容请查看原文件]");
  print(skillText(lines.join("\n")), false);
}

const scheduleHelp = `acd schedules [list]                 查看定时任务
acd schedules show <计划编号>         查看计划详情
acd schedules create --file <JSON文件> 新建计划
acd schedules update <计划编号> --file <JSON文件> 替换计划要求与时间
acd schedules pause|resume|delete <计划编号> 暂停、恢复或删除计划
acd schedules runs <计划编号>         查看最近 30 次触发记录

JSON 字段：name、prompt、agentId、rule，cwd 可省略（使用当前目录）。
agentId 使用 acd agents list 返回的已接入 Agent 编号。
rule 示例：
  {"kind":"once","at":"2026-12-01T09:00:00+08:00"}
  {"kind":"interval","minutes":60}
  {"kind":"daily","time":"09:00","timeZone":"Asia/Shanghai"}
  {"kind":"weekly","time":"09:00","timeZone":"Asia/Shanghai","days":[1,3,5]}
星期使用 0（周日）至 6（周六）。单次时间必须包含时区偏移。
后台需运行；错过不补跑。暂停或删除计划不会停止已触发的任务。
--json                               机器可读输出`;

export async function readScheduleInput(
  file: string,
  cwd = process.cwd(),
): Promise<ScheduleInput> {
  const text = await readFile(resolve(cwd, file), "utf8");
  if (Buffer.byteLength(text) > 65536) throw Error("定时任务 JSON 文件过大");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw Error("定时任务文件必须是合法 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("定时任务文件必须是 JSON 对象");
  const input = { ...value, cwd: "cwd" in value ? value.cwd : cwd };
  const parsed = scheduleInputSchema.safeParse(input);
  if (!parsed.success)
    throw Error("定时任务字段无效，请运行 acd schedules --help 查看用法");
  if (!isAbsolute(parsed.data.cwd)) throw Error("定时任务 cwd 必须是绝对路径");
  return parsed.data;
}

function scheduleRuleText(rule: Schedule["rule"]): string {
  if (rule.kind === "once") return `单次 ${rule.at}`;
  if (rule.kind === "interval") return `每 ${rule.minutes} 分钟`;
  if (rule.kind === "daily") return `每天 ${rule.time}（${rule.timeZone}）`;
  return `每周 ${rule.days.map((day) => "日一二三四五六"[day]).join("、")} ${rule.time}（${rule.timeZone}）`;
}
function printSchedules(
  schedules: Schedule[],
  json: boolean,
  detail = false,
): void {
  if (json) {
    print(detail ? schedules[0] : schedules, true);
    return;
  }
  if (!schedules.length) {
    print(
      "暂无定时任务。运行 acd schedules create --file <JSON文件> 新建。",
      false,
    );
    return;
  }
  const statuses = { active: "已启用", paused: "已暂停", finished: "已结束" };
  print(
    skillText(
      schedules
        .map((item) =>
          [
            `${item.name}  [${statuses[item.status]}]  #${item.id}`,
            `  时间：${scheduleRuleText(item.rule)}`,
            `  下次：${item.nextRunAt || "无"}`,
            `  Agent：${item.agentId}`,
            `  工作目录：${item.cwd}`,
            ...(detail ? [`  要求：${item.prompt}`] : []),
            ...(item.lastRun
              ? [
                  `  最近触发：${item.lastRun.status} · ${item.lastRun.detail}${item.lastRun.taskId ? " · 任务 " + item.lastRun.taskId : ""}`,
                ]
              : []),
          ].join("\n"),
        )
        .join("\n\n"),
    ),
    false,
  );
}

async function ask(prompt: string): Promise<string> {
  if (!stdin.isTTY) throw new Error("模型设置需要交互终端。");
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) =>
    rl.question(prompt, (value) => {
      rl.close();
      resolve(value.trim());
    }),
  );
}

export async function askSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error("API Key 需要在交互终端中输入。");
  stdout.write(prompt);
  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      if (wasPaused) stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      if (chunk[0] === 27) return;
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") {
          cleanup();
          reject(new Error("已取消模型设置。"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " " && char !== "\u001b") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

export async function* parseSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Snapshot> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll(
        "\r\n",
        "\n",
      );
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const lines = frame.split("\n");
        if (!lines.includes("event: state")) continue;
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield JSON.parse(data) as Snapshot;
      }
      if (buffer.length > 8 * 1024 * 1024)
        throw new Error("事件数据过大，连接已断开。");
    }
  } finally {
    reader.releaseLock();
  }
}

async function chat(d: Descriptor, json: boolean): Promise<void> {
  const initial = await request<Snapshot>(d, "GET", "/api/state");
  const seenMessages = new Set(initial.messages.map((m) => m.id));
  const seenQuestions = new Set(
    initial.questions.filter((q) => q.resolved).map((q) => q.id),
  );
  const statuses = new Map(
    initial.tasks.map((t) => [t.id, `${t.status}|${t.progress}`]),
  );
  const lastProgress = new Map<string, number>();
  const abort = new AbortController();
  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(stdin.isTTY && !json),
  });
  if (!json) {
    stdout.write(
      "ACD · 一个对话，所有 Agent。输入 /quit 退出，后台任务继续运行。\n",
    );
    if (!initial.agents.some((a) => a.selected))
      stdout.write(
        "尚未接入 Agent。先运行 acd agents scan，再 acd agents select <编号>。\n",
      );
    if (!initial.model)
      stdout.write("尚未配置总控模型。运行 acd model configure。\n");
    rl.setPrompt("你 › ");
    rl.prompt();
  }
  const watcher = (async () => {
    try {
      const response = await fetch(new URL("/api/events", d.url), {
        headers: { Authorization: `Bearer ${d.token}` },
        signal: abort.signal,
      });
      if (!response.ok || !response.body)
        throw new Error("无法连接进展事件流。");
      for await (const state of parseSSE(response.body.getReader())) {
        if (json) {
          print({ type: "state", state }, true);
          continue;
        }
        const lines: string[] = [];
        for (const m of state.messages) {
          if (!seenMessages.has(m.id)) {
            seenMessages.add(m.id);
            if (m.role !== "user") lines.push(`ACD › ${m.text}`);
          }
        }
        for (const t of state.tasks) {
          const signature = `${t.status}|${t.progress}`;
          if (statuses.get(t.id) !== signature) {
            const oldStatus = statuses.get(t.id)?.split("|")[0];
            if (
              oldStatus !== t.status ||
              Date.now() - (lastProgress.get(t.id) ?? 0) > 1500
            ) {
              lines.push(`${t.id} [${t.status}] ${t.progress.slice(0, 300)}`);
              statuses.set(t.id, signature);
              lastProgress.set(t.id, Date.now());
            }
          }
        }
        for (const q of state.questions)
          if (!q.resolved && !seenQuestions.has(q.id)) {
            seenQuestions.add(q.id);
            lines.push(
              `需要处理 ${q.id}: ${q.text}\n${q.choices.map((choice) => (q.choiceLabels?.[choice] ? `${choice} (${q.choiceLabels[choice]})` : choice)).join(" / ")}\n使用 acd answer ${q.id} <选项>`,
            );
          }
        if (lines.length) {
          stdout.write("\n" + lines.join("\n") + "\n");
          rl.prompt(true);
        }
      }
      if (!abort.signal.aborted)
        stderr.write(
          "\n进展连接已断开。任务可能仍在运行，使用 acd tasks 核对。\n",
        );
    } catch (error) {
      if (!abort.signal.aborted)
        stderr.write("\n进展连接不可用，使用 acd tasks 核对状态。\n");
    }
  })();
  rl.on("line", (text) => {
    text = text.trim();
    if (text === "/quit" || text === "/exit") {
      rl.close();
      return;
    }
    if (text) {
      // The accepted-message request is independent of every previous task or model call.
      void request(d, "POST", "/api/messages", {
        text,
        cwd: process.cwd(),
        clientMessageId: randomUUID(),
      })
        .then((value) => {
          if (json) print({ type: "accepted", result: value }, true);
        })
        .catch((error) => {
          stderr.write(`发送失败：${(error as Error).message}\n`);
        });
    }
    if (!json) rl.prompt();
  });
  await new Promise<void>((resolve) => {
    rl.once("close", resolve);
    rl.once("SIGINT", () => {
      rl.close();
      resolve();
    });
  });
  abort.abort();
  await watcher;
}

export function parseSendArgs(
  args: string[],
): { text: string } & AllocationRequest {
  const words: string[] = [];
  let targetAgentId: string | undefined,
    agentSeen = false;
  const required = new Set<AgentCapability>();
  const capabilities = ["steer", "resume", "approval", "input"] as const;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--agent" || arg === "--require") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw Error(arg + " 需要提供值");
      if (arg === "--agent") {
        if (agentSeen) throw Error("每条消息只能指定一个执行 Agent");
        agentSeen = true;
        targetAgentId = value === "auto" ? undefined : value;
      } else {
        for (const capability of value.split(",")) {
          if (!capabilities.includes(capability as AgentCapability))
            throw Error(
              "未知能力：" +
                capability +
                "；可选 steer、resume、approval、input",
            );
          required.add(capability as AgentCapability);
        }
      }
    } else if (arg.startsWith("--")) throw Error("未知发送选项：" + arg);
    else words.push(arg);
  }
  const text = words.join(" ").trim();
  if (!text)
    throw Error(
      "用法：acd send <消息> [--agent <编号|auto>] [--require <能力>]",
    );
  return {
    text,
    ...(targetAgentId ? { targetAgentId } : {}),
    ...(required.size ? { requiredCapabilities: [...required].sort() } : {}),
  };
}

const help = `acd                         打开总控对话\nacd send <消息> [--agent <编号|auto>] [--require <steer|resume|approval|input>]  发送任务\nacd agents scan            扫描已支持的 Agent\nacd agents add <程序路径>   手动添加 Agent 候选程序\nacd agents list            查看已发现和已选择的 Agent\nacd agents select <编号…>   确认管理的 Agent（传 none 可清空）\nacd agents default [<编号|none> [--project <目录>]]  查看或设置默认执行者\nacd skills scan [--project <绝对路径>]  扫描全局及指定项目的技能\nacd skills list            查看最近扫描的技能目录\nacd skills show <技能编号>  预览本地技能说明\nacd skills create --root <目录> --name <名称> --description <用途> --content <正文>\nacd skills delete <技能编号>  移入回收区\nacd skills trash           查看回收区\nacd skills restore <回收编号> 恢复技能\nacd schedules              查看定时任务（--help 查看创建与管理用法）\nacd inbox                  查看消息和未读\nacd inbox read <消息编号> | read-all  标记已读\nacd retry <消息编号>        重新判断未进入执行阶段的失败消息\nacd tasks                  查看 ACD 发起的任务\nacd sessions               查看已同步的原生会话（只读）\nacd stop <任务编号>         请求停止任务\nacd recover <任务编号> --stopped  确认原执行已停止后释放待确认任务\nacd accept <任务编号>       确认交付完成\nacd answer <问题编号> <选项> 回答待处理问题\nacd model configure        配置独立总控模型\nacd service start|status|stop\nacd wechat login [--project <目录>]  扫码连接个人微信\nacd wechat configure --reports|--no-reports [--notify|--no-notify]\nacd wechat status|pause|resume|disconnect|test\nacd wechat verify <验证码>  提交手机显示的验证码\nacd doctor                 检查本地服务及必要配置\n--json                     机器可读输出`;

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  try {
    const [command, sub, ...rest] = args;
    if (command === "--help" || command === "-h" || command === "help") {
      print(help, json);
      return;
    }
    if (
      command === "schedules" &&
      (sub === "--help" || sub === "-h" || sub === "help")
    ) {
      print(scheduleHelp, json);
      return;
    }
    if (command === "service" && sub === "status") {
      const d = await reachable();
      print(
        {
          running: Boolean(d),
          ...(d ? { pid: d.pid, protocol: d.protocol } : {}),
        },
        json,
      );
      return;
    }
    if (command === "service" && sub === "stop") {
      const d = await reachable();
      if (!d) {
        print("服务未运行。", json);
        return;
      }
      await request(d, "POST", "/api/shutdown", {});
      print("已请求停止本地服务。", json);
      return;
    }
    if (command === "service" && sub !== "start")
      throw new Error("用法：acd service start|status|stop");
    const known = new Set([
      "send",
      "agents",
      "skills",
      "schedules",
      "tasks",
      "sessions",
      "retry",
      "stop",
      "accept",
      "answer",
      "model",
      "service",
      "doctor",
      "recover",
      "wechat",
      "inbox",
    ]);
    if (command && !known.has(command))
      throw new Error(
        "未知命令。运行 acd --help 查看用法；发送任务请使用 acd send <消息>。",
      );
    const sendInput =
      command === "send" ? parseSendArgs(args.slice(1)) : undefined;
    const d = await ensureService();
    if (!command) {
      await chat(d, json);
      return;
    }
    if (command === "service") {
      print({ running: true, pid: d.pid, protocol: d.protocol }, json);
      return;
    }
    if (command === "schedules") {
      const operation = sub || "list";
      if (operation === "list" || operation === "show") {
        if (
          (operation === "list" && rest.length) ||
          (operation === "show" && rest.length !== 1)
        )
          throw Error("用法：acd schedules [list] | show <计划编号>");
        let items = await request<Schedule[]>(d, "GET", "/api/schedules");
        if (operation === "show") {
          items = items.filter((item) => item.id === rest[0]);
          if (!items.length) throw Error("定时任务不存在");
        }
        printSchedules(items, json, operation === "show");
      } else if (operation === "create" || operation === "update") {
        const offset = operation === "update" ? 1 : 0;
        if (
          rest.length !== offset + 2 ||
          rest[offset] !== "--file" ||
          !rest[offset + 1]
        )
          throw Error(
            `用法：acd schedules ${operation}${offset ? " <计划编号>" : ""} --file <JSON文件>`,
          );
        const input = await readScheduleInput(rest[offset + 1]);
        const item = await request<Schedule>(
          d,
          offset ? "PUT" : "POST",
          offset
            ? `/api/schedules/${encodeURIComponent(rest[0])}`
            : "/api/schedules",
          input,
        );
        printSchedules([item], json, true);
      } else if (["pause", "resume", "delete", "runs"].includes(operation)) {
        if (rest.length !== 1)
          throw Error(`用法：acd schedules ${operation} <计划编号>`);
        const path = `/api/schedules/${encodeURIComponent(rest[0])}/${operation}`;
        if (operation === "runs") {
          const runs = await request<ScheduleRun[]>(d, "GET", path);
          if (json) print(runs, true);
          else
            print(
              skillText(
                runs.length
                  ? runs
                      .map(
                        (run) =>
                          `${run.scheduledFor}  [${run.status}]\n  ${run.detail}${run.taskId ? "\n  任务：" + run.taskId : ""}`,
                      )
                      .join("\n\n")
                  : "暂无触发记录。",
              ),
              false,
            );
        } else if (operation === "delete") {
          const result = await request<{ ok: true }>(d, "POST", path, {});
          print(json ? result : "定时任务已删除，已触发的执行仍保留。", json);
        } else {
          const item = await request<Schedule>(d, "POST", path, {});
          printSchedules([item], json, true);
        }
      } else
        throw Error("未知定时任务操作。运行 acd schedules --help 查看用法。");
      return;
    }
    if (command === "inbox") {
      const feed = await request<
        import("../../packages/contracts/notifications.js").NoticeFeed
      >(d, "GET", "/api/notifications");
      if (sub === "read" || sub === "read-all") {
        if (sub === "read" && !rest[0])
          throw Error("用法：acd inbox read <消息编号>");
        if (sub === "read-all" && !feed.items.length) {
          print("暂无消息。", json);
          return;
        }
        await request(
          d,
          "POST",
          "/api/notifications/read",
          sub === "read" ? { ids: [rest[0]] } : { throughId: feed.items[0].id },
        );
        print("已标记已读。", json);
        return;
      }
      if (sub) throw Error("用法：acd inbox [read <消息编号>|read-all]");
      if (json) print(feed, true);
      else
        stdout.write(
          `${feed.unread} 条未读\n` +
            feed.items
              .map(
                (n) =>
                  `${n.readAt ? "[已读]" : "[未读]"} ${n.title}\n${n.body}\n消息编号：${n.id}`,
              )
              .join("\n\n") +
            "\n",
        );
      return;
    }
    if (command === "wechat") {
      if (sub === "status") {
        print(await request(d, "GET", "/api/wechat"), json);
        return;
      }
      if (["pause", "resume", "disconnect", "test"].includes(sub)) {
        print(await request(d, "POST", "/api/wechat/" + sub, {}), json);
        return;
      }
      if (sub === "configure") {
        if (
          (rest.includes("--reports") && rest.includes("--no-reports")) ||
          (rest.includes("--notify") && rest.includes("--no-notify"))
        )
          throw Error("不能同时开启和关闭同一选项");
        const previous = await request<
          import("../../packages/contracts/wechat.js").WeChatStatus
        >(d, "GET", "/api/wechat");
        print(
          await request(d, "POST", "/api/wechat/configure", {
            cwd: previous.cwd,
            notifications: rest.includes("--notify")
              ? true
              : rest.includes("--no-notify")
                ? false
                : previous.notifications,
            completionReports: rest.includes("--reports")
              ? true
              : rest.includes("--no-reports")
                ? false
                : (previous.completionReports ?? false),
          }),
          json,
        );
        return;
      }
      if (sub === "verify") {
        print(
          await request(d, "POST", "/api/wechat/verify", { code: rest[0] }),
          json,
        );
        return;
      }
      if (sub !== "login")
        throw Error(
          "用法：acd wechat login|status|pause|resume|disconnect|verify|test|configure",
        );
      const projectIndex = rest.indexOf("--project");
      if (projectIndex >= 0 && !rest[projectIndex + 1])
        throw Error("--project 需要工作目录");
      const status = await request<
        import("../../packages/contracts/wechat.js").WeChatStatus
      >(d, "POST", "/api/wechat/login", {
        cwd: resolve(
          projectIndex >= 0 ? rest[projectIndex + 1] : process.cwd(),
        ),
        notifications: !rest.includes("--no-notify"),
      });
      if (json) {
        print(status, true);
        return;
      }
      if (status.qrContent) {
        const QRCode = await import("qrcode");
        stdout.write(
          await QRCode.toString(status.qrContent, {
            type: "terminal",
            small: true,
          }),
        );
      }
      stdout.write(
        "请用个人微信扫码并确认。只允许扫码绑定者控制 ACD。\n新任务使用指定工作目录；默认同步总控回复与任务反馈，可用 --no-notify 关闭。\n用 acd wechat status 查看连接状态；需要手机验证码时运行 acd wechat verify <验证码>。\n",
      );
      return;
    }
    if (command === "retry") {
      if (!sub || rest.length || !/^[a-f0-9-]{36}$/.test(sub))
        throw Error("用法：acd retry <消息编号>");
      print(await request(d, "POST", `/api/messages/${sub}/retry`, {}), json);
      return;
    }
    if (command === "send") {
      const input = sendInput!;
      print(
        await request(d, "POST", "/api/messages", {
          ...input,
          cwd: process.cwd(),
          clientMessageId: randomUUID(),
        }),
        json,
      );
      return;
    }
    if (command === "agents") {
      if (sub === "scan")
        print(await request(d, "POST", "/api/agents/scan", {}), json);
      else if (sub === "add") {
        if (rest.length !== 1)
          throw new Error("用法：acd agents add <可执行程序的绝对路径>");
        print(
          await request(d, "POST", "/api/agents/manual", {
            executable: rest[0],
          }),
          json,
        );
      } else if (sub === "select") {
        if (!rest.length)
          throw new Error("请指定 Agent 编号，或使用 none 清空。");
        print(
          await request(d, "PUT", "/api/agents", {
            ids: rest[0] === "none" ? [] : rest,
          }),
          json,
        );
      } else if (sub === "default") {
        if (!rest.length)
          print(await request(d, "GET", "/api/allocation"), json);
        else {
          if (
            rest.length !== 1 &&
            (rest.length !== 3 || rest[1] !== "--project")
          )
            throw Error(
              "用法：acd agents default [<编号|none> [--project <目录>]]",
            );
          print(
            await request(d, "PUT", "/api/allocation", {
              agentId: rest[0] === "none" ? null : rest[0],
              ...(rest.length === 3 ? { projectPath: resolve(rest[2]) } : {}),
            }),
            json,
          );
        }
      } else if (!sub || sub === "list")
        print((await request<Snapshot>(d, "GET", "/api/state")).agents, json);
      else throw new Error("用法：acd agents scan|add|list|select|default");
      return;
    }
    if (command === "skills") {
      if (sub === "scan") {
        let projectPath: string | undefined;
        if (rest.length) {
          if (
            rest.length !== 2 ||
            rest[0] !== "--project" ||
            !isAbsolute(rest[1])
          )
            throw new Error("用法：acd skills scan [--project <项目绝对路径>]");
          projectPath = rest[1];
        }
        printSkills(
          await request<SkillCatalog>(
            d,
            "POST",
            "/api/skills/scan",
            projectPath ? { projectPath } : {},
          ),
          json,
        );
      } else if (!sub || sub === "list") {
        if (rest.length) throw new Error("用法：acd skills list [--json]");
        printSkills(await request<SkillCatalog>(d, "GET", "/api/skills"), json);
      } else if (sub === "show") {
        if (rest.length !== 1)
          throw new Error("用法：acd skills show <技能编号>");
        printSkill(
          await request<SkillDetail>(
            d,
            "GET",
            `/api/skills/${encodeURIComponent(rest[0])}`,
          ),
          json,
        );
      } else if (sub === "create") {
        if (rest.length !== 8)
          throw Error(
            "用法：acd skills create --root <目录> --name <名称> --description <用途> --content <正文>",
          );
        const flags = new Map<string, string>();
        for (let i = 0; i < rest.length; i += 2) {
          if (
            !["--root", "--name", "--description", "--content"].includes(
              rest[i],
            ) ||
            flags.has(rest[i])
          )
            throw Error("新建技能参数无效");
          flags.set(rest[i], rest[i + 1]);
        }
        const body = {
          rootPath: flags.get("--root"),
          name: flags.get("--name"),
          description: flags.get("--description"),
          content: flags.get("--content"),
        };
        printSkills(
          await request<SkillCatalog>(d, "POST", "/api/skills", body),
          json,
        );
      } else if (sub === "delete" || sub === "restore") {
        if (rest.length !== 1)
          throw Error("用法：acd skills " + sub + " <编号>");
        const resource =
          sub === "delete"
            ? "/api/skills/" + encodeURIComponent(rest[0]) + "/trash"
            : "/api/skills/trash/" + encodeURIComponent(rest[0]) + "/restore";
        print(await request(d, "POST", resource, {}), json);
      } else if (sub === "trash") {
        if (rest.length) throw Error("用法：acd skills trash");
        print(await request(d, "GET", "/api/skills/trash"), json);
      } else
        throw new Error(
          "用法：acd skills scan|list|show|create|delete|trash|restore",
        );
      return;
    }
    if (command === "sessions") {
      if (sub || rest.length) throw Error("用法：acd sessions [--json]");
      if (!d.capabilities?.includes("native-observation"))
        throw Error(
          "本地后台尚不支持原生会话观测，请先处理进行中的任务再重启后台。",
        );
      const state = await request<Snapshot>(d, "GET", "/api/state");
      const observations = state.observations || [];
      const labels = {
        running: "正在执行",
        waiting_input: "等待处理",
        idle: "当前空闲",
        failed: "发生错误",
        unknown: "状态未知",
      };
      print(
        json
          ? observations
          : observations
              .map((observation) => {
                const name =
                  state.agents.find((agent) => agent.id === observation.agentId)
                    ?.name || "Agent";
                return `${name} · ${observation.message}\n${
                  observation.sessions
                    .map(
                      (session) =>
                        `  [${labels[session.status]}] ${session.taskTitle || session.title}\n  会话：${session.sessionId}\n  ${session.progress}\n  工作目录：${session.cwd}`,
                    )
                    .join("\n\n") ||
                  "  当前观测范围没有会话，不代表其他实例没有任务。"
                }`;
              })
              .join("\n\n") ||
              "尚未同步原生会话。请先接入 Codex，并等待后台同步。",
        json,
      );
      return;
    }
    if (command === "tasks") {
      const state = await request<Snapshot>(d, "GET", "/api/state");
      print(
        json
          ? state.tasks
          : state.tasks
              .map(
                (task) => `${task.id}  ${task.title}
  ${task.progress}
  工作目录：${task.cwd}`,
              )
              .join("\n\n") || "暂无任务。使用 acd send <消息> 开始。",
        json,
      );
      return;
    }
    if (command === "recover") {
      if (!sub || rest.length !== 1 || rest[0] !== "--stopped")
        throw new Error(
          "用法：acd recover <任务编号> --stopped。只有你已核实原执行停止后才能确认；此命令不会自动核对或停止执行端。",
        );
      print(
        await request(
          d,
          "POST",
          `/api/tasks/${encodeURIComponent(sub)}/reconcile`,
          { outcome: "stopped" },
        ),
        json,
      );
      return;
    }
    if (command === "stop" || command === "accept") {
      if (!sub) throw new Error(`用法：acd ${command} <任务编号>`);
      const result = await request<Snapshot>(
        d,
        "POST",
        `/api/tasks/${encodeURIComponent(sub)}/${command}`,
        {},
      );
      const task = result.tasks.find((task) => task.id === sub);
      print(
        json
          ? result
          : `${task?.title || sub}：${task?.progress || "操作已提交"}`,
        json,
      );
      return;
    }
    if (command === "answer") {
      if (!sub || !rest.length)
        throw new Error("用法：acd answer <问题编号> <选项>");
      print(
        await request(
          d,
          "POST",
          `/api/questions/${encodeURIComponent(sub)}/answer`,
          { choice: rest.join(" ") },
        ),
        json,
      );
      return;
    }
    if (command === "model") {
      if (!sub) {
        print((await request<Snapshot>(d, "GET", "/api/state")).model, json);
        return;
      }
      if (sub !== "configure") throw new Error("用法：acd model configure");
      print(
        modelProviders
          .map((p, i) => i + 1 + ". " + p.name + " (" + p.id + ")")
          .join("\n"),
        false,
      );
      const choice =
        (await ask("选择模型服务商（编号或ID，默认1）：")).trim() || "1";
      const provider = modelProviders.find(
        (p, i) => p.id === choice || String(i + 1) === choice,
      );
      if (!provider) throw Error("未知模型服务商");
      const baseUrl =
        (
          await ask(
            "接口地址（留空使用 " + (provider.baseUrl || "自定义地址") + "）：",
          )
        ).trim() || provider.baseUrl;
      const model =
        (
          await ask(
            "模型名称（默认 " + (provider.models[0]?.id || "请填写") + "）：",
          )
        ).trim() ||
        provider.models[0]?.id ||
        "";
      const protocol =
        provider.id === "custom"
          ? (
              await ask(
                "接口协议（openai-chat / anthropic-messages，默认openai-chat）：",
              )
            ).trim() || "openai-chat"
          : provider.protocol;
      const apiKey = await askSecret(
        requiresModelKey({ providerId: provider.id, baseUrl })
          ? "API Key（不回显；仅同一服务可留空保留）："
          : "API Key（本机服务可留空；不回显）：",
      );
      const result = await request<Snapshot>(d, "PUT", "/api/model", {
        providerId: provider.id,
        protocol,
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {}),
      });
      print(
        json
          ? result
          : `总控模型已保存：${provider.name} / ${result.model?.model}。保存未调用模型。`,
        json,
      );
      return;
    }
    if (command === "doctor") {
      const state = await request<Snapshot>(d, "GET", "/api/state");
      print(
        {
          service: "running",
          protocol: PROTOCOL,
          agentsFound: state.agents.length,
          agentsSelected: state.agents.filter((a) => a.selected).length,
          modelConfigured: Boolean(state.model),
          keyConfigured: Boolean(state.model?.hasKey),
          keyRequired: state.model
            ? requiresModelKey({
                providerId: state.model.providerId || "custom",
                baseUrl: state.model.baseUrl,
              })
            : true,
          note: "发现安装不代表已认证；只有真实执行能验证 Agent 可用性。",
        },
        json,
      );
    }
  } catch (error) {
    stderr.write(`ACD: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await runCli();
