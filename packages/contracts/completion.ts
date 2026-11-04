import type { Message } from "./index.js";

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
export function conversationMessages(messages: Message[]): Message[] {
  const latest = new Set(
    latestNativeReports(messages).map((message) => message.id),
  );
  return messages.filter(
    (message) =>
      message.completion?.status !== "withheld" &&
      (!message.completion?.nativeId ||
        message.completion.status === "failed" ||
        latest.has(message.id)),
  );
}
