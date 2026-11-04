import type { AllocationRequest, Snapshot, Task } from "../contracts/index.js";

const historyRequest =
  /历史|以前|之前|上次|上回|上周|上月|昨天|过去|旧任务|已(?:经)?(?:完成|结束|取消|失败)|做过|曾经|\b(?:previous|earlier|history|archived|completed|finished|yesterday|last week)\b/i;
const followUp =
  /刚才|上(?:一|个)|那[个项条份]|这[个项条份]|继续|再加|补充|其他要求不变|\b(?:that|previous|continue|resume|it)\b/i;
const greeting =
  /^(?:你好呀?|您好|嗨|早上好|晚上好|hello|hi|hey)[\s!！。.?？]*$/i;
const genericWord =
  /^(?:任务|以前|上次|上周|昨天|之前|历史|进度|以前|那个|完成|查看|一下|继续|哪些|之前|previous|task|status|history|the|that|what)$/i;
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

function short(text: string, limit: number) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  return text.slice(0, head) + "…" + text.slice(-(limit - head - 1));
}
const isOpen = (t: Task) =>
  !["completed", "cancelled", "failed"].includes(t.status);

// Preserve the original order for equal scores/timestamps. Never sort a shared snapshot.
function candidates<T>(
  items: readonly T[],
  limit: number,
  score: (item: T) => number,
  time: (item: T) => string = () => "",
) {
  return items
    .map((item) => ({ item, rank: score(item) }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || time(b.item).localeCompare(time(a.item)))
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function routingContext(
  snapshot: Snapshot,
  text: string,
  cwd: string,
  targetTaskId?: string,
  allocation?: AllocationRequest,
) {
  const query = text.normalize("NFKC").toLowerCase();
  const names = (label: string) =>
    Boolean(label.trim()) &&
    query.includes(label.normalize("NFKC").toLowerCase());
  // IDs embedded in longer words (e.g. task-1 vs task-10) are not explicit references.
  const ids = new Set(query.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) || []);
  const refers = (id: string, label: string) =>
    ids.has(id.toLowerCase()) || names(label);
  const historical = historyRequest.test(query);
  const continuation = followUp.test(query);
  const words =
    historical || continuation
      ? Array.from(segmenter.segment(query))
          .filter(
            (s) =>
              s.isWordLike &&
              s.segment.length >= 2 &&
              !genericWord.test(s.segment),
          )
          .map((s) => s.segment)
      : [];
  const recentMessages = snapshot.messages.slice(-24);
  const lastLink = recentMessages.findLast(
    (m) => m.taskIds.length || m.completion?.nativeId,
  );
  const recentIds = new Set(lastLink?.taskIds || []);
  const titleMatch = (title: string) =>
    words.some((w) => title.toLowerCase().includes(w));
  const specificHistory =
    words.length > 0 &&
    snapshot.tasks.some((t) => !isOpen(t) && titleMatch(t.title));
  const chatOnly = !targetTaskId && greeting.test(query.trim());
  const chosen = candidates(
    chatOnly ? [] : snapshot.tasks,
    12,
    (t) => {
      if (t.id === targetTaskId) return 100;
      if (ids.has(t.id.toLowerCase())) return 90;
      if (names(t.title)) return 80;
      if (recentIds.has(t.id) && (continuation || isOpen(t))) return 70;
      if (specificHistory && titleMatch(t.title))
        return t.cwd === cwd ? 62 : 61;
      if (isOpen(t)) return t.cwd === cwd ? 50 : 40;
      return historical && !specificHistory ? (t.cwd === cwd ? 20 : 10) : 0;
    },
    (t) => t.updatedAt,
  );
  const tasks = chosen.map((t) => ({
    id: t.id,
    title: t.title,
    goal: short(t.goal, 480),
    cwd: t.cwd === cwd ? cwd : short(t.cwd, 320),
    agentId: t.agentId,
    status: t.status,
    revision: t.revision,
    progress: short(t.progress, 200),
  }));
  const visible = new Set(tasks.map((t) => t.id));
  const taskScope = {
    selectedTaskId: targetTaskId || null,
    recentTaskIds: [...recentIds].filter((id) => visible.has(id)),
    sameDirectoryTaskIds: chosen.filter((t) => t.cwd === cwd).map((t) => t.id),
    otherDirectoryTaskIds: chosen.filter((t) => t.cwd !== cwd).map((t) => t.id),
    omittedOpenTasks: snapshot.tasks.filter(
      (t) => isOpen(t) && !visible.has(t.id),
    ).length,
    historyAvailable: snapshot.tasks.some(
      (t) => !isOpen(t) && !visible.has(t.id),
    ),
  };

  const selectedAgents = snapshot.agents.filter(
    (a) => a.selected && a.available && a.supported !== false,
  );
  const prefs = snapshot.allocationSettings;
  const projectDefault = prefs?.projectAgentIds[cwd];
  const agents = candidates(selectedAgents, 16, (a) =>
    a.id === allocation?.targetAgentId || refers(a.id, a.name)
      ? 3
      : [projectDefault, prefs?.globalAgentId].includes(a.id)
        ? 2
        : 1,
  ).map(({ id, name, kind, capabilities }) => ({
    id,
    name,
    kind,
    capabilities,
  }));
  const plans = snapshot.schedules || [];
  const schedules = candidates(
    chatOnly ? [] : plans,
    8,
    (s) =>
      refers(s.id, s.name)
        ? 3
        : s.status !== "finished"
          ? s.cwd === cwd
            ? 2
            : 1
          : 0,
    (s) => s.updatedAt,
  ).map(({ id, name, agentId, cwd, rule, status, nextRunAt, updatedAt }) => ({
    id,
    name,
    agentId,
    cwd,
    rule,
    status,
    nextRunAt,
    updatedAt,
  }));
  const observations = candidates(snapshot.observations || [], 8, (o) =>
    o.sessions.some((s) => refers(s.id, s.taskTitle || s.title)) ? 2 : 1,
  ).map((o) => ({
    agentId: o.agentId,
    state: o.state,
    source: o.source,
    message: short(o.message, 180),
    sessions: candidates(
      o.sessions,
      6,
      (s) =>
        refers(s.id, s.taskTitle || s.title)
          ? 4
          : s.id === lastLink?.completion?.nativeId && continuation
            ? 3
            : s.status === "running" || s.status === "waiting_input"
              ? 2
              : 1,
      (s) => s.observedAt,
    ).map((s) => ({
      id: s.id,
      title: short(s.taskTitle || s.title, 140),
      cwd: s.cwd,
      status: s.status,
      progress: short(s.progress, 160),
    })),
  }));
  const nativeIds = new Set(
    observations.flatMap((o) => o.sessions.map((s) => s.id)),
  );
  const questions = candidates(snapshot.questions, 8, (q) =>
    q.resolved || (q.taskId && !visible.has(q.taskId))
      ? 0
      : q.taskId === targetTaskId && targetTaskId
        ? 2
        : 1,
  ).map((q) => ({
    id: q.id,
    taskId: q.taskId,
    kind: q.kind,
    text: short(q.text, 300),
  }));
  const conversation = recentMessages
    .filter((m) => {
      if (chatOnly || m.routing?.status === "pending") return false;
      const source =
        m.replyTo && recentMessages.find((entry) => entry.id === m.replyTo);
      if (
        source &&
        source.request?.cwd &&
        source.request.cwd !== cwd &&
        !m.taskIds.some((id) => visible.has(id))
      )
        return false;
      if (
        !m.taskIds.length &&
        source &&
        source.routing?.actions.some(
          (action) => action === "status" || action === "schedule_status",
        )
      )
        return false;
      if (m.taskIds.length) return m.taskIds.some((id) => visible.has(id));
      if (m.completion?.nativeId)
        return continuation && nativeIds.has(m.completion.nativeId);
      return !m.request?.cwd || m.request.cwd === cwd;
    })
    .slice(-8)
    .map((m) => ({
      role: m.role,
      text: short(m.text, 480),
      taskIds: m.taskIds.filter((id) => visible.has(id)),
    }));

  return {
    tasks,
    taskScope,
    agents,
    schedules,
    observations,
    questions,
    conversation,
    omittedSchedules: plans.length - schedules.length,
    allocation: {
      ...allocation,
      preferences: {
        globalAgentId: prefs?.globalAgentId || null,
        projectAgentIds: projectDefault ? { [cwd]: projectDefault } : {},
      },
    },
    input: { text, cwd, targetTaskId },
  };
}
