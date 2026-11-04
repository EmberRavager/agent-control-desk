import { memoryInputSchema } from "../contracts/memory.js";
import { scheduleInputSchema } from "../contracts/schedules.js";
import {
  noticeFeed,
  noticeReport,
  readNotices,
  claimNotices,
  settleNotices,
} from "./notifications.js";
import { createServer, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  openSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  closeSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Store } from "./store.js";
import { Runtime, type Dependencies } from "./runtime.js";
import { agentCapabilities } from "./allocation.js";
import { CompletionReporter } from "./completion.js";
import { emptyNativeContext } from "./native-context.js";
import type {
  NativeInsight,
  NativeSession,
  AgentObservation,
  ModelConfig,
  Snapshot,
  SkillCatalog,
} from "../contracts/index.js";
import {
  createSkill,
  trashSkill,
  listSkillTrash,
  restoreSkill,
} from "./skill-mutations.js";
import {
  scanSkills,
  readSkill,
  skillRoots,
  localizeSkillCatalog,
} from "./skills.js";
import { CodexLiveEvents } from "./codex-live-events.js";
import {
  readCodexSessions,
  NativeObserver,
  type ReadNativeSessions,
} from "./native-observation.js";
import { dataDirectory } from "./paths.js";
import { WeChatChannel } from "./wechat/channel.js";
import { WeChatClient, type WeChatSecret } from "./wechat/client.js";
import { SystemVault, WeChatVault } from "./secrets.js";
import { scanAgents, createAdapter, verifyAgent } from "./agents.js";
export async function startServer(
  options: {
    directory?: string;
    port?: number;
    deps?: Dependencies;
    skillHome?: string;
    nativeRead?: ReadNativeSessions;
    wechat?: { vault: WeChatSecret; client?: WeChatClient };
  } = {},
) {
  const directory = options.directory || dataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "service.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    const pid = Number(readFileSync(lock, "utf8"));
    try {
      process.kill(pid, 0);
      throw Error("ACD 服务已运行");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    unlinkSync(lock);
    fd = openSync(lock, "wx", 0o600);
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  const capabilities = [
    "model-catalog",
    "personal-memory",
    "message-idempotency",
    "wechat",
    "wechat-test",
    "wechat-reports",
    "notifications",
    "notification-report-detail",
    "skill-translation",
    "native-observation",
    "native-insight",
    "completion-reports",
    "routing-retry",
    "agent-allocation",
    "allocation-priority",
    "schedules",
    "i18n",
  ];
  const environment =
    options.deps || options.wechat || options.nativeRead ? "test" : "live";
  const token = randomBytes(32).toString("hex"),
    store = new Store(directory),
    runtime = new Runtime(
      store,
      options.deps || {
        scan: scanAgents,
        verify: verifyAgent,
        adapter: createAdapter,
        vault: new SystemVault(),
      },
      environment,
    );
  const wechat = new WeChatChannel(
    runtime,
    options.wechat?.vault || new WeChatVault(directory),
    options.wechat?.client,
  );
  await wechat.init();
  const liveEvents = new CodexLiveEvents(
    undefined,
    undefined,
    undefined,
    () => runtime.preferences().locale,
  );
  const reporter =
    !options.deps || options.deps.report
      ? new CompletionReporter(runtime, (sessionId, turnId) =>
          liveEvents.context(sessionId, turnId),
        )
      : undefined;
  const nativeRead: ReadNativeSessions =
    options.nativeRead ||
    (async (agent, cwd, signal) => {
      try {
        return await readCodexSessions(agent, cwd, signal);
      } catch {
        signal.throwIfAborted();
        return liveEvents.read(agent, cwd, signal);
      }
    });
  const observer =
    !options.deps || options.nativeRead
      ? new NativeObserver(runtime, nativeRead)
      : undefined;

  const insightCache = new Map<
    string,
    { at: number; value: NativeInsight; fingerprint: string }
  >();
  const insightRequests = new Map<string, Promise<NativeInsight>>();
  const insightKey = (session: NativeSession, model: ModelConfig | null) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          session.id,
          session.turnId,
          session.status,
          model,
          runtime.preferences().locale,
        ]),
      )
      .digest("hex");
  async function nativeInsight(
    session: NativeSession,
    observation: AgentObservation,
    model: ModelConfig | null,
    force = false,
  ): Promise<NativeInsight> {
    const locale = runtime.preferences().locale;
    const key = insightKey(session, model);
    const cached = insightCache.get(key);
    if (!force && cached && Date.now() - cached.at < 30000) return cached.value;
    let pending = insightRequests.get(key);
    if (!pending) {
      pending = (async () => {
        const context =
          observation.source === "run-events"
            ? await liveEvents.context(session.sessionId, session.turnId)
            : emptyNativeContext();
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              context,
              status: session.status,
              progress: session.progress,
            }),
          )
          .digest("hex");
        if (!force && cached?.fingerprint === fingerprint) {
          cached.at = Date.now();
          return cached.value;
        }
        if (JSON.stringify(runtime.snapshot().model) !== JSON.stringify(model))
          throw Error(runtime.tr("总控模型已更改，请重新分析。"));
        const value = await runtime.analyzeNativeSession(session, context);
        if (runtime.preferences().locale !== locale)
          throw Error(runtime.tr("语言设置已更改，请重新分析。"));
        if (insightCache.size >= 100)
          insightCache.delete(insightCache.keys().next().value!);
        insightCache.set(key, { at: Date.now(), value, fingerprint });
        if (context.request || context.requests.length)
          runtime.updateNativeTitle(
            session,
            model,
            value.title,
            createHash("sha256")
              .update(JSON.stringify(value.requirements))
              .digest("hex"),
          );
        return value;
      })().finally(() => insightRequests.delete(key));
      insightRequests.set(key, pending);
    }
    return pending;
  }
  // New active turns get one shared analysis. Observation heartbeats do not
  // trigger repeated model calls; failures wait a minute before retrying.
  const titleAttempts = new Map<string, number>();
  let titling = false,
    insightsClosed = false;
  function identifyNativeTask(snapshot: Snapshot) {
    if (insightsClosed || titling || !snapshot.model) return;
    for (const observation of snapshot.observations || []) {
      if (observation.state !== "connected") continue;
      const session = observation.sessions.find(
        (item) =>
          ["running", "waiting_input"].includes(item.status) &&
          !item.taskTitle &&
          Date.now() -
            (titleAttempts.get(insightKey(item, snapshot.model)) || 0) >=
            60000,
      );
      if (!session) continue;
      titling = true;
      if (titleAttempts.size >= 100)
        titleAttempts.delete(titleAttempts.keys().next().value!);
      titleAttempts.set(insightKey(session, snapshot.model), Date.now());
      void nativeInsight(session, observation, snapshot.model)
        .catch(() => {
          // The task remains visible and its detail page provides manual retry.
        })
        .finally(() => {
          titling = false;
          if (!insightsClosed) identifyNativeTask(runtime.snapshot());
        });
      return;
    }
  }
  runtime.on("state", identifyNativeTask);
  let skillScanGeneration = 0;
  const skillCatalog = (): SkillCatalog =>
    localizeSkillCatalog(
      store.get<SkillCatalog>("settings", "skills") || {
        skills: [],
        roots: [],
        warnings: [],
        scannedAt: null,
      },
      runtime.preferences().locale,
    );
  const skillSources = () =>
    skillCatalog().roots.length
      ? skillCatalog().roots
      : skillRoots(options.skillHome);
  const refreshSkills = async () => {
    const catalog = await scanSkills({
      home: options.skillHome,
      projectPath: skillCatalog().projectPath,
    });
    store.put("settings", "skills", catalog);
    return skillCatalog();
  };
  const peers = new Set<ServerResponse>();
  const broadcast = (snapshot: unknown) => {
    const frame = "event: state\ndata: " + JSON.stringify(snapshot) + "\n\n";
    for (const peer of peers) {
      if (peer.writableLength > 1024 * 1024) {
        peer.destroy();
        peers.delete(peer);
      } else peer.write(frame);
    }
  };
  runtime.on("state", broadcast);
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const json = (code: number, value: unknown) => {
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.origin) {
        json(403, { error: runtime.tr("此服务只接受本机客户端") });
        return;
      }
      if (req.method === "GET" && req.url === "/api/health") {
        json(200, { protocol: 1, pid: process.pid, capabilities, environment });
        return;
      }
      const supplied = Buffer.from(req.headers.authorization || ""),
        expected = Buffer.from("Bearer " + token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        json(401, { error: runtime.tr("客户端未认证") });
        return;
      }
      if (req.method === "GET" && req.url === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        });
        res.write(
          "event: state\ndata: " + JSON.stringify(runtime.snapshot()) + "\n\n",
        );
        peers.add(res);
        req.on("close", () => peers.delete(res));
        return;
      }
      if (req.method === "GET" && req.url === "/api/preferences") {
        json(200, runtime.preferences());
        return;
      }
      if (req.method === "GET" && req.url === "/api/memories") {
        json(200, runtime.memories.list());
        return;
      }
      if (req.method === "GET" && req.url === "/api/allocation") {
        json(200, runtime.allocationSettings());
        return;
      }
      if (req.method === "GET" && req.url === "/api/state") {
        json(200, runtime.snapshot());
        return;
      }
      if (
        req.method === "GET" &&
        /^\/api\/notifications\/[a-f0-9]{64}\/report$/.test(req.url || "")
      ) {
        const report = noticeReport(store, req.url!.split("/")[3]);
        if (report) json(200, report);
        else json(404, { error: runtime.tr("这份报告不可用") });
        return;
      }
      if (
        req.method === "GET" &&
        /^\/api\/notifications(?:\?before=[a-f0-9]{64})?$/.test(req.url || "")
      ) {
        const before =
          new URL(req.url!, "http://127.0.0.1").searchParams.get("before") ||
          undefined;
        json(200, noticeFeed(store, runtime.snapshot(), before));
        return;
      }
      if (req.method === "GET" && req.url === "/api/schedules") {
        json(200, runtime.schedules.list());
        return;
      }
      if (
        req.method === "GET" &&
        /^\/api\/schedules\/[a-f0-9-]{36}(?:\/runs)?$/.test(req.url || "")
      ) {
        const id = z.uuid().parse(req.url!.split("/")[3]);
        if (!runtime.schedules.list().some((schedule) => schedule.id === id)) {
          json(404, { error: runtime.tr("定时任务不存在") });
          return;
        }
        json(
          200,
          req.url!.endsWith("/runs")
            ? runtime.schedules.runs(id)
            : runtime.schedules.get(id),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/api/wechat") {
        json(200, wechat.status());
        return;
      }
      if (req.method === "GET" && req.url === "/api/skills/trash") {
        json(200, await listSkillTrash(skillSources()));
        return;
      }
      if (req.method === "GET" && req.url === "/api/skills") {
        json(200, skillCatalog());
        return;
      }
      if (
        req.method === "GET" &&
        /^\/api\/skills\/[^/]+$/.test(req.url || "")
      ) {
        const catalog = skillCatalog();
        const skill = catalog.skills.find(
          (s) => s.id === decodeURIComponent(req.url!.split("/")[3]),
        );
        if (!skill) {
          json(404, {
            error: runtime.tr("技能不在当前扫描结果中，请重新扫描"),
          });
          return;
        }
        json(200, await readSkill(skill, catalog.roots));
        return;
      }
      if (!["POST", "PUT"].includes(req.method || "")) {
        json(404, { error: runtime.tr("接口不存在") });
        return;
      }
      if (!(req.headers["content-type"] || "").startsWith("application/json")) {
        json(415, { error: runtime.tr("需要 JSON 请求") });
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) {
          json(413, { error: runtime.tr("消息过长") });
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (req.method === "PUT" && req.url === "/api/preferences") {
        const input = z
          .object({ locale: z.enum(["zh-CN", "en"]) })
          .strict()
          .parse(body);
        json(200, runtime.configurePreferences(input));
        return;
      }
      if (req.method === "POST" && req.url === "/api/memories") {
        json(201, runtime.memories.create(memoryInputSchema.parse(body)));
        return;
      }
      const memoryRoute = /^\/api\/memories\/([a-f0-9-]{36})(\/delete)?$/.exec(
        req.url || "",
      );
      if (memoryRoute) {
        const id = z.uuid().parse(memoryRoute[1]);
        const revision = z.number().int().positive();
        if (req.method === "PUT" && !memoryRoute[2]) {
          const { expectedRevision, ...input } = memoryInputSchema
            .extend({ expectedRevision: revision })
            .parse(body);
          json(200, runtime.memories.update(id, input, expectedRevision));
          return;
        }
        if (req.method === "POST" && memoryRoute[2]) {
          const { expectedRevision } = z
            .strictObject({ expectedRevision: revision })
            .parse(body);
          runtime.memories.remove(id, expectedRevision);
          json(200, { ok: true });
          return;
        }
        json(404, { error: runtime.tr("接口不存在") });
        return;
      }
      if (req.method === "POST" && req.url === "/api/schedules") {
        json(201, runtime.schedules.create(scheduleInputSchema.parse(body)));
        return;
      }
      if (
        (req.method === "POST" || req.method === "PUT") &&
        /^\/api\/schedules\/[a-f0-9-]{36}(?:\/(?:pause|resume|delete))?$/.test(
          req.url || "",
        )
      ) {
        const [, , , rawId, operation] = req.url!.split("/");
        const id = z.uuid().parse(rawId);
        if (!runtime.schedules.list().some((schedule) => schedule.id === id)) {
          json(404, { error: runtime.tr("定时任务不存在") });
          return;
        }
        if (req.method === "PUT" && !operation) {
          json(
            200,
            runtime.schedules.update(id, scheduleInputSchema.parse(body)),
          );
          return;
        }
        if (req.method === "POST" && operation) {
          z.object({}).strict().parse(body);
          json(
            200,
            runtime.schedules.control(
              id,
              operation as "pause" | "resume" | "delete",
            ),
          );
          return;
        }
        json(404, { error: runtime.tr("接口不存在") });
        return;
      }
      if (
        req.method === "POST" &&
        /^\/api\/reports\/[a-f0-9]{64}\/retry$/.test(req.url || "")
      ) {
        z.object({}).strict().parse(body);
        if (!reporter) throw Error(runtime.tr("当前测试后台未启用结果汇报。"));
        reporter.retry(req.url!.split("/")[3]);
        json(200, runtime.snapshot());
      } else if (
        req.method === "POST" &&
        /^\/api\/observations\/native-[a-f0-9]{24}\/analyze$/.test(
          req.url || "",
        )
      ) {
        const { force } = z
          .object({ force: z.boolean().optional() })
          .strict()
          .parse(body);
        const snapshot = runtime.snapshot();
        const id = req.url!.split("/")[3];
        const observation = snapshot.observations?.find((item) =>
          item.sessions.some((session) => session.id === id),
        );
        const session = observation?.sessions.find((item) => item.id === id);
        if (!session || !observation) {
          json(404, {
            error: runtime.tr("会话已离开当前观测范围，请刷新后重试。"),
          });
          return;
        }
        json(
          200,
          await nativeInsight(session, observation, snapshot.model, force),
        );
      } else if (
        req.method === "POST" &&
        req.url === "/api/observations/refresh"
      ) {
        z.object({}).strict().parse(body);
        await observer?.refresh();
        json(200, runtime.snapshot());
      } else if (
        req.method === "PUT" &&
        req.url === "/api/notifications/preferences"
      ) {
        const input = z
          .object({
            desktop: z.boolean(),
            sound: z.boolean(),
            details: z.boolean(),
            background: z.boolean(),
            attention: z.boolean(),
            result: z.boolean(),
            error: z.boolean(),
          })
          .strict()
          .parse(body);
        store.put("settings", "notifications", input);
        runtime.publish();
        json(200, runtime.snapshot());
      } else if (
        req.method === "POST" &&
        req.url === "/api/notifications/read"
      ) {
        const input = z
          .union([
            z
              .object({
                ids: z
                  .array(z.string().regex(/^[a-f0-9]{64}$/))
                  .min(1)
                  .max(100),
              })
              .strict(),
            z
              .object({ throughId: z.string().regex(/^[a-f0-9]{64}$/) })
              .strict(),
          ])
          .parse(body);
        readNotices(store, input);
        runtime.publish();
        json(200, runtime.snapshot());
      } else if (
        req.method === "POST" &&
        req.url === "/api/notifications/claim"
      ) {
        const input = z
          .object({
            ids: z
              .array(z.string().regex(/^[a-f0-9]{64}$/))
              .min(1)
              .max(100),
          })
          .strict()
          .parse(body);
        const items = claimNotices(store, runtime.snapshot(), input.ids);
        runtime.publish();
        json(200, items);
      } else if (
        req.method === "POST" &&
        req.url === "/api/notifications/settle"
      ) {
        const input = z
          .object({
            ids: z
              .array(z.string().regex(/^[a-f0-9]{64}$/))
              .min(1)
              .max(100),
            outcome: z.enum([
              "submitted",
              "failed",
              "suppressed",
              "unverified",
            ]),
          })
          .strict()
          .parse(body);
        settleNotices(store, input.ids, input.outcome);
        runtime.publish();
        json(200, { ok: true });
      } else if (req.method === "POST" && req.url === "/api/wechat/login") {
        const input = z
          .object({
            cwd: z.string().min(1).max(4096).refine(isAbsolute),
            notifications: z.boolean(),
            completionReports: z.boolean().optional(),
          })
          .parse(body);
        json(
          200,
          await wechat.begin(
            input.cwd,
            input.notifications,
            input.completionReports,
          ),
        );
      } else if (req.method === "POST" && req.url === "/api/wechat/configure") {
        const input = z
          .object({
            cwd: z.string().min(1).max(4096).refine(isAbsolute),
            notifications: z.boolean(),
            completionReports: z.boolean().optional(),
          })
          .parse(body);
        json(
          200,
          await wechat.configure(
            input.cwd,
            input.notifications,
            input.completionReports,
          ),
        );
      } else if (req.method === "POST" && req.url === "/api/wechat/test") {
        z.object({}).strict().parse(body);
        json(200, await wechat.testMessage());
      } else if (req.method === "POST" && req.url === "/api/wechat/verify") {
        json(
          200,
          wechat.verify(
            z.object({ code: z.string().regex(/^\d{4,8}$/) }).parse(body).code,
          ),
        );
      } else if (req.method === "POST" && req.url === "/api/wechat/pause") {
        json(200, await wechat.setPaused());
      } else if (req.method === "POST" && req.url === "/api/wechat/resume") {
        json(200, await wechat.resume());
      } else if (
        req.method === "POST" &&
        req.url === "/api/wechat/disconnect"
      ) {
        json(200, await wechat.disconnect());
      } else if (
        req.method === "POST" &&
        /^\/api\/skills\/[^/]+\/translate$/.test(req.url || "")
      ) {
        const catalog = skillCatalog();
        const skill = catalog.skills.find(
          (item) => item.id === decodeURIComponent(req.url!.split("/")[3]),
        );
        if (!skill) {
          json(404, {
            error: runtime.tr("技能不在当前扫描结果中，请重新扫描"),
          });
          return;
        }
        const detail = await readSkill(skill, catalog.roots);
        json(200, await runtime.translateSkill(detail));
      } else if (req.method === "POST" && req.url === "/api/skills") {
        const input = z
          .object({
            rootPath: z.string().min(1).max(4096),
            name: z.string().min(1).max(64),
            description: z.string().min(1).max(1024),
            content: z.string().min(1).max(48000),
          })
          .parse(body);
        await createSkill(input, skillSources());
        json(201, await refreshSkills());
      } else if (
        req.method === "POST" &&
        /^\/api\/skills\/[^/]+\/trash$/.test(req.url || "")
      ) {
        const catalog = skillCatalog();
        const record = catalog.skills.find(
          (s) => s.id === decodeURIComponent(req.url!.split("/")[3]),
        );
        if (!record) {
          json(404, {
            error: runtime.tr("技能不在当前扫描结果中，请重新扫描"),
          });
          return;
        }
        const entry = await trashSkill(record, skillSources(), catalog.skills);
        await refreshSkills();
        json(200, entry);
      } else if (
        req.method === "POST" &&
        /^\/api\/skills\/trash\/[^/]+\/restore$/.test(req.url || "")
      ) {
        await restoreSkill(
          decodeURIComponent(req.url!.split("/")[4]),
          skillSources(),
        );
        json(200, await refreshSkills());
      } else if (req.method === "POST" && req.url === "/api/skills/scan") {
        const input = z
          .object({
            projectPath: z
              .string()
              .min(1)
              .max(4096)
              .refine(isAbsolute)
              .optional(),
          })
          .parse(body);
        const projectPath = input.projectPath
          ? realpathSync(input.projectPath)
          : undefined;
        if (projectPath && !statSync(projectPath).isDirectory())
          throw Error(runtime.tr("请选择有效项目目录"));
        const generation = ++skillScanGeneration;
        const catalog = await scanSkills({
          home: options.skillHome,
          projectPath,
        });
        if (generation === skillScanGeneration)
          store.put("settings", "skills", catalog);
        json(200, localizeSkillCatalog(catalog, runtime.preferences().locale));
      } else if (req.method === "POST" && req.url === "/api/agents/manual") {
        const input = z
          .object({ executable: z.string().min(1).max(4096) })
          .parse(body);
        json(200, await runtime.addAgent(input.executable));
      } else if (req.method === "POST" && req.url === "/api/agents/scan") {
        json(200, await runtime.scan());
      } else if (req.method === "PUT" && req.url === "/api/agents") {
        await runtime.select(
          z.object({ ids: z.array(z.string()).max(30) }).parse(body).ids,
        );
        json(200, runtime.snapshot());
      } else if (req.method === "PUT" && req.url === "/api/allocation") {
        const id = z.string().min(1).max(200);
        const projectPath = z.string().min(1).max(32768).optional();
        const input = z
          .union([
            z.object({ agentIds: z.array(id).max(30), projectPath }).strict(),
            z.object({ agentId: id.nullable(), projectPath }).strict(),
          ])
          .parse(body);
        json(200, runtime.configureAllocation(input));
      } else if (req.method === "POST" && req.url === "/api/model/models") {
        const input = z
          .object({
            providerId: z.string().max(100).optional(),
            baseUrl: z.string().max(2000).optional(),
            protocol: z.enum(["openai-chat", "anthropic-messages"]).optional(),
            apiKey: z.string().trim().min(1).max(10000).optional(),
          })
          .parse(body);
        json(200, await runtime.modelCatalog(input));
      } else if (req.method === "PUT" && req.url === "/api/model") {
        await runtime.configure(
          z
            .object({
              baseUrl: z.string().max(2000).optional(),
              providerId: z.string().max(100).optional(),
              protocol: z
                .enum(["openai-chat", "anthropic-messages"])
                .optional(),
              model: z.string().max(200),
              apiKey: z.string().max(10000).optional(),
            })
            .parse(body),
        );
        json(200, runtime.snapshot());
      } else if (
        req.method === "POST" &&
        /^\/api\/messages\/[a-f0-9-]{36}\/retry$/.test(req.url || "")
      ) {
        z.object({}).strict().parse(body);
        const id = z.uuid().parse(req.url!.split("/")[3]);
        json(202, runtime.retryRouting(id));
      } else if (req.method === "POST" && req.url === "/api/messages") {
        const input = z
          .object({
            text: z.string().trim().min(1).max(20000),
            cwd: z.string().min(1),
            targetTaskId: z.string().optional(),
            targetAgentId: z.string().min(1).max(200).optional(),
            requiredCapabilities: z
              .array(z.enum(agentCapabilities))
              .max(4)
              .optional(),
            clientMessageId: z.uuid().optional(),
          })
          .parse(body);
        json(
          202,
          runtime.receive(
            input.text,
            input.cwd,
            input.targetTaskId,
            input.clientMessageId,
            undefined,
            {
              targetAgentId: input.targetAgentId,
              requiredCapabilities: input.requiredCapabilities,
            },
          ),
        );
      } else if (
        req.method === "POST" &&
        /^\/api\/tasks\/[^/]+\/(stop|accept|reconcile)$/.test(req.url || "")
      ) {
        const parts = req.url!.split("/");
        const id = decodeURIComponent(parts[3]);
        if (parts[4] === "stop") await runtime.stop(id);
        else if (parts[4] === "reconcile") {
          z.object({ outcome: z.literal("stopped") }).parse(body);
          runtime.reconcile(id);
        } else runtime.accept(id);
        json(200, runtime.snapshot());
      } else if (
        req.method === "POST" &&
        /^\/api\/questions\/[^/]+\/answer$/.test(req.url || "")
      ) {
        const input = z
          .object({ choice: z.string().trim().min(1).max(2000) })
          .parse(body);
        await runtime.answer(
          decodeURIComponent(req.url!.split("/")[3]),
          input.choice,
        );
        json(200, runtime.snapshot());
      } else if (req.method === "POST" && req.url === "/api/shutdown") {
        json(200, { ok: true });
        setTimeout(() => void close(), 30);
      } else json(404, { error: runtime.tr("接口不存在") });
    } catch (e) {
      if (!res.headersSent)
        json(
          e instanceof Error &&
            "statusCode" in e &&
            (e.statusCode === 409 || e.statusCode === 404)
            ? e.statusCode
            : 400,
          {
            error:
              e instanceof z.ZodError
                ? runtime.tr("请求参数无效")
                : e instanceof Error
                  ? runtime.userError(e)
                  : runtime.tr("操作失败"),
          },
        );
      else res.destroy();
    }
  });
  const heartbeat = setInterval(() => {
    for (const p of peers) p.write(": heartbeat\n\n");
  }, 15000);
  heartbeat.unref();
  let closing: Promise<void> | undefined;
  function close() {
    return (closing ??= (async () => {
      insightsClosed = true;
      runtime.schedules.close();
      runtime.off("state", identifyNativeTask);
      clearInterval(heartbeat);
      await observer?.close();
      await reporter?.close();
      await wechat.close();
      runtime.shutdown();
      for (const p of peers) p.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      for (const file of [join(directory, "runtime.json"), lock])
        try {
          unlinkSync(file);
        } catch {}
    })());
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        options.port ?? Number(process.env.ACD_PORT || 4317),
        "127.0.0.1",
        () => resolve(),
      );
    });
  } catch (e) {
    clearInterval(heartbeat);
    runtime.shutdown();
    await observer?.close();
    await wechat.close();
    store.close();
    unlinkSync(lock);
    throw e;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error(runtime.tr("服务地址不可用"));
  const descriptor = {
    url: "http://127.0.0.1:" + address.port,
    token,
    protocol: 1,
    pid: process.pid,
    capabilities,
  };
  writeFileSync(join(directory, "runtime.json"), JSON.stringify(descriptor), {
    mode: 0o600,
  });
  runtime.schedules.start();
  reporter?.start();
  observer?.start();
  return { runtime, descriptor, wechat, close };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer()
    .then((app) => {
      let shutting = false;
      const stop = () => {
        if (shutting) return;
        shutting = true;
        void app.close().then(() => process.exit(0));
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
    })
    .catch(() => {
      console.error(
        "ACD service failed to start. Check the port, running instances, and data directory permissions.",
      );
      process.exitCode = 1;
    });
}
