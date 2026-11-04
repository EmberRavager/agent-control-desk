import type {
  Action,
  RouteDecision,
  Snapshot,
  Task,
  AgentCapability,
} from "../packages/contracts/index.js";

export interface RoutingCase {
  name: string;
  text: string;
  allowed: Action["type"][];
  targetTaskId?: string;
  expectedTaskIds?: string[];
  actionCount?: number;
  empty?: boolean;
  recent?: boolean;
  otherDirectory?: boolean;
  multiAgent?: boolean;
  reverseAgents?: boolean;
  requestedAgentId?: string;
  requiredCapabilities?: AgentCapability[];
}
export const routingCases: RoutingCase[] = [
  {
    name: "多候选明确指定 Claude",
    text: "另建独立任务，交给 Claude Code，只读检查 LICENSE 并汇报。",
    allowed: ["create"],
    empty: true,
    multiAgent: true,
    requestedAgentId: "eval-claude",
    actionCount: 1,
  },
  {
    name: "候选反序仍提取明确指定",
    text: "另建独立任务，交给 Claude Code，只读检查 LICENSE 并汇报。",
    allowed: ["create"],
    empty: true,
    multiAgent: true,
    reverseAgents: true,
    requestedAgentId: "eval-claude",
    actionCount: 1,
  },
  {
    name: "明确执行中追加能力",
    text: "另建独立任务检查项目启动方式，必须支持执行过程中追加要求。",
    allowed: ["create"],
    empty: true,
    multiAgent: true,
    requiredCapabilities: ["steer"],
    actionCount: 1,
  },
  {
    name: "普通任务不虚构交互能力",
    text: "另建独立任务只读检查 LICENSE 并汇报。",
    allowed: ["create"],
    empty: true,
    multiAgent: true,
    requiredCapabilities: [],
    actionCount: 1,
  },

  {
    name: "明确同名独立任务",
    text: "另外新建一个独立任务，也只读检查 README 的启动方式，不要修改文件。",
    allowed: ["create"],
    actionCount: 1,
  },
  { name: "问候不建任务", text: "你好", allowed: [] },
  {
    name: "讨论不触发执行",
    text: "先别动文件，我们先讨论一下你会怎么分析项目结构。",
    allowed: [],
  },
  {
    name: "空任务也查真实状态",
    text: "我的 agent 正在干什么？",
    allowed: ["status"],
    empty: true,
  },
  {
    name: "重复目标复用匹配任务",
    text: "请只读检查这个目录的 README.md，告诉我项目如何启动，不要修改文件。",
    allowed: ["supplement", "status", "clarify"],
    expectedTaskIds: ["task-a"],
  },
  {
    name: "独立任务新建",
    text: "另外新建一个独立任务：检查 LICENSE 的许可证类型，不要修改文件。",
    allowed: ["create"],
    actionCount: 1,
  },
  {
    name: "指定名称只停一项",
    text: "停止检查项目启动说明的任务，其他任务继续。",
    allowed: ["stop"],
    expectedTaskIds: ["task-a"],
    actionCount: 1,
  },
  {
    name: "选中任务更正",
    text: "不是检查启动方式了，改为只找出文档中的错别字，不要修改文件。",
    allowed: ["supplement"],
    targetTaskId: "task-a",
    expectedTaskIds: ["task-a"],
    actionCount: 1,
  },
  {
    name: "指代不明先澄清",
    text: "那个先停一下",
    allowed: ["clarify"],
    actionCount: 1,
  },
  {
    name: "最近关联任务的补充",
    text: "再加上边界情况，其他要求不变。",
    allowed: ["supplement", "clarify"],
    expectedTaskIds: ["task-b"],
    recent: true,
  },
  {
    name: "不同目录相似目标另建",
    text: "请检查这个项目 README 的启动方式并汇报，不修改文件。",
    allowed: ["create"],
    otherDirectory: true,
    actionCount: 1,
  },
  {
    name: "新增约束不得降级查询",
    text: "启动说明只给 Mac 命令，忽略 Docker，其他要求不变。",
    allowed: ["supplement"],
    expectedTaskIds: ["task-a"],
    actionCount: 1,
  },
  {
    name: "否定全部停止",
    text: "不要都停，只停止检查项目启动说明这个任务。",
    allowed: ["stop"],
    expectedTaskIds: ["task-a"],
    actionCount: 1,
  },
  {
    name: "明确全部停止",
    text: "停止所有正在运行的任务。",
    allowed: ["stop"],
    expectedTaskIds: ["task-a", "task-b"],
    actionCount: 2,
  },
];
export function routingFixture(item: RoutingCase): {
  snapshot: Snapshot;
  cwd: string;
} {
  const cwd = "/fixture/project",
    time = "2026-11-03T08:00:00.000Z";
  const task = (id: string, title: string, goal: string): Task => ({
    id,
    title,
    goal,
    cwd,
    agentId: "eval-agent",
    status: "running",
    revision: 2,
    progress: "正在执行",
    createdAt: time,
    updatedAt: time,
  });
  const candidates: Snapshot["agents"] = [
    {
      id: "eval-agent",
      name: "Codex",
      kind: "codex",
      selected: true,
      available: true,
      supported: true,
      executable: "/never-executed",
      capabilities: { steer: true, resume: true, approval: true, input: true },
    },
    {
      id: "eval-claude",
      name: "Claude Code",
      kind: "claude",
      selected: true,
      available: true,
      supported: true,
      executable: "/never-executed",
      capabilities: {
        steer: false,
        resume: true,
        approval: false,
        input: false,
      },
    },
    {
      id: "eval-pi",
      name: "Pi",
      kind: "pi",
      selected: true,
      available: true,
      supported: true,
      executable: "/never-executed",
      capabilities: { steer: true, resume: true, approval: true, input: true },
    },
  ];
  return {
    cwd: item.otherDirectory ? "/fixture/other-project" : cwd,
    snapshot: {
      agents: item.multiAgent
        ? item.reverseAgents
          ? candidates.toReversed()
          : candidates
        : candidates.slice(0, 1),
      tasks: item.empty
        ? []
        : [
            task(
              "task-a",
              "检查项目启动说明",
              "只读检查 README 中的启动方式与依赖，汇报如何启动；不要修改文件。",
            ),
            task("task-b", "检查测试覆盖", "只读检查测试覆盖情况，汇报风险。"),
          ],
      messages: item.recent
        ? [
            {
              id: "related-message",
              role: "assistant",
              text: "已开始检查测试覆盖。",
              taskIds: ["task-b"],
              createdAt: time,
            },
          ]
        : [],
      questions: [],
      model: null,
    },
  };
}
export function checkRoutingCase(
  item: RoutingCase,
  decision: RouteDecision,
  cwd: string,
): string[] {
  const errors: string[] = [];
  if (
    !item.allowed.length
      ? decision.actions.length !== 0
      : !decision.actions.length ||
        decision.actions.some((action) => !item.allowed.includes(action.type))
  )
    errors.push("动作类型不符合要求");
  if (
    item.actionCount !== undefined &&
    decision.actions.length !== item.actionCount
  )
    errors.push("动作数量不符合要求");
  if (decision.actions.length && decision.reply)
    errors.push("执行回复应由运行时生成");
  const selected: string[] = [];
  for (const action of decision.actions) {
    if (
      action.type === "create" &&
      (!(
        item.multiAgent
          ? ["eval-agent", "eval-claude", "eval-pi"]
          : ["eval-agent"]
      ).includes(action.agentId) ||
        action.cwd !== cwd)
    )
      errors.push("新任务执行者或目录错误");
    if (action.type === "create") {
      if (
        item.requestedAgentId &&
        action.requestedAgentId !== item.requestedAgentId
      )
        errors.push("未正确提取用户明确指定的执行者");
      if (
        item.requiredCapabilities &&
        JSON.stringify([...(action.requiredCapabilities || [])].sort()) !==
          JSON.stringify([...item.requiredCapabilities].sort())
      )
        errors.push("必要协议能力与用户明确要求不一致");
    }
    if (action.type === "supplement" || action.type === "stop") {
      selected.push(action.taskId);
      if (action.expectedRevision !== 2) errors.push("任务版本错误");
    } else if (action.type === "status" || action.type === "clarify")
      selected.push(...action.taskIds);
  }
  if (
    item.expectedTaskIds &&
    selected.some((id) => !item.expectedTaskIds!.includes(id))
  )
    errors.push("包含无关目标");
  if (
    item.expectedTaskIds &&
    decision.actions.some((action) => action.type !== "clarify") &&
    (new Set(selected).size !== item.expectedTaskIds.length ||
      item.expectedTaskIds.some((id) => !selected.includes(id)))
  )
    errors.push("目标范围不符合要求");
  return [...new Set(errors)];
}
