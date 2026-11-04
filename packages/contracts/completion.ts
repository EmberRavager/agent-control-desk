import { translate, type Locale } from "../i18n/index.cjs";
import type { Message, Snapshot, Task } from "./index.js";

/** Latest visible report per observed conversation; the durable history is preserved. */
export function latestNativeReports(messages: Message[]): Message[] {
  const latest = new Map<string, Message>();
  for (const message of messages) {
    const nativeId = message.completion?.nativeId;
    if (nativeId && message.completion?.status === "ready")
      latest.set(nativeId, message);
  }
  return [...latest.values()];
}
/** The same public result line is displayed in the supervisor and sent to WeChat. */
export function resultText(
  message: Message,
  task?: Task,
  agentName?: string,
  locale: Locale = "zh-CN",
): string {
  const report = message.completion;
  if (report?.status !== "ready" || !report.assessed || !report.summary)
    return message.text;
  const executor = report.agentName || agentName || task?.agentId || "Agent";
  return translate(
    locale,
    "{executor} 已返回「{title}」的结果，总控判定已交付。\n{summary}",
    { executor, title: task?.title || report.title, summary: report.summary },
  );
}
export function conversationMessages(
  messages: Message[],
  state?: Pick<Snapshot, "agents" | "tasks">,
  locale: Locale = "zh-CN",
): Message[] {
  const delivered = new Set<string>();
  const assessed = new Map<string, Message>();
  for (const message of messages) {
    for (const id of message.taskIds) {
      if (message.taskOutcome)
        delivered.add(id + ":" + message.taskOutcome.revision);
      const report = message.completion;
      if (
        report?.status === "ready" &&
        report.assessed &&
        report.summary &&
        report.taskRevision !== undefined &&
        !report.nativeId
      )
        assessed.set(id + ":" + report.taskRevision, message);
    }
  }
  return messages.flatMap((message) => {
    const report = message.completion;
    if (
      report?.status === "withheld" ||
      (report?.nativeId && report.status !== "ready")
    )
      return [];
    if (
      report &&
      message.taskIds.some((id) =>
        delivered.has(id + ":" + report.taskRevision),
      )
    )
      return [];
    if (message.taskOutcome && state) {
      const task = state.tasks.find((t) => t.id === message.taskIds[0]);
      const result =
        task && assessed.get(task.id + ":" + message.taskOutcome.revision);
      if (task && task.responseKind !== "answer" && result) {
        const executor =
          state.agents.find((agent) => agent.id === task.agentId)?.name ||
          task.agentId;
        return [
          {
            ...message,
            text: resultText(result, task, executor, locale),
          },
        ];
      }
    }
    if (report?.status === "ready") {
      const task = state?.tasks.find((t) => t.id === message.taskIds[0]);
      const agentName = state?.agents.find((a) => a.id === task?.agentId)?.name;
      return [
        { ...message, text: resultText(message, task, agentName, locale) },
      ];
    }
    return [message];
  });
}
