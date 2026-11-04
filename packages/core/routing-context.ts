import { publicSnippet } from "./native-context.js";
import { workRequest } from "./memory-preferences.js";
import { conversationMessages } from "../contracts/completion.js";
import { rankedSettings } from "./allocation.js";
import type { AllocationRequest, Snapshot, Task } from "../contracts/index.js";

const historyRequest =
  /历史|以前|之前|上次|上回|上周|上月|昨天|过去|旧任务|已(?:经)?(?:完成|结束|取消|失败)|做过|曾经|\b(?:previous|earlier|history|archived|completed|finished|yesterday|last week)\b/i;
const followUp =
  /刚才|上(?:一|个)|那[个项条份]|这[个项条份]|继续|再加|补充|其他要求不变|\b(?:that|previous|continue|resume|it)\b/i;
const greeting =
  /^(?:你好呀?|您好|嗨|早上好|晚上好|hello|hi|hey)[\s!！。.?？]*$/i;
const genericWord =
  /^(?:任务|以前|上次|上周|昨天|之前|历史|进度|那个|完成|查看|一下|继续|哪些|previous|task|status|history|the|that|what)$/i;
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
  const acrossProjects =
    /所有|全部|全局|跨项目|其他项目|在跑|正在|在干[嘛什么]|在做[啥什么]|哪些任务|进度|进展|\b(?:all|across|running|status|progress)\b/i.test(
      query,
    );
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
  const focused =
    Boolean(targetTaskId) ||
    snapshot.tasks.some((t) => refers(t.id, t.title)) ||
    (continuation && recentIds.size > 0);
  const browseHistory =
    historical &&
    !focused &&
    /哪些|多少|几个|几项|都|列表|列出|最近|回顾|历史任务[？?。!！]*$|\b(?:list|which|how many|recent|history)\b/i.test(
      query,
    );
  const specificHistory =
    !focused &&
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
      if (recentIds.has(t.id) && (continuation || (t.cwd === cwd && isOpen(t))))
        return 70;
      if (specificHistory && titleMatch(t.title))
        return t.cwd === cwd ? 62 : 61;
      if (isOpen(t)) return t.cwd === cwd ? 50 : acrossProjects ? 40 : 0;
      return browseHistory && !specificHistory ? (t.cwd === cwd ? 58 : 57) : 0;
    },
    (t) => t.updatedAt,
  );
  const tasks = chosen.map((t) => ({
    id: t.id,
    title: t.title,
    goal: short(t.goal, 480),
    cwd: short(t.cwd, 320),
    agentId: t.agentId,
    status: t.status,
    ...(!isOpen(t) ? { updatedAt: t.updatedAt } : {}),
    revision: t.revision,
    progress: short(t.progress, 200),
  }));
  const visible = new Set(tasks.map((t) => t.id));
  const taskScope = {
    selectedTaskId: targetTaskId || null,
    namedTaskIds: chosen
      .filter(
        (t) =>
          ids.has(t.id.toLowerCase()) ||
          (names(t.title) &&
            !snapshot.tasks.some(
              (other) => other.id !== t.id && other.title === t.title,
            )),
      )
      .map((t) => t.id),
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
  const prefs = rankedSettings(snapshot.allocationSettings);
  const projectOrder = prefs.projectAgentOrders[cwd] || [];
  const priority = [...new Set([...projectOrder, ...prefs.globalAgentOrder])];
  const agents = candidates(selectedAgents, 16, (a) =>
    a.id === allocation?.targetAgentId || refers(a.id, a.name)
      ? priority.length + 2
      : priority.includes(a.id)
        ? priority.length + 1 - priority.indexOf(a.id)
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
  const reportWords = Array.from(segmenter.segment(query))
    .filter(
      (word) =>
        word.isWordLike &&
        word.segment.length >= 2 &&
        !genericWord.test(word.segment),
    )
    .map((word) => word.segment);
  const latestReports = new Map<string, Snapshot["messages"][number]>();
  for (const message of [...recentMessages].reverse()) {
    const report = message.completion;
    if (
      report?.nativeId &&
      report.status === "ready" &&
      !latestReports.has(report.nativeId)
    )
      latestReports.set(report.nativeId, message);
  }
  const recentReports = candidates(
    chatOnly ? [] : [...latestReports.values()],
    2,
    (message) => {
      const report = message.completion!;
      if (targetTaskId && targetTaskId !== report.nativeId) return 0;
      if (refers(report.nativeId!, report.title)) return 4;
      const content = (
        report.title +
        " " +
        (report.summary || "")
      ).toLowerCase();
      if (reportWords.some((word) => content.includes(word))) return 3;
      return message.id === lastLink?.id ? 2 : 0;
    },
    (message) => message.createdAt,
  ).map((message) => ({
    sourceId: message.completion!.nativeId!,
    messageId: message.id,
    title: publicSnippet(message.completion!.title, 160),
    summary: publicSnippet(message.completion!.summary || message.text, 600),
    assessed: message.completion!.assessed === true,
    createdAt: message.createdAt,
  }));

  const observations = candidates(
    chatOnly ? [] : snapshot.observations || [],
    8,
    (o) =>
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
          : s.id === lastLink?.completion?.nativeId &&
              (continuation ||
                recentReports.some((report) => report.sourceId === s.id))
            ? 3
            : s.status === "running" || s.status === "waiting_input"
              ? 2
              : 1,
      (s) => s.observedAt,
    ).map((s) => ({
      id: s.id,
      title: short(s.taskTitle || s.title, 140),
      cwd: short(s.cwd, 320),
      status: s.status,
      progress: short(s.progress, 160),
    })),
  }));

  const questions = candidates(chatOnly ? [] : snapshot.questions, 8, (q) =>
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
    choices: q.choices.slice(0, 6).map((choice) => short(choice, 100)),
  }));
  const conversation = conversationMessages(recentMessages, snapshot)
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
      if (m.completion?.nativeId) return false;
      return !m.request?.cwd || m.request.cwd === cwd;
    })
    .flatMap((m) => {
      const text = workRequest(m);
      return text ? [{ ...m, text }] : [];
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
    recentReports,
    omittedSchedules: plans.length - schedules.length,
    allocation: {
      ...allocation,
      preferences: {
        globalAgentId: prefs.globalAgentId,
        projectAgentIds: projectOrder.length ? { [cwd]: projectOrder[0] } : {},
        globalAgentOrder: prefs.globalAgentOrder,
        projectAgentOrders: projectOrder.length ? { [cwd]: projectOrder } : {},
      },
    },
    input: { text, cwd, targetTaskId },
  };
}
