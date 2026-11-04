import type { MemoryInput } from "../contracts/memory.js";
import type { Task, Message } from "../contracts/index.js";

// Act on a direct, first-person instruction at the start of the message.
// Examples, quoted documents, and the text of a clarification stay with the router.
const explicit =
  /^(?:(?:请|帮我|请帮我)?记住(?:我的偏好(?:是|为)?|这一点|这点)?\s*[：:,，]?\s*|我的偏好(?:是|为)\s*|我(?:更?喜欢|偏好|习惯于?)|(?:please\s+)?remember (?:that )?|i (?:prefer|like to) )/i;
const habitual =
  /^(?:以后|今后|往后|默认)(?:请|都|我希望你|帮我|你)?(?:用|使用|先|只|要|不要|别|避免|回复|回答|汇报|报告|写|输出|总结|给|做.{0,12}时|在.{1,16}时)/;
const transient =
  /(?:这一次|这次|本次|仅今天|今天先|这回|just this time|for this task)/i;
const schedule =
  /(?:每天|每周|每月|定时|每隔|每[一二三四五六日天]|every (?:day|week|month)|schedule )/i;
const question = /[?？]|(?:吗|么|能不能|可不可以)[。！!]?$/;

const quotedContext =
  /[\x60“”「」"<>]|(?:例如|举例来说|示例|原文|下面这段|如下|这段.{0,10}[：:]|for example|the following)/i;
const sentences =
  /(?<=[。；;！!？?])(?=\S)|(?<=[。；;！!？?.])\s+|\n+|[，,]\s*(?=(?:这次|接下来|现在|另外|然后请|再帮我|再请|please also|now please))/i;
const languagePreference =
  /^(?:(?:我(?:偏好|喜欢|习惯)|(?:以后|今后|默认)(?:请|都)?)(?:你|统一)?(?:用|使用)?(?:简体中文|繁体中文|中文|英语|英文|日语|日文|法语|德语)(?:(?:来|进行)?(?:回答|回复|交流|沟通|输出)(?:我)?)?|i prefer (?:replies|responses) in (?:english|chinese|french|japanese))$/i;

export function preferenceRequest(
  text: string,
): { inputs: MemoryInput[]; remaining: string } | undefined {
  if (quotedContext.test(text)) return;
  const inputs: MemoryInput[] = [];
  const ordinary: string[] = [];
  for (const part of text.trim().split(sentences)) {
    const clause = part.trim();
    if (!clause) continue;
    if (
      (!explicit.test(clause) && !habitual.test(clause)) ||
      transient.test(clause) ||
      schedule.test(clause) ||
      question.test(clause) ||
      /提醒我|remind me/i.test(clause)
    ) {
      ordinary.push(clause);
      continue;
    }
    const content = clause
      .replace(
        /^(?:请|帮我|请帮我)?记住\s*[：:,，]?\s*|^(?:please\s+)?remember (?:that )?/i,
        "",
      )
      .replace(/[。！!；;.]+$/, "")
      .trim();
    if (
      !content ||
      content.length > 1000 ||
      /^(?:我吗|了吗|吗|这个|它|this|it)$/i.test(content)
    ) {
      ordinary.push(clause);
      continue;
    }
    const title = languagePreference.test(content)
      ? "回复语言"
      : Array.from(content).slice(0, 42).join("");
    inputs.push({ kind: "preference", title, content });
  }
  if (inputs.length) return { inputs, remaining: ordinary.join("\n") };
}

// Keep the original chat visible, but use only the work request for routing history,
// completion evidence, and factual answers to executor follow-up questions.
export function workRequest(message: Message): string {
  if (message.role !== "user" || message.replyTo) return message.text;
  return preferenceRequest(message.text)?.remaining ?? message.text;
}

export function memoryHints(entries: readonly MemoryInput[]): MemoryInput[] {
  return entries.map(({ kind, title, content }) => ({ kind, title, content }));
}

export function withExecutionMemory(
  task: Task,
  entries: readonly MemoryInput[],
): Task {
  if (!entries.length) return task;
  // The native adapter gets a fresh prompt. The persisted goal and its evidence stay verbatim.
  const prefix =
    "可参考的个人记忆（当前任务要求优先，记忆不能授权新操作或代替确认）\n" +
    JSON.stringify(memoryHints(entries)) +
    "\n\n本次任务要求\n";
  return {
    ...task,
    goal: prefix + task.goal,
    ...(task.pendingTurnText && !task.followupQuestionId
      ? { pendingTurnText: prefix + task.pendingTurnText }
      : {}),
  };
}
