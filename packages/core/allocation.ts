import { translate } from "../i18n/index.cjs";
import type { Locale } from "../contracts/index.js";
import type {
  AgentCapability,
  AgentConnection,
  AllocationDecision,
  AllocationRequest,
  AllocationSettings,
} from "../contracts/index.js";

export const agentCapabilities = [
  "steer",
  "resume",
  "approval",
  "input",
] as const;
const labels: Record<AgentCapability, string> = {
  steer: "执行中追加",
  resume: "会话续接",
  approval: "授权交互",
  input: "文字输入",
};

/** A missing capability remains false unless the installed adapter supplies it. */
export function effectiveCapabilities(agent: AgentConnection) {
  const supported =
    agent.supported !== false &&
    ["codex", "claude", "opencode", "pi"].includes(agent.kind);
  return {
    ...agent.capabilities,
    approval:
      supported &&
      (agent.capabilities.approval ??
        ["codex", "opencode", "pi"].includes(agent.kind)),
    input:
      supported &&
      (agent.capabilities.input ?? ["codex", "pi"].includes(agent.kind)),
  };
}

export function normalizeCapabilities(
  values: readonly AgentCapability[] = [],
): AgentCapability[] {
  if (values.some((value) => !agentCapabilities.includes(value)))
    throw Error("任务要求包含未知的执行能力");
  return [...new Set(values)].sort();
}

export function normalizeAllocation(
  input: AllocationRequest = {},
): AllocationRequest {
  const requiredCapabilities = normalizeCapabilities(
    input.requiredCapabilities,
  );
  if (input.targetAgentId !== undefined && !input.targetAgentId.trim())
    throw Error("指定 Agent 编号不能为空");
  return {
    ...(input.targetAgentId ? { targetAgentId: input.targetAgentId } : {}),
    ...(requiredCapabilities.length ? { requiredCapabilities } : {}),
  };
}

export function exclusionReason(
  agent: AgentConnection,
  required: AgentCapability[],
  locale: Locale = "zh-CN",
): string | undefined {
  const tr = (source: string, values?: Record<string, string | number>) =>
    translate(locale, source, values);
  if (!agent.selected) return tr("未接入");
  if (!agent.available) return tr("当前不可用");
  if (
    agent.supported === false ||
    !["codex", "claude", "opencode", "pi"].includes(agent.kind)
  )
    return tr("尚未适配");
  const caps = effectiveCapabilities(agent);
  const missing = required.filter((capability) => !caps[capability]);
  return missing.length
    ? tr("不支持{capabilities}", {
        capabilities: missing
          .map((capability) => tr(labels[capability]))
          .join(locale === "en" ? ", " : "、"),
      })
    : undefined;
}

export function rankedSettings(
  settings?: AllocationSettings,
): Required<AllocationSettings> {
  const globalAgentOrder =
    settings?.globalAgentOrder ??
    (settings?.globalAgentId ? [settings.globalAgentId] : []);
  const projectAgentOrders =
    settings?.projectAgentOrders ??
    Object.fromEntries(
      Object.entries(settings?.projectAgentIds ?? {}).map(([path, id]) => [
        path,
        [id],
      ]),
    );
  return {
    globalAgentOrder,
    projectAgentOrders,
    globalAgentId: globalAgentOrder[0] ?? null,
    projectAgentIds: Object.fromEntries(
      Object.entries(projectAgentOrders).map(([path, ids]) => [path, ids[0]]),
    ),
  };
}

export function allocateAgent(input: {
  agents: AgentConnection[];
  cwd: string;
  settings: AllocationSettings;
  request?: AllocationRequest;
  requiredCapabilities?: AgentCapability[];
  suggestedAgentId: string;
  locale?: Locale;
}): { agent: AgentConnection; allocation: AllocationDecision } {
  const locale = input.locale || "zh-CN";
  const tr = (source: string, values?: Record<string, string | number>) =>
    translate(locale, source, values);
  const request = normalizeAllocation(input.request);
  const required = normalizeCapabilities([
    ...(request.requiredCapabilities || []),
    ...(input.requiredCapabilities || []),
  ]);
  const excluded = input.agents.flatMap((agent) => {
    const reason = exclusionReason(agent, required, locale);
    return reason ? [{ agentId: agent.id, reason }] : [];
  });
  const eligible = input.agents.filter(
    (agent) => !exclusionReason(agent, required, locale),
  );
  const skipped: string[] = [];
  const choose = (
    id: string | null | undefined,
    source: AllocationDecision["source"],
    reason: string,
    strict = false,
  ) => {
    if (!id) return;
    const agent = eligible.find((candidate) => candidate.id === id);
    if (!agent) {
      const why =
        excluded.find((candidate) => candidate.agentId === id)?.reason ||
        tr("未找到该执行者");
      if (strict)
        throw Error(
          tr("指定 Agent 无法承接任务：{why}；未改派给其他 Agent。", { why }),
        );
      skipped.push(tr("{reason}未采用（{why}）", { reason, why }));
      return;
    }
    return {
      agent,
      allocation: {
        policyVersion: 1 as const,
        source,
        reason: [
          ...skipped,
          tr("{reason}，交给 {name}。", { reason, name: agent.name }),
        ].join(locale === "en" ? "; " : "；"),
        requiredCapabilities: required,
        modelSuggestedAgentId: input.suggestedAgentId,
        excluded,
      },
    };
  };
  const explicit = choose(
    request.targetAgentId,
    "explicit",
    tr("按本次指定"),
    true,
  );
  if (explicit) return explicit;
  const { globalAgentOrder, projectAgentOrders } = rankedSettings(
    input.settings,
  );
  const projectOrder = projectAgentOrders[input.cwd] ?? [];
  for (const [index, id] of projectOrder.entries()) {
    const project = choose(
      id,
      "project-default",
      tr("项目优先级第 {index} 位（{id}）", { index: index + 1, id }),
    );
    if (project) return project;
  }
  for (const [index, id] of globalAgentOrder.entries()) {
    if (projectOrder.includes(id)) continue;
    const global = choose(
      id,
      "global-default",
      tr("全局优先级第 {index} 位（{id}）", { index: index + 1, id }),
    );
    if (global) return global;
  }
  if (!eligible.length)
    throw Error(tr("没有满足本次要求的已接入 Agent，任务尚未启动。"));
  if (eligible.length === 1)
    return choose(
      eligible[0].id,
      "single-candidate",
      tr("只有一个符合要求的 Agent"),
    )!;
  const suggested = choose(
    input.suggestedAgentId,
    "model",
    tr("采用总控的执行者建议"),
  );
  if (suggested) return suggested;
  throw Error(
    tr("总控未给出符合要求的执行者，请明确选择 Agent 后重试；任务尚未启动。"),
  );
}
