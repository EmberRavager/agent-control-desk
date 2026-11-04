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
): string | undefined {
  if (!agent.selected) return "未接入";
  if (!agent.available) return "当前不可用";
  if (
    agent.supported === false ||
    !["codex", "claude", "opencode", "pi"].includes(agent.kind)
  )
    return "尚未适配";
  const caps = effectiveCapabilities(agent);
  const missing = required.filter((capability) => !caps[capability]);
  return missing.length
    ? "不支持" + missing.map((capability) => labels[capability]).join("、")
    : undefined;
}

export function allocateAgent(input: {
  agents: AgentConnection[];
  cwd: string;
  settings: AllocationSettings;
  request?: AllocationRequest;
  requiredCapabilities?: AgentCapability[];
  suggestedAgentId: string;
}): { agent: AgentConnection; allocation: AllocationDecision } {
  const request = normalizeAllocation(input.request);
  const required = normalizeCapabilities([
    ...(request.requiredCapabilities || []),
    ...(input.requiredCapabilities || []),
  ]);
  const excluded = input.agents.flatMap((agent) => {
    const reason = exclusionReason(agent, required);
    return reason ? [{ agentId: agent.id, reason }] : [];
  });
  const eligible = input.agents.filter(
    (agent) => !exclusionReason(agent, required),
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
        "未找到该执行者";
      if (strict)
        throw Error(
          "指定 Agent 无法承接任务：" + why + "；未改派给其他 Agent。",
        );
      skipped.push(reason + "未采用（" + why + "）");
      return;
    }
    return {
      agent,
      allocation: {
        policyVersion: 1 as const,
        source,
        reason: [...skipped, reason + "，交给 " + agent.name + "。"].join("；"),
        requiredCapabilities: required,
        modelSuggestedAgentId: input.suggestedAgentId,
        excluded,
      },
    };
  };
  const explicit = choose(
    request.targetAgentId,
    "explicit",
    "按本次指定",
    true,
  );
  if (explicit) return explicit;
  const project = choose(
    input.settings.projectAgentIds[input.cwd],
    "project-default",
    "使用项目默认 Agent",
  );
  if (project) return project;
  const global = choose(
    input.settings.globalAgentId,
    "global-default",
    "使用全局默认 Agent",
  );
  if (global) return global;
  if (!eligible.length)
    throw Error("没有满足本次要求的已接入 Agent，任务尚未启动。");
  if (eligible.length === 1)
    return choose(
      eligible[0].id,
      "single-candidate",
      "只有一个符合要求的 Agent",
    )!;
  const suggested = choose(
    input.suggestedAgentId,
    "model",
    "采用总控的执行者建议",
  );
  if (suggested) return suggested;
  throw Error(
    "总控未给出符合要求的执行者，请明确选择 Agent 后重试；任务尚未启动。",
  );
}
