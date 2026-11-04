export interface NativeActivityContext {
  request: string;
  finalAnswer?: string;
  requests: string[];
  updates: string[];
  tools: string[];
  truncated: boolean;
}
export const emptyNativeContext = (): NativeActivityContext => ({
  request: "",
  requests: [],
  updates: [],
  tools: [],
  truncated: false,
});
export function publicSnippet(text: string, limit = 1000): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(
      /\b(api[_ -]?key|access[_ -]?key|token|secret|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .trim()
    .slice(0, limit);
}
/** Only public user/assistant messages and tool names; never reasoning or tool arguments. */
export function publicNativeContext(lines: string[]): NativeActivityContext {
  const result = emptyNativeContext();
  const push = (target: string[], text: unknown, limit: number) => {
    if (typeof text !== "string") return;
    const value = publicSnippet(text);
    if (value && target.at(-1) !== value) target.push(value);
    while (target.length > limit) target.shift();
  };
  const addRequest = (text: unknown) => {
    if (typeof text !== "string") return;
    const value = publicSnippet(text);
    if (!result.request && value) result.request = value;
    push(result.requests, value, 3);
  };
  const request = (text: unknown) => {
    if (typeof text === "string")
      text = text
        .replace(
          /<external_browser_tabs>[\s\S]*?<\/external_browser_tabs>/g,
          "",
        )
        .trim();
    if (
      typeof text !== "string" ||
      text.startsWith("# AGENTS.md") ||
      text.startsWith("<environment_context>") ||
      text.startsWith("<external_codex_apps_open_page>")
    )
      return;
    if (text.startsWith("<codex_internal_context")) {
      // Goal wakeups carry the user's objective inside runtime instructions.
      // Only the objective is task input; counters and continuation rules are not.
      if (/^<codex_internal_context\s+source=(["'])goal\1>/.test(text)) {
        const objective = text.match(
          /<objective>\s*([\s\S]*?)\s*<\/objective>/,
        )?.[1];
        if (objective?.trim()) addRequest(objective);
      }
      return;
    }
    if (text.startsWith("<send_user_message_question_reply>")) {
      try {
        const replies: unknown = JSON.parse(
          text
            .replace(/^<send_user_message_question_reply>\s*/, "")
            .replace(/\s*<\/send_user_message_question_reply>$/, ""),
        );
        if (Array.isArray(replies))
          for (const reply of replies)
            if (reply && typeof reply.answer === "string")
              addRequest(
                typeof reply.question === "string"
                  ? `对“${reply.question}”的回答：${reply.answer}`
                  : reply.answer,
              );
      } catch {
        // Malformed transport envelopes are not useful public context.
      }
      return;
    }
    const marker = text.lastIndexOf("## My request:");
    addRequest(marker < 0 ? text : text.slice(marker + 14));
  };
  for (const line of lines) {
    if (Buffer.byteLength(line) > 256 * 1024) {
      result.truncated = true;
      continue;
    }
    let record: { type?: string; payload?: Record<string, unknown> };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload;
    if (!payload) continue;
    if (record.type === "event_msg" && payload.type === "user_message")
      request(payload.message);
    else if (record.type === "event_msg" && payload.type === "agent_message")
      push(result.updates, payload.message, 5);
    else if (record.type === "response_item" && payload.type === "message") {
      const publicPhase =
        payload.phase === "commentary" ||
        payload.phase === "final_answer" ||
        payload.channel === "commentary" ||
        payload.channel === "final";
      if (
        payload.role !== "user" &&
        !(payload.role === "assistant" && publicPhase)
      )
        continue;
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = content
        .filter(
          (item): item is { type: string; text: string } =>
            !!item &&
            typeof item === "object" &&
            ["input_text", "output_text"].includes(item.type) &&
            typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("\n");
      if (payload.role === "user") request(text);
      else {
        push(result.updates, text, 5);
        if (payload.phase === "final_answer" || payload.channel === "final")
          result.finalAnswer = publicSnippet(text, 6000);
      }
    } else if (
      record.type === "response_item" &&
      ["function_call", "custom_tool_call"].includes(String(payload.type)) &&
      typeof payload.name === "string" &&
      /^[\w.:-]{1,80}$/.test(payload.name)
    )
      push(result.tools, payload.name, 8);
  }
  return result;
}
