/** Runtime fields extracted from a Codex rollout. No message or tool text is kept. */
export interface CodexRunEvents {
  internal?: boolean;
  sessionId: string;
  cwd: string;
  turnId?: string;
  originAt?: string;
  forkedFromId?: string;
  status: "running" | "idle" | "unknown";
  endedReason?: "completed" | "aborted";
  progress: string;
  eventAt?: string;
}

export function internalCodexSource(source: unknown): boolean {
  if (!source || typeof source !== "object") return false;
  const subagent = (source as { subagent?: unknown }).subagent;
  return Boolean(
    subagent &&
    typeof subagent === "object" &&
    (subagent as { other?: unknown }).other === "guardian",
  );
}
function uuidTime(id: string): number | undefined {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    id,
  )
    ? Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
    : undefined;
}

export function applyCodexRunEvent(
  line: string,
  expectedSessionId: string,
  previous?: CodexRunEvents,
): CodexRunEvents | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return previous;
  }
  if (!record || typeof record !== "object") return previous;
  const item = record as {
    type?: unknown;
    timestamp?: unknown;
    payload?: unknown;
  };
  if (!item.payload || typeof item.payload !== "object") return previous;
  const payload = item.payload as {
    id?: unknown;
    cwd?: unknown;
    type?: unknown;
    turn_id?: unknown;
    forked_from_id?: unknown;
    source?: unknown;
    timestamp?: unknown;
  };
  if (item.type === "session_meta") {
    if (payload.id !== expectedSessionId) {
      if (
        previous?.forkedFromId &&
        previous.originAt &&
        typeof payload.timestamp === "string" &&
        Date.parse(payload.timestamp) < Date.parse(previous.originAt)
      )
        return previous;
      throw Error("会话记录与指定会话编号不一致");
    }
    return {
      sessionId: expectedSessionId,
      ...(internalCodexSource(payload.source) ? { internal: true } : {}),
      cwd: typeof payload.cwd === "string" ? payload.cwd : "",
      status: "unknown",
      progress: "尚未读取到执行状态事件",
      originAt:
        typeof payload.timestamp === "string"
          ? payload.timestamp
          : typeof item.timestamp === "string"
            ? item.timestamp
            : undefined,
      forkedFromId:
        typeof payload.forked_from_id === "string"
          ? payload.forked_from_id
          : undefined,
    };
  }
  if (!previous || previous.sessionId !== expectedSessionId) return previous;
  if (item.type !== "event_msg") return previous;
  if (
    previous.forkedFromId &&
    previous.originAt &&
    typeof payload.turn_id === "string"
  ) {
    const createdAt = uuidTime(payload.turn_id);
    if (createdAt !== undefined && createdAt < Date.parse(previous.originAt))
      return previous;
    if (createdAt === undefined)
      return {
        ...previous,
        status: "unknown",
        progress: "派生会话的执行归属待核验",
      };
  }
  const eventAt =
    typeof item.timestamp === "string" ? item.timestamp : previous.eventAt;
  const turnId =
    typeof payload.turn_id === "string" ? payload.turn_id : undefined;
  if (payload.type === "task_started")
    return {
      ...previous,
      turnId,
      status: "running",
      endedReason: undefined,
      progress: "Codex 正在执行",
      eventAt: typeof item.timestamp === "string" ? item.timestamp : undefined,
    };
  if (payload.type === "task_complete" || payload.type === "turn_aborted") {
    if (turnId && previous.turnId && turnId !== previous.turnId)
      return previous;
    return {
      ...previous,
      status: "idle",
      endedReason: payload.type === "turn_aborted" ? "aborted" : "completed",
      progress:
        payload.type === "turn_aborted" ? "本轮已中止" : "本轮执行已结束",
      eventAt,
    };
  }
  if (
    previous.status !== "running" ||
    (turnId && previous.turnId && previous.turnId !== turnId)
  )
    return previous;
  const progress: Record<string, string> = {
    agent_reasoning: "Codex 正在分析",
    agent_message: "Codex 正在生成回复",
    exec_command_begin: "Codex 正在执行命令",
    exec_command_end: "命令执行结束，Codex 继续处理中",
    mcp_tool_call_begin: "Codex 正在调用工具",
    mcp_tool_call_end: "工具调用结束，Codex 继续处理中",
  };
  const text =
    typeof payload.type === "string" ? progress[payload.type] : undefined;
  return typeof text === "string"
    ? { ...previous, progress: text, eventAt }
    : previous;
}
