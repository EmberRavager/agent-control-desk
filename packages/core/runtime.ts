import { Schedules } from "./schedules.js";
import { queueCompletion, type CompletionInput } from "./completion.js";
import { projectNotices, noticeFeed } from "./notifications.js";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import { EventEmitter } from "node:events";
import type {
  AgentAdapter,
  AgentConnection,
  Task,
  Message,
  Question,
  Snapshot,
  ModelConfig,
  RunHandle,
  AdapterEvent,
  RouteDecision,
  AgentObservation,
  NativeSession,
  NativeInsight,
  SkillDetail,
  SkillTranslation,
  AllocationRequest,
  AllocationSettings,
} from "../contracts/index.js";
import { Store } from "./store.js";
import { agentFromPath } from "./agents.js";
import {
  allocateAgent,
  effectiveCapabilities,
  exclusionReason,
  normalizeAllocation,
} from "./allocation.js";
import {
  resolveModelSettings,
  resolveModelConnection,
  requiresModelKey,
  type ModelConnectionInput,
} from "../contracts/providers.js";
import { fetchModelCatalog } from "./model-catalog.js";
import type { NativeActivityContext } from "./native-context.js";
import {
  route,
  clarifyTaskCollision,
  translateSkill,
  analyzeNativeSession,
  summarizeCompletion,
} from "./model.js";
import type { SecretVault } from "./secrets.js";
export interface Dependencies {
  now?: () => number;
  scan: () => Promise<AgentConnection[]>;
  verify?: (agent: AgentConnection) => Promise<AgentConnection>;
  adapter: (kind: AgentConnection["kind"]) => AgentAdapter;
  vault: SecretVault;
  route?: typeof route;
  report?: typeof summarizeCompletion;
}
const ended = (t: Task) =>
  ["review", "completed", "failed", "cancelled"].includes(t.status);
const overlaps = (a: string, b: string) => {
  const r = relative(a, b),
    s = relative(b, a);
  return (
    r === "" ||
    (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r)) ||
    (s !== ".." && !s.startsWith(".." + sep) && !isAbsolute(s))
  );
};
export class Runtime extends EventEmitter {
  readonly schedules: Schedules;
  private observations: AgentObservation[] = [];
  private nativeDirectories = new Map<
    string,
    { session: NativeSession; cwd: string; source: AgentObservation["source"] }
  >();
  private excludedNative = new Set<string>();
  private nativeTitles = new Map<
    string,
    {
      turnId?: string;
      model: string;
      title: string;
      requirementsKey?: string;
    }
  >();
  private handles = new Map<string, RunHandle>();
  private reserved = new Set<string>();
  private closed = false;
  private selectionGeneration = 0;
  private answering = new Set<string>();
  private routing = new Map<string, AbortController>();
  private deferredUpdates = new Map<string, string[]>();
  constructor(
    readonly store: Store,
    readonly deps: Dependencies,
    readonly environment: "live" | "test" = "test",
  ) {
    super();
    for (const entry of store.list<{ id?: string; ignored?: boolean }>(
      "native-executions",
    ))
      if (entry.ignored && entry.id) this.excludedNative.add(entry.id);
    for (const t of store.list<Task>("tasks"))
      if (t.status === "queued") {
        t.status = "blocked";
        t.progress = "服务已重启，任务尚未启动。可补充消息后继续。";
        store.put("tasks", t.id, t);
      }
    for (const t of store.list<Task>("tasks"))
      if (["running", "stopping", "waiting_input"].includes(t.status)) {
        t.status = "unknown";
        t.progress = "服务已重启，需要核对原会话；未自动重跑。";
        store.put("tasks", t.id, t);
      }
    for (const t of store.list<Task>("tasks"))
      if (t.status === "unknown") this.reserved.add(t.id);
    for (const q of store.list<Question>("questions"))
      if (q.taskId && !q.resolved)
        store.put("questions", q.id, { ...q, resolved: true });
    for (const message of store.pendingRoutingMessages()) {
      store.message({
        ...message,
        routing: {
          status: "interrupted",
          actions: [],
          retryable: Boolean(message.request),
          ...(message.routing?.attempt
            ? { attempt: message.routing.attempt }
            : {}),
        },
      });
    }
    this.schedules = new Schedules(this, deps.now);
    projectNotices(store, this.stateSnapshot());
  }
  snapshot(): Snapshot {
    const snapshot = this.stateSnapshot();
    snapshot.notifications = noticeFeed(this.store, snapshot);
    return snapshot;
  }
  private stateSnapshot(): Snapshot {
    const snapshot: Snapshot = {
      environment: this.environment,
      schedules: this.schedules?.list() || [],
      agents: this.store.list<AgentConnection>("agents").map((agent) => ({
        ...agent,
        capabilities: effectiveCapabilities(agent),
      })),
      allocationSettings: this.allocationSettings(),
      tasks: this.store.list("tasks"),
      messages: this.store
        .history()
        .filter(
          (message) =>
            message.completion?.status !== "withheld" &&
            (!message.completion?.nativeId ||
              !this.excludedNative.has(message.completion.nativeId)),
        ),
      questions: this.store.list("questions"),
      model: this.store.get("settings", "model") || null,
    };
    if (this.observations.length) {
      const owned = new Set(
        snapshot.tasks
          .filter((task) =>
            ["running", "waiting_input", "stopping"].includes(task.status),
          )
          .map((task) => task.sessionId)
          .filter(Boolean),
      );
      const observed = new Set<string>();
      snapshot.observations = this.observations
        .filter((item) =>
          snapshot.agents.some(
            (agent) => agent.id === item.agentId && agent.selected,
          ),
        )
        .map((item) => ({
          ...item,
          sessions: item.sessions
            .filter((session) => {
              if (
                owned.has(session.sessionId) ||
                observed.has(session.sessionId)
              )
                return false;
              observed.add(session.sessionId);
              return true;
            })
            .map((session) => {
              const title = this.nativeTitles.get(session.id);
              return title &&
                title.turnId === session.turnId &&
                title.model === JSON.stringify(snapshot.model)
                ? { ...session, taskTitle: title.title }
                : session;
            }),
        }));
    }
    return snapshot;
  }
  updateObservations(observations: AgentObservation[]) {
    if (this.closed) return;
    const selected = new Set(
      this.store
        .list<AgentConnection>("agents")
        .filter((agent) => agent.selected)
        .map((agent) => agent.id),
    );
    const owned = this.store.list<Task>("tasks");
    for (const observation of observations) {
      if (selected.has(observation.agentId))
        for (const id of observation.excludedSessionIds || []) {
          this.excludedNative.add(id);
          this.store.put("native-executions", id, {
            ...this.store.get<Record<string, unknown>>("native-executions", id),
            id,
            ignored: true,
          });
        }
      if (
        !selected.has(observation.agentId) ||
        observation.state !== "connected"
      )
        continue;
      for (const session of observation.sessions) {
        const previous = this.store.get<{
          session: NativeSession;
          runId: string;
          active: boolean;
        }>("native-executions", session.id);
        if (["running", "waiting_input"].includes(session.status)) {
          const sameRun =
            previous?.active && previous.session.turnId === session.turnId;
          this.store.put("native-executions", session.id, {
            session,
            active: true,
            runId: sameRun ? previous.runId : session.turnId || randomUUID(),
          });
        } else if (
          session.status === "idle" &&
          ((previous?.active && previous.session.turnId === session.turnId) ||
            (session.completionObserved && session.endedReason === "completed"))
        ) {
          this.store.put("native-executions", session.id, {
            session,
            runId: session.turnId || previous?.runId || randomUUID(),
            active: false,
          });
          if (session.endedReason === "aborted") continue;
          if (
            owned.some(
              (task) =>
                task.sessionId === session.sessionId &&
                (!task.turnId || task.turnId === session.turnId),
            )
          )
            continue;
          const name =
            this.store.get<AgentConnection>("agents", session.agentId)?.name ||
            "Agent";
          const title =
            this.nativeTitles.get(session.id)?.title || name + " 本轮任务";
          queueCompletion(this.store, {
            executionKey: `native:${session.id}:${session.turnId || previous!.runId}`,
            cwd: session.cwd,
            title,
            requirements: [],
            result: "",
            progress: session.progress,
            native: {
              id: session.id,
              sessionId: session.sessionId,
              turnId: session.turnId,
              agentName: name,
            },
          });
        }
      }
    }
    this.observations = observations;
    const ids = new Set(
      observations.flatMap((item) =>
        item.sessions.map((session) => session.id),
      ),
    );
    for (const id of this.nativeTitles.keys())
      if (!ids.has(id)) this.nativeTitles.delete(id);
    const released = this.updateNativeDirectories(
      observations,
      selected,
      owned,
    );
    this.publish();
    if (released) this.drain();
  }
  private updateNativeDirectories(
    observations: AgentObservation[],
    selected: Set<string>,
    tasks: Task[],
  ) {
    const next = new Map(this.nativeDirectories);
    for (const [id, held] of next) {
      const observation = observations.find(
        (o) => o.agentId === held.session.agentId,
      );
      // Only the complete loaded-thread API can establish absence. A missing
      // fallback record or a failed poll may hide a turn that is still active.
      if (
        this.excludedNative.has(id) ||
        (observation?.state === "connected" &&
          observation.source === "runtime-api" &&
          held.source === "runtime-api" &&
          !observation.sessions.some((s) => s.id === id))
      )
        next.delete(id);
    }
    for (const observation of observations) {
      if (!selected.has(observation.agentId)) continue;
      for (const session of observation.sessions) {
        if (this.excludedNative.has(session.id)) continue;
        const managed = tasks.some(
          (task) =>
            task.sessionId === session.sessionId &&
            ((this.reserved.has(task.id) &&
              (!session.turnId ||
                !task.turnId ||
                task.turnId === session.turnId)) ||
              (session.turnId &&
                task.turnId === session.turnId &&
                ended(task))),
        );
        if (
          managed ||
          session.status === "idle" ||
          session.status === "failed"
        ) {
          next.delete(session.id);
          continue;
        }
        if (
          (session.status !== "running" &&
            session.status !== "waiting_input") ||
          !isAbsolute(session.cwd)
        )
          continue;
        const held = next.get(session.id);
        let cwd = held?.cwd ?? session.cwd;
        if (
          !held ||
          held.session.cwd !== session.cwd ||
          held.session.turnId !== session.turnId
        ) {
          try {
            cwd = realpathSync(session.cwd);
          } catch {
            cwd = session.cwd;
          }
        }
        next.set(session.id, { session, cwd, source: observation.source });
      }
    }
    const released = [...this.nativeDirectories].some(
      ([id, held]) => next.get(id)?.cwd !== held.cwd,
    );
    this.nativeDirectories = next;
    return released;
  }
  updateNativeTitle(
    session: NativeSession,
    model: ModelConfig | null,
    title: string,
    requirementsKey?: string,
  ) {
    if (
      this.closed ||
      JSON.stringify(this.snapshot().model) !== JSON.stringify(model)
    )
      return;
    const current = this.snapshot()
      .observations?.flatMap((item) => item.sessions)
      .find((item) => item.id === session.id && item.turnId === session.turnId);
    if (
      !current ||
      (current.taskTitle &&
        this.nativeTitles.get(session.id)?.requirementsKey === requirementsKey)
    )
      return;
    this.nativeTitles.set(session.id, {
      turnId: session.turnId,
      model: JSON.stringify(model),
      title,
      requirementsKey,
    });
    this.publish();
  }
  publish() {
    const snapshot = this.stateSnapshot();
    projectNotices(this.store, snapshot);
    snapshot.notifications = noticeFeed(this.store, snapshot);
    this.emit("state", snapshot);
  }
  private save(t: Task) {
    t.updatedAt = new Date().toISOString();
    this.store.put("tasks", t.id, t);
    this.publish();
  }
  private say(
    text: string,
    role: Message["role"] = "assistant",
    taskIds: string[] = [],
    receipt?: {
      id?: string;
      request?: NonNullable<Message["request"]>;
      replyTo?: string;
    },
    attention = false,
  ) {
    const m: Message = {
      id: receipt?.id || randomUUID(),
      role,
      text,
      taskIds,
      createdAt: new Date().toISOString(),
      ...(role === "user"
        ? { routing: { status: "pending" as const, actions: [] } }
        : {}),
      ...(attention ? { attention: true } : {}),
      ...(receipt?.request
        ? { request: receipt.request, delivery: "received" as const }
        : {}),
      ...(receipt?.replyTo ? { replyTo: receipt.replyTo } : {}),
    };
    this.store.message(m);
    this.publish();
    return m;
  }
  private updateRouting(
    message: Message,
    status: "completed" | "failed",
    actions: RouteDecision["actions"] = [],
    retryable = false,
  ) {
    const current = this.store.getMessage(message.id) || message;
    this.store.message({
      ...current,
      routing: {
        status,
        actions: [...new Set(actions.map((action) => action.type))],
        ...(retryable ? { retryable: true } : {}),
        ...(current.routing?.attempt
          ? { attempt: current.routing.attempt }
          : {}),
      },
    });
    this.publish();
  }
  async scan() {
    const previous = this.snapshot().agents;
    const found = await this.deps.scan();
    for (const a of found) {
      a.selected = previous.find((p) => p.id === a.id)?.selected || false;
      this.store.put("agents", a.id, a);
    }
    for (const old of previous)
      if (
        old.discoverySource !== "manual" &&
        !found.some((a) => a.id === old.id)
      )
        this.store.put("agents", old.id, { ...old, available: false });
    this.publish();
    return this.snapshot().agents;
  }
  async addAgent(executable: string) {
    const agent = await agentFromPath(executable);
    const previous = this.store.get<AgentConnection>("agents", agent.id);
    this.store.put("agents", agent.id, {
      ...agent,
      selected: previous?.selected || false,
      discoverySource: "manual",
    });
    this.publish();
    return this.store.get<AgentConnection>("agents", agent.id);
  }
  async select(ids: string[]) {
    const generation = ++this.selectionGeneration;
    const all = this.snapshot().agents;
    if (
      ids.some(
        (id) =>
          !all.some(
            (a) =>
              a.id === id &&
              (a.available || a.verification === "failed") &&
              a.supported !== false,
          ),
      )
    )
      throw Error("所选 Agent 不存在、不可启动或尚未完成适配");
    for (const a of all)
      this.store.put("agents", a.id, {
        ...a,
        selected: false,
        ...(ids.includes(a.id)
          ? {
              verification: "checking",
              verificationMessage: "正在检查所选程序…",
            }
          : {}),
      });
    this.publish();
    for (const id of ids) {
      const a = all.find((x) => x.id === id)!;
      let checked: AgentConnection;
      try {
        checked = this.deps.verify ? await this.deps.verify(a) : a;
      } catch {
        checked = {
          ...a,
          available: false,
          verification: "failed",
          verificationMessage: "启动检查失败，请确认安装。",
        };
      }
      if (this.closed || generation !== this.selectionGeneration) return;
      this.store.put("agents", id, {
        ...checked,
        selected: checked.available && checked.supported !== false,
      });
      this.publish();
    }
    // Verification temporarily clears selected even for retained sources.
    // Drop their directory holds only when the user actually removes them.
    const previousSize = this.nativeDirectories.size;
    for (const [id, held] of this.nativeDirectories)
      if (!ids.includes(held.session.agentId))
        this.nativeDirectories.delete(id);
    if (this.nativeDirectories.size !== previousSize) this.drain();
  }

  async configure(input: {
    baseUrl?: string;
    model: string;
    apiKey?: string;
    providerId?: string;
    protocol?: "openai-chat" | "anthropic-messages";
  }) {
    const settings = resolveModelSettings(input);
    const { baseUrl } = settings;
    const previous = this.snapshot().model;
    if (
      previous &&
      new URL(previous.baseUrl).origin !== new URL(baseUrl).origin &&
      requiresModelKey(settings) &&
      !input.apiKey
    )
      throw Error("切换模型服务地址时，请明确填写用于该服务的 Key");
    if (!input.model.trim()) throw Error("请填写模型名");
    if (input.apiKey) await this.deps.vault.set(input.apiKey, baseUrl);
    const keyRelevant = Boolean(
      input.apiKey ||
      requiresModelKey(settings) ||
      (previous?.hasKey &&
        new URL(previous.baseUrl).origin === new URL(baseUrl).origin),
    );
    const hasKey = keyRelevant
      ? Boolean(await this.deps.vault.get(baseUrl))
      : false;
    if (!hasKey && requiresModelKey(settings))
      throw Error("请配置总控 API Key");
    const config: ModelConfig = { ...settings, hasKey };
    this.store.put("settings", "model", config);
    this.publish();
  }
  async analyzeNativeSession(
    session: NativeSession,
    context: NativeActivityContext,
  ): Promise<NativeInsight> {
    const config = this.snapshot().model;
    if (!config) throw Error("请先配置总控模型，再分析当前任务。");
    const key = config.hasKey
      ? await this.deps.vault.get(config.baseUrl)
      : null;
    if (
      !key &&
      requiresModelKey({
        providerId: config.providerId || "custom",
        baseUrl: config.baseUrl,
      })
    )
      throw Error("总控模型凭证不可用，请重新配置。");
    try {
      return await analyzeNativeSession(config, key || "", session, context);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        throw Error("任务分析超时，可稍后重新分析。");
      throw error;
    }
  }
  async summarizeCompletion(input: CompletionInput, signal?: AbortSignal) {
    const config = this.snapshot().model;
    if (!config) throw Error("配置总控模型后才能生成结果建议。");
    const key = config.hasKey
      ? await this.deps.vault.get(config.baseUrl)
      : null;
    if (
      !key &&
      requiresModelKey({
        providerId: config.providerId || "custom",
        baseUrl: config.baseUrl,
      })
    )
      throw Error("总控模型凭证不可用，请重新配置。");
    return (this.deps.report || summarizeCompletion)(
      config,
      key || "",
      input,
      signal,
    );
  }
  async translateSkill(detail: SkillDetail): Promise<SkillTranslation> {
    const config = this.snapshot().model;
    if (!config) throw Error("请先在设置中配置总控模型，再翻译技能。");
    const key = config.hasKey
      ? await this.deps.vault.get(config.baseUrl)
      : null;
    if (
      !key &&
      requiresModelKey({
        providerId: config.providerId || "custom",
        baseUrl: config.baseUrl,
      })
    )
      throw Error("总控模型凭证不可用，请在设置中重新配置。");
    try {
      return await translateSkill(config, key || "", detail);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError")
        throw Error("翻译请求超时，请稍后重试。");
      throw error;
    }
  }
  async modelCatalog(input: ModelConnectionInput & { apiKey?: string }) {
    const connection = resolveModelConnection(input);
    const previous = this.snapshot().model;
    const sameSavedOrigin =
      previous?.hasKey &&
      new URL(previous.baseUrl).origin === new URL(connection.baseUrl).origin;
    const key =
      input.apiKey?.trim() ||
      (sameSavedOrigin ? await this.deps.vault.get(connection.baseUrl) : null);
    if (!key && requiresModelKey(connection))
      throw Error("请先填写此服务的 API Key，再获取模型列表");
    return fetchModelCatalog(connection, key);
  }
  allocationSettings(): AllocationSettings {
    return (
      this.store.get<AllocationSettings>("settings", "allocation") || {
        globalAgentId: null,
        projectAgentIds: {},
      }
    );
  }
  configureAllocation(input: { agentId: string | null; projectPath?: string }) {
    if (this.closed) throw Error("服务正在退出");
    if (input.agentId !== null) {
      const agent = this.snapshot().agents.find(
        (item) => item.id === input.agentId,
      );
      if (!agent || exclusionReason(agent, []))
        throw Error("默认 Agent 必须已接入、可用且已适配");
    }
    const settings = this.allocationSettings();
    if (input.projectPath !== undefined) {
      if (!isAbsolute(input.projectPath)) throw Error("请选择项目的绝对路径");
      // A saved preference can be removed even after its project was deleted.
      if (
        input.agentId === null &&
        Object.hasOwn(settings.projectAgentIds, input.projectPath)
      ) {
        delete settings.projectAgentIds[input.projectPath];
      } else {
        const cwd = realpathSync(input.projectPath);
        if (!statSync(cwd).isDirectory()) throw Error("项目目录不存在");
        if (input.agentId === null) delete settings.projectAgentIds[cwd];
        else settings.projectAgentIds[cwd] = input.agentId;
      }
    } else settings.globalAgentId = input.agentId;
    this.store.put("settings", "allocation", settings);
    this.publish();
    return settings;
  }
  receive(
    text: string,
    cwd: string,
    targetTaskId?: string,
    clientMessageId?: string,
    replyTo?: string,
    options?: AllocationRequest,
  ) {
    const allocation = normalizeAllocation(options);
    if (this.closed) throw Error("服务正在退出");
    const canonical = realpathSync(cwd);
    if (!statSync(canonical).isDirectory()) throw Error("工作目录不存在");
    if (targetTaskId && !this.store.get<Task>("tasks", targetTaskId))
      throw Error("任务不存在");
    if (clientMessageId) {
      const previous = this.store.getMessage(clientMessageId);
      if (previous) {
        if (
          previous.role !== "user" ||
          previous.text !== text ||
          previous.request?.cwd !== canonical ||
          previous.request.targetTaskId !== targetTaskId ||
          JSON.stringify(normalizeAllocation(previous.request)) !==
            JSON.stringify(allocation) ||
          previous.replyTo !== replyTo
        )
          throw Error("此消息编号已用于其他内容，请重新发送新消息");
        return previous;
      }
    }
    const m = this.say(text, "user", targetTaskId ? [targetTaskId] : [], {
      id: clientMessageId,
      request: {
        cwd: canonical,
        ...(targetTaskId ? { targetTaskId } : {}),
        ...allocation,
      },
      ...(replyTo ? { replyTo } : {}),
    });
    this.scheduleRouting(m, canonical, targetTaskId);
    return m;
  }
  retryRouting(id: string) {
    if (this.closed) throw Error("服务正在退出");
    const message = this.store.getMessage(id);
    if (!message || message.role !== "user") throw Error("用户消息不存在");
    if (
      (message.routing?.status === "pending" && this.routing.has(id)) ||
      (message.routing?.status === "completed" &&
        (message.routing.attempt || 0) > 0)
    )
      return message;
    if (
      !message.routing?.retryable ||
      !["failed", "interrupted"].includes(message.routing.status) ||
      !message.request
    )
      throw Error(
        "这条消息不能安全重新判断，请先核对已有任务或作为新消息说明要求。",
      );
    const { cwd, targetTaskId } = message.request;
    let directoryMatches = false;
    try {
      directoryMatches =
        realpathSync(cwd) === cwd && statSync(cwd).isDirectory();
    } catch {}
    if (!directoryMatches)
      throw Error("原工作目录已改变或不可访问，请重新选择目录后发送新消息。");
    if (targetTaskId && !this.store.get<Task>("tasks", targetTaskId))
      throw Error("原目标任务已不存在，请重新选择目标。");
    const pending = {
      ...message,
      routing: {
        status: "pending" as const,
        actions: [],
        attempt: (message.routing.attempt || 0) + 1,
      },
    };
    this.store.message(pending);
    this.scheduleRouting(pending, cwd, targetTaskId);
    this.publish();
    return this.store.getMessage(id)!;
  }
  private scheduleRouting(
    m: Message,
    canonical: string,
    targetTaskId?: string,
  ) {
    const controller = new AbortController();
    this.routing.set(m.id, controller);
    void this.process(m, canonical, targetTaskId, controller.signal)
      .catch(() => {
        if (!this.closed) {
          const current = this.store.getMessage(m.id);
          const beforeActions = current?.routing?.status === "pending";
          if (beforeActions) this.updateRouting(m, "failed", [], true);
          this.say(
            beforeActions
              ? "总控处理失败，消息已保存。可在原消息上重新判断。"
              : "部分操作可能已提交，请核对任务状态；没有自动重试操作。",
            "assistant",
            [],
            { replyTo: m.id },
            true,
          );
        }
      })
      .finally(() => {
        if (this.routing.get(m.id) === controller) this.routing.delete(m.id);
      });
  }
  private async process(
    m: Message,
    cwd: string,
    targetTaskId?: string,
    signal?: AbortSignal,
  ) {
    const reply = (
      text: string,
      role: Message["role"] = "assistant",
      taskIds: string[] = [],
      attention = false,
    ) => this.say(text, role, taskIds, { replyTo: m.id }, attention);
    const snapshot = this.snapshot();
    if (!snapshot.model) {
      this.updateRouting(m, "failed", [], true);
      reply(
        "请先配置独立总控模型。消息已保存，尚未执行。",
        "assistant",
        [],
        true,
      );
      return;
    }
    const key = snapshot.model.hasKey
      ? await this.deps.vault.get(snapshot.model.baseUrl)
      : null;
    if (this.closed) return;
    if (
      !key &&
      requiresModelKey({
        providerId: snapshot.model.providerId || "custom",
        baseUrl: snapshot.model.baseUrl,
      })
    ) {
      this.updateRouting(m, "failed", [], true);
      reply("总控凭证不可用，请重新配置。", "assistant", [], true);
      return;
    }
    let decision: RouteDecision;
    try {
      decision = await (this.deps.route || route)(
        snapshot.model,
        key || "",
        snapshot,
        m.text,
        cwd,
        targetTaskId,
        signal,
        normalizeAllocation(m.request),
      );
    } catch (error) {
      if (this.closed) return;
      this.updateRouting(m, "failed", [], true);
      reply(
        error instanceof Error && error.name === "TimeoutError"
          ? "总控模型请求超时。消息已保存，尚未分配执行；请检查模型响应或重试。"
          : "总控模型暂不可用或返回格式不正确。消息已保存，未分配执行。",
        "assistant",
        [],
        true,
      );
      return;
    }
    if (this.closed) return;
    const actions = [...decision.actions];
    this.updateRouting(m, "completed", actions);
    let actionFailed = false;
    for (const [index, proposed] of actions.entries()) {
      if (this.closed) return;
      try {
        let a = proposed;
        if (a.type === "create") {
          if (realpathSync(a.cwd) !== cwd)
            throw Error("新任务试图超出本条消息的工作目录");
          // Routing can overlap. Check the live tasks in the same synchronous
          // turn that persists a successful create, including earlier actions.
          const collision = clarifyTaskCollision(
            this.store.list<Task>("tasks"),
            cwd,
            a.title,
            m.text,
          );
          if (collision) {
            a = collision;
            actions[index] = collision;
            this.updateRouting(m, "completed", actions);
          }
        }
        if (a.type === "create") {
          const { agent, allocation } = allocateAgent({
            agents: this.snapshot().agents,
            cwd,
            settings: this.allocationSettings(),
            request: {
              ...normalizeAllocation(m.request),
              targetAgentId: m.request?.targetAgentId || a.requestedAgentId,
            },
            requiredCapabilities: a.requiredCapabilities,
            suggestedAgentId: a.agentId,
          });
          const t = this.prepareTask(
            {
              title: a.title,
              goal: a.goal,
              cwd,
              agentId: agent.id,
              allocation,
            },
            m.id,
          );
          this.dispatchPreparedTask(t);
          reply("已创建任务：" + t.title, "assistant", [t.id]);
        } else if (a.type === "schedule_create") {
          if (
            m.request?.targetAgentId ||
            m.request?.requiredCapabilities?.length
          )
            throw Error(
              "本次执行者和能力选择用于立即创建的任务。定时计划请在“定时任务”页面选择执行者，或清除本次选择后重发；消息已保留。",
            );
          if (realpathSync(a.input.cwd) !== cwd)
            throw Error("定时任务试图超出本条消息的工作目录");
          const schedule = this.schedules.create(a.input);
          reply(
            `已创建定时任务「${schedule.name}」。下次执行：${schedule.nextRunAt}。后台需保持运行，错过时间不补跑。`,
          );
        } else if (a.type === "schedule_control") {
          this.schedules.control(
            a.scheduleId,
            a.operation,
            a.expectedUpdatedAt,
          );
          reply(
            a.operation === "delete"
              ? "已删除定时计划，已触发的任务继续保留。"
              : a.operation === "pause"
                ? "已暂停后续触发，已有执行不受影响。"
                : "已恢复后续定时触发。",
          );
        } else if (a.type === "schedule_status") {
          for (const id of a.scheduleIds) this.schedules.get(id);
          const schedules = this.schedules
            .list()
            .filter(
              (schedule) =>
                !a.scheduleIds.length || a.scheduleIds.includes(schedule.id),
            );
          reply(
            schedules.length
              ? schedules
                  .map(
                    (schedule) =>
                      `${schedule.name}（${schedule.id}）：${{ active: "已启用", paused: "已暂停", finished: "已结束" }[schedule.status]}，下次执行 ${schedule.nextRunAt || "无"}`,
                  )
                  .join("\n")
              : "当前没有定时任务。",
          );
        } else if (a.type === "supplement") {
          const t = this.task(a.taskId);
          if (t.revision !== a.expectedRevision)
            throw Error("任务已被更新，请依据最新进展重新确认");
          if (t.status === "unknown")
            throw Error("执行状态待确认，不能直接重跑或追加");
          if (t.status === "stopping") throw Error("正在停止，暂不能追加");
          const hadPending = this.snapshot().questions.some(
            (q) => q.taskId === t.id && !q.resolved,
          );
          t.revision++;
          for (const q of this.snapshot().questions.filter(
            (q) => q.taskId === t.id && !q.resolved,
          ))
            this.store.put("questions", q.id, { ...q, resolved: true });
          t.goal += "\n补充：" + a.text;
          this.save(t);
          const handle = this.handles.get(t.id),
            agent = this.snapshot().agents.find((x) => x.id === t.agentId);
          if (hadPending) {
            t.status = "stopping";
            t.progress = "新要求已保存，正在停止旧轮次以取消过期授权。";
            this.save(t);
            if (handle)
              try {
                await handle.stop();
              } catch {
                if (!this.closed) {
                  const latest = this.task(t.id);
                  if (
                    latest.status === "stopping" &&
                    latest.revision === t.revision
                  ) {
                    latest.status = "unknown";
                    latest.progress = "旧轮次停止结果待确认。";
                    this.save(latest);
                  }
                }
              }
            if (!this.closed)
              reply("待旧轮次停止确认后，可按新要求继续。", "assistant", [
                t.id,
              ]);
          } else if (!handle && this.reserved.has(t.id)) {
            const updates = this.deferredUpdates.get(t.id) || [];
            updates.push(a.text);
            this.deferredUpdates.set(t.id, updates);
            reply("补充已保存，连接建立后再确认送达。", "assistant", [t.id]);
          } else if (handle && agent?.capabilities.steer) {
            try {
              await handle.steer(a.text);
              if (this.closed) return;
              reply("补充已送达执行端；采用结果以执行反馈为准。", "assistant", [
                t.id,
              ]);
            } catch {
              if (this.closed) return;
              reply("补充已保存，未确认送达，请核对执行进展。", "assistant", [
                t.id,
              ]);
            }
          } else if (handle) {
            reply(
              "补充已保存。此执行端不支持中途追加；停止当前轮次后可继续。",
              "assistant",
              [t.id],
            );
          } else {
            t.status = "queued";
            t.result = undefined;
            t.progress = "正在按更新后的要求继续。";
            this.save(t);
            void this.start(t);
          }
        } else if (a.type === "stop") {
          const t = this.task(a.taskId);
          if (t.revision !== a.expectedRevision)
            throw Error("任务要求已更新，停止指令未应用");
          await this.stop(t.id);
        } else if (a.type === "status") {
          const snapshot = this.snapshot();
          const native =
            snapshot.observations?.flatMap((item) => item.sessions) || [];
          const requested = new Set(a.taskIds);
          if (
            a.taskIds.some(
              (id) =>
                !snapshot.tasks.some((task) => task.id === id) &&
                !native.some((session) => session.id === id),
            )
          )
            throw Error("查询目标不存在或已离开当前观测范围");
          const tasks = snapshot.tasks.filter(
            (task) => !requested.size || requested.has(task.id),
          );
          const sessions = native.filter(
            (session) => !requested.size || requested.has(session.id),
          );
          const sections: string[] = [];
          if (tasks.length)
            sections.push(
              "ACD 发起的任务：\n" +
                tasks
                  .map((task) => task.title + "：" + task.progress)
                  .join("\n"),
            );
          if (!tasks.length && !sessions.length)
            sections.push("ACD 当前暂无任务。");
          if (sessions.length)
            sections.push(
              "原生会话（只读）：\n" +
                sessions
                  .map((session) => session.title + "：" + session.progress)
                  .join("\n"),
            );
          for (const observation of snapshot.observations || []) {
            const name =
              snapshot.agents.find((agent) => agent.id === observation.agentId)
                ?.name || "Agent";
            if (observation.state !== "connected")
              sections.push(name + "：" + observation.message);
            else if (!observation.sessions.length)
              sections.push(
                name +
                  "：" +
                  (observation.source === "run-events"
                    ? observation.message
                    : "当前连接的原生实例没有已加载会话；不代表其他实例没有任务。"),
              );
          }
          if (!snapshot.observations?.length)
            sections.push("原生 Agent 的其他会话尚未接入观测。");
          reply(sections.join("\n\n"));
        } else {
          const q: Question = {
            id: randomUUID(),
            kind: "clarification",
            text: a.text,
            choices: a.taskIds,
            resolved: false,
          };
          this.store.put("questions", q.id, {
            ...q,
            sourceMessageId: m.id,
            cwd,
            allocation: normalizeAllocation(m.request),
          });
          this.publish();
        }
      } catch (e) {
        actionFailed = true;
        reply(
          e instanceof Error ? e.message : "操作无法执行",
          "assistant",
          [],
          true,
        );
      }
    }
    if (
      !this.closed &&
      !actionFailed &&
      !decision.actions.length &&
      decision.reply
    )
      reply(decision.reply);
  }
  reportScheduleFailure(name: string, detail: string) {
    this.say(
      `定时任务「${name}」未启动：${detail}`,
      "system",
      [],
      undefined,
      true,
    );
  }
  prepareTask(
    input: Pick<Task, "title" | "goal" | "agentId" | "cwd"> &
      Pick<Task, "allocation">,
    sourceMessageId?: string,
  ): Task {
    if (this.closed) throw Error("服务正在退出");
    if (!isAbsolute(input.cwd)) throw Error("工作目录必须为绝对路径");
    const cwd = realpathSync(input.cwd);
    if (!statSync(cwd).isDirectory()) throw Error("工作目录不存在");
    const agent = this.store
      .list<AgentConnection>("agents")
      .find(
        (agent) =>
          agent.id === input.agentId &&
          agent.selected &&
          agent.available &&
          agent.supported !== false,
      );
    if (!agent) throw Error("执行 Agent 未接入");
    const now = new Date().toISOString();
    return {
      ...input,
      cwd,
      id: randomUUID(),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      status: "queued",
      revision: 1,
      progress: "消息已接收，正在分配执行。",
      createdAt: now,
      updatedAt: now,
    };
  }
  dispatchPreparedTask(task: Task, announcement?: string) {
    if (this.closed) return;
    this.save(task);
    if (announcement) this.say(announcement, "system", [task.id]);
    void this.start(task);
  }
  private task(id: string) {
    const t = this.store.get<Task>("tasks", id);
    if (!t) throw Error("任务不存在");
    return t;
  }
  private async start(input: Task) {
    const t = this.task(input.id);
    if (this.closed || t.status !== "queued" || this.reserved.has(t.id)) return;
    try {
      if (realpathSync(t.cwd) !== t.cwd || !statSync(t.cwd).isDirectory())
        throw Error("工作目录已改变");
    } catch {
      t.status = "blocked";
      t.progress =
        "工作目录已不可访问或真实位置已改变，尚未提交执行；请核对原目录后继续。";
      this.save(t);
      return;
    }
    const conflict =
      this.store
        .list<Task>("tasks")
        .find(
          (x) =>
            x.id !== t.id && this.reserved.has(x.id) && overlaps(x.cwd, t.cwd),
        ) ??
      [...this.nativeDirectories.values()].find((held) =>
        overlaps(held.cwd, t.cwd),
      )?.session;
    if (conflict) {
      const progress =
        "等待「" + conflict.title + "」释放工作目录，消息已接收。";
      if (t.progress !== progress) {
        t.progress = progress;
        this.save(t);
      }
      return;
    }
    const agent = this.snapshot().agents.find((a) => a.id === t.agentId);
    if (
      !agent ||
      exclusionReason(agent, t.allocation?.requiredCapabilities || [])
    ) {
      t.status = "blocked";
      t.progress =
        "原分配 Agent 当前不可用或不满足任务能力要求，尚未提交执行；未自动改派。";
      this.save(t);
      return;
    }
    this.reserved.add(t.id);
    t.status = "running";
    t.progress = "正在连接执行 Agent。";
    this.save(t);
    try {
      const handle = await this.deps
        .adapter(agent.kind)
        .start({ task: t, agent, onEvent: (e) => this.event(t.id, e) });
      if (this.closed || !this.reserved.has(t.id)) {
        handle.dispose();
        return;
      }
      this.handles.set(t.id, handle);
      if (this.task(t.id).status === "stopping") await handle.stop();
      else {
        const updates = this.deferredUpdates.get(t.id) || [];
        this.deferredUpdates.delete(t.id);
        if (updates.length) {
          if (agent.capabilities.steer) {
            await handle.steer(updates.join("\n"));
            if (!this.closed)
              this.say(
                "连接建立，补充已送达；采用情况以执行反馈为准。",
                "assistant",
                [t.id],
              );
          } else if (!this.closed)
            this.say("补充已保存，当前执行端不支持中途追加。", "assistant", [
              t.id,
            ]);
        }
      }
    } catch {
      this.event(t.id, {
        type: "failed",
        text: "执行端未能启动或连接中断，请检查安装和登录状态。",
      });
    }
  }
  private event(id: string, e: AdapterEvent) {
    if (this.closed) return;
    const t = this.task(id);
    if (!this.reserved.has(id)) return;
    if (e.sessionId) t.sessionId = e.sessionId;
    if (e.turnId) t.turnId = e.turnId;
    if (e.type === "session") this.save(t);
    else if (e.type === "progress" || e.type === "output") {
      if (t.status !== "stopping")
        t.progress = (e.text || "正在执行").slice(-2000);
      if (e.type === "output")
        t.result = ((t.result || "") + (e.text || "")).slice(-200000);
      this.save(t);
    } else if (e.type === "question_resolved") {
      for (const q of this.snapshot().questions.filter(
        (q) =>
          q.taskId === id && !q.resolved && q.nativeRequestId === e.requestId,
      ))
        this.store.put("questions", q.id, { ...q, resolved: true });
      if (
        t.status === "waiting_input" &&
        !this.snapshot().questions.some(
          (q) => q.taskId === id && !q.resolved && q.revision === t.revision,
        )
      ) {
        t.status = "running";
        t.progress = e.text || "问题已结束，等待执行端反馈。";
      }
      this.save(t);
    } else if (e.type === "question") {
      if (t.status === "stopping") return;
      const q: Question = {
        id: randomUUID(),
        taskId: id,
        revision: t.revision,
        kind: e.input ? "input" : "approval",
        choiceLabels: e.choiceLabels,
        text: e.text || "执行端请求授权",
        choices: e.choices || ["decline"],
        resolved: false,
        nativeRequestId: e.requestId,
      };
      this.store.put("questions", q.id, q);
      t.status = "waiting_input";
      t.progress = q.text;
      this.save(t);
    } else {
      const previous = t.status;
      t.status =
        e.type === "completed"
          ? "review"
          : e.type === "cancelled"
            ? "cancelled"
            : e.taskNotSubmitted
              ? "failed"
              : "unknown";
      t.progress =
        e.type === "completed"
          ? "本轮执行结束，等待检查结果。"
          : e.type === "cancelled"
            ? "执行已停止，已有修改保留。"
            : e.taskNotSubmitted
              ? e.text || "任务尚未提交，请检查执行端配置。"
              : "执行结果待确认，不自动重试。";
      if (e.text) t.result = (t.result || "") + "\n" + e.text;
      for (const q of this.snapshot().questions.filter(
        (q) => q.taskId === id && !q.resolved,
      ))
        this.store.put("questions", q.id, { ...q, resolved: true });
      if (e.type === "completed")
        queueCompletion(this.store, {
          executionKey: `task:${t.id}:${t.revision}:${t.turnId || ""}`,
          taskId: t.id,
          taskRevision: t.revision,
          userRequest: t.sourceMessageId
            ? this.store.getMessage(t.sourceMessageId)?.text
            : undefined,
          cwd: t.cwd,
          title: t.title,
          requirements: [t.goal],
          result: t.result || "",
          progress: t.progress,
        });
      this.save(t);
      if (t.status !== "unknown") {
        this.deferredUpdates.delete(id);
        this.reserved.delete(id);
        this.handles.get(id)?.dispose();
        this.handles.delete(id);
        this.drain();
      }
      if (previous !== t.status && e.type !== "completed")
        this.say(t.progress, "assistant", [id]);
    }
  }
  private drain() {
    for (const t of this.store.list<Task>("tasks"))
      if (t.status === "queued") void this.start(t);
  }
  async stop(id: string) {
    const t = this.task(id);
    if (ended(t) || t.status === "stopping") return;
    if (["queued", "blocked"].includes(t.status) && !this.reserved.has(t.id)) {
      t.status = "cancelled";
      t.revision++;
      t.progress = "已取消等待。";
      this.save(t);
      return;
    }
    const h = this.handles.get(id);
    if (!h) {
      if (
        this.reserved.has(id) &&
        ["running", "waiting_input"].includes(t.status)
      ) {
        t.revision++;
        t.status = "stopping";
        t.progress = "正在连接执行端，连接建立后立即请求停止。";
        this.save(t);
        return;
      }
      t.status = "unknown";
      t.progress = "未持有原执行连接，停止结果待确认。";
      this.save(t);
      return;
    }
    t.revision++;
    t.status = "stopping";
    t.progress = "停止请求已发送，等待确认。";
    this.save(t);
    try {
      await h.stop();
    } catch {
      if (this.closed) return;
      const latest = this.task(id);
      if (latest.status !== "stopping" || latest.revision !== t.revision)
        return;
      latest.status = "unknown";
      latest.progress = "停止结果待确认。";
      this.save(latest);
    }
  }
  async answer(id: string, choice: string) {
    const q = this.store.get<
      Question & {
        sourceMessageId?: string;
        cwd?: string;
        allocation?: AllocationRequest;
      }
    >("questions", id);
    if (
      !q ||
      q.resolved ||
      this.answering.has(id) ||
      !choice.trim() ||
      (q.kind === "approval" && !q.choices.includes(choice))
    )
      throw Error("问题已失效或选项无效");
    if (!q.taskId) {
      const original = q.sourceMessageId
        ? this.store.getMessage(q.sourceMessageId)
        : undefined;
      this.receive(
        "针对此前消息「" +
          (original?.text || q.text) +
          "」，我的回答是：" +
          choice,
        q.cwd!,
        this.snapshot().tasks.some((t) => t.id === choice) ? choice : undefined,
        undefined,
        original?.id,
        q.allocation || normalizeAllocation(original?.request),
      );
      q.resolved = true;
      this.store.put("questions", id, q);
      this.publish();
      return;
    }
    const t = this.task(q.taskId),
      h = this.handles.get(t.id);
    if (t.revision !== q.revision || !h || q.nativeRequestId === undefined)
      throw Error("要求已更新，此授权已失效");
    this.answering.add(id);
    try {
      await h.answer(q.nativeRequestId, choice);
      if (this.closed) return;
      q.resolved = true;
      this.store.put("questions", id, q);
      const latest = this.task(t.id);
      if (
        latest.revision === q.revision &&
        latest.status === "waiting_input" &&
        !this.snapshot().questions.some(
          (other) =>
            other.taskId === t.id &&
            !other.resolved &&
            other.revision === latest.revision,
        )
      ) {
        latest.status = "running";
        latest.progress =
          q.kind === "input"
            ? "回复已提交，等待执行端反馈。"
            : "授权选择已提交，等待执行端反馈。";
        this.save(latest);
      }
    } catch {
      if (this.closed) return;
      q.resolved = true;
      this.store.put("questions", id, q);
      const latest = this.task(t.id);
      if (latest.revision !== q.revision || latest.status !== "waiting_input")
        return;
      latest.status = "unknown";
      latest.progress =
        q.kind === "input"
          ? "回复的送达结果待确认，不自动重试。"
          : "授权选择的送达结果待确认，不自动重试。";
      this.save(latest);
      throw Error("授权送达结果待确认，请核对执行端");
    } finally {
      this.answering.delete(id);
      if (!this.closed) this.publish();
    }
  }

  reconcile(id: string) {
    const t = this.task(id);
    if (t.status !== "unknown") throw Error("仅状态待确认任务可人工解除");
    this.handles.get(id)?.dispose();
    this.handles.delete(id);
    this.reserved.delete(id);
    this.deferredUpdates.delete(id);
    for (const q of this.snapshot().questions.filter(
      (q) => q.taskId === id && !q.resolved,
    ))
      this.store.put("questions", q.id, { ...q, resolved: true });
    t.revision++;
    t.status = "cancelled";
    t.progress = "用户已确认原执行停止，已解除目录占用；已有修改尚未验收。";
    this.save(t);
    this.say(t.progress, "system", [id]);
    this.drain();
  }
  accept(id: string) {
    const t = this.task(id);
    if (t.status !== "review") throw Error("当前任务没有待检查的结果");
    t.status = "completed";
    t.progress = "用户已确认完成。";
    this.save(t);
  }
  shutdown() {
    this.closed = true;
    this.schedules.close();
    for (const c of this.routing.values()) c.abort();
    this.routing.clear();
    for (const id of this.reserved) {
      const t = this.task(id);
      t.status = "unknown";
      t.progress = "本地服务已退出，执行结果需要核对。";
      this.store.put("tasks", id, t);
    }
    for (const h of this.handles.values()) h.dispose();
    this.handles.clear();
    this.reserved.clear();
    this.deferredUpdates.clear();
  }
}
