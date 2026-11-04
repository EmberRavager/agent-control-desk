import type { Snapshot } from "../contracts/index.js";
import type {
  HistoryEvidence,
  HistoryLookup,
} from "../contracts/investigation.js";
import { workRequest } from "./memory-preferences.js";
import { publicSnippet } from "./native-context.js";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const genericWord =
  /^(?:任务|查看|查询|一下|是否|已经|了吗|现在|刚才|这个|那个|结果|进度|之前|以前|历史|帮我|请问|的|吗|了|work|task|status|please|did|done|is|the|it)$/i;
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
type Fragment = { text: string; at: string; messageId?: string };
type Candidate = {
  evidence: HistoryEvidence;
  fragments: Fragment[];
  at: string;
  index: number;
};

/** Searches the caller's visible snapshot only, keeping source identities intact. */
export function lookupHistory(
  snapshot: Snapshot,
  query: string,
  cwd: string,
  targetId?: string,
): HistoryLookup {
  const boundedQuery = publicSnippet(query, 400);
  const normalizedQuery = normalize(boundedQuery);
  const words = [
    ...new Set(
      Array.from(segmenter.segment(normalizedQuery))
        .filter(
          (part) =>
            part.isWordLike &&
            part.segment.length >= 2 &&
            !genericWord.test(part.segment),
        )
        .map((part) => part.segment),
    ),
  ];
  const mentionedIds = new Set(
    normalizedQuery.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) || [],
  );
  const sources = new Map<string, Candidate>();
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const messages = new Map(
    snapshot.messages.map((message) => [message.id, message]),
  );
  const native = new Map(
    (snapshot.observations || []).flatMap((observation) =>
      observation.sessions.map((session) => [session.id, session] as const),
    ),
  );
  const add = (evidence: HistoryEvidence, fragment: Fragment) => {
    if (targetId && evidence.sourceId !== targetId) return;
    const current = sources.get(evidence.sourceId) || {
      evidence,
      fragments: [],
      at: fragment.at,
      index: sources.size,
    };
    if (fragment.text.trim()) current.fragments.push(fragment);
    if (fragment.at > current.at) current.at = fragment.at;
    sources.set(evidence.sourceId, current);
  };
  for (const task of snapshot.tasks) {
    const evidence: HistoryEvidence = {
      sourceId: task.id,
      kind: "task",
      title: task.title,
      cwd: task.cwd,
      agentId: task.agentId,
      status: task.status,
      messageIds: [],
      excerpts: [],
      truncated: false,
    };
    for (const [label, text] of [
      ["执行结果", task.result],
      ["进度记录", task.progress],
      ["用户目标", task.goal],
    ]) {
      if (text)
        add(evidence, { text: label + "：" + text, at: task.updatedAt });
    }
  }
  for (const message of snapshot.messages) {
    if (message.routing?.status === "pending") continue;
    if (message.completion && message.completion.status !== "ready") continue;
    const text = workRequest(message);
    if (!text.trim()) continue;
    const report = message.completion;
    const parent = message.replyTo ? messages.get(message.replyTo) : undefined;
    const linked = report?.nativeId
      ? [report.nativeId]
      : message.taskIds.length
        ? message.taskIds
        : parent?.taskIds.length
          ? parent.taskIds
          : [message.request?.targetTaskId || message.id];
    for (const sourceId of linked) {
      const task = tasks.get(sourceId);
      const session = native.get(sourceId);
      const evidence: HistoryEvidence = {
        sourceId,
        kind: report?.nativeId ? "native" : task ? "task" : "conversation",
        title:
          task?.title ||
          report?.title ||
          session?.taskTitle ||
          session?.title ||
          "历史对话",
        cwd:
          task?.cwd ||
          session?.cwd ||
          message.request?.cwd ||
          parent?.request?.cwd ||
          "",
        agentId: task?.agentId || session?.agentId,
        status:
          task?.status ||
          session?.status ||
          (report
            ? report.assessed
              ? "reported-delivered"
              : "reported-unconfirmed"
            : undefined),
        messageIds: [],
        excerpts: [],
        truncated: false,
      };
      const label =
        message.role === "user" ? "用户记录" : report ? "交付报告" : "对话记录";
      add(evidence, {
        text: label + "：" + text,
        at: message.createdAt,
        messageId: message.id,
      });
      if (report?.summary && report.summary !== text)
        add(evidence, {
          text: "报告摘要：" + report.summary,
          at: message.createdAt,
          messageId: message.id,
        });
    }
  }
  const scoreText = (text: string) =>
    words.reduce(
      (score, word) => score + Number(normalize(text).includes(word)),
      0,
    );
  const ranked = [...sources.values()].map((candidate) => ({
    candidate,
    explicit: Boolean(
      targetId || mentionedIds.has(normalize(candidate.evidence.sourceId)),
    ),
    relevance:
      scoreText(candidate.evidence.title) * 3 +
      scoreText(
        candidate.fragments.map((fragment) => fragment.text).join("\n"),
      ),
  }));
  const hasMatch = ranked.some((item) => item.explicit || item.relevance > 0);
  const eligible = ranked
    .filter((item) => !hasMatch || item.explicit || item.relevance > 0)
    .sort(
      (a, b) =>
        Number(b.explicit) - Number(a.explicit) ||
        b.relevance - a.relevance ||
        Number(b.candidate.evidence.cwd === cwd) -
          Number(a.candidate.evidence.cwd === cwd) ||
        b.candidate.at.localeCompare(a.candidate.at) ||
        b.candidate.index - a.candidate.index,
    );
  const entries: HistoryEvidence[] = [];
  let hasMore = eligible.length > 5;
  for (const { candidate, explicit, relevance } of eligible.slice(0, 5)) {
    const evidence = {
      ...candidate.evidence,
      match: explicit
        ? ("explicit" as const)
        : relevance > 0
          ? ("content" as const)
          : ("recent" as const),
      title: publicSnippet(candidate.evidence.title, 160),
      cwd: publicSnippet(candidate.evidence.cwd, 320),
      messageIds: [] as string[],
      excerpts: [] as string[],
    };
    const fragments = candidate.fragments
      .map((fragment, index) => ({
        fragment,
        index,
        relevance: scoreText(fragment.text),
      }))
      .sort(
        (a, b) =>
          b.relevance - a.relevance ||
          b.fragment.at.localeCompare(a.fragment.at) ||
          b.index - a.index,
      );
    evidence.truncated = fragments.length > 3;
    if (!hasMatch)
      evidence.excerpts.push(
        "最近保存的来源，未命中查询关键词，尚未确认与本次追问相关。",
      );
    for (const { fragment } of fragments.slice(0, 3)) {
      const redacted = publicSnippet(fragment.text, fragment.text.length);
      const firstMatch =
        words
          .map((word) => normalize(redacted).indexOf(word))
          .filter((index) => index >= 0)
          .sort((a, b) => a - b)[0] ?? 0;
      const start = Math.max(0, firstMatch - 120);
      const excerpt =
        (fragment.at ? "[" + publicSnippet(fragment.at, 40) + "] " : "") +
        redacted.slice(start, start + 1200);
      evidence.truncated ||= start > 0 || start + 1200 < redacted.length;
      if (evidence.excerpts.includes(excerpt)) continue;
      evidence.excerpts.push(excerpt);
      const previousIds = [...evidence.messageIds];
      if (
        fragment.messageId &&
        !evidence.messageIds.includes(fragment.messageId)
      )
        evidence.messageIds.push(fragment.messageId);
      if (
        JSON.stringify({
          query: boundedQuery,
          entries: [...entries, evidence],
          hasMore: true,
        }).length > 7990
      ) {
        evidence.excerpts.pop();
        evidence.messageIds = previousIds;
        evidence.truncated = true;
        hasMore = true;
        break;
      }
    }
    if (
      !evidence.excerpts.length ||
      JSON.stringify({
        query: boundedQuery,
        entries: [...entries, evidence],
        hasMore: true,
      }).length > 7990
    ) {
      hasMore = true;
      break;
    }
    entries.push(evidence);
    if (evidence.truncated) hasMore = true;
  }
  return { query: boundedQuery, entries, hasMore };
}
