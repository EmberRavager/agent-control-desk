import { createHash, randomUUID } from "node:crypto";
import {
  memoryInputSchema,
  workflowObservationSchema,
  type MemoryInput,
  type PersonalMemory,
  type WorkflowObservation,
} from "../contracts/memory.js";
import type { Store } from "./store.js";

const records = "personal-memories";
const candidates = "personal-workflow-candidates";
const evidence = "personal-memory-evidence";
const suppressed = "personal-memory-suppressed";
const maxMemories = 200;
const maxCandidates = 128;

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().trim();
const compact = (text: string) =>
  normalize(text).replace(/[^\p{L}\p{N}]+/gu, "");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// Reject the complete input before writing any part of it to disk.
const credentials =
  /\[redacted\]|-----begin [^\r\n]*private key-----|\b(?:bearer|basic)\s+[a-z0-9._~+/-]+=*|\b(?:sk-[\w-]{12,}|gh[pousr]_[\w-]{12,}|github_pat_[\w-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b|(?:api[_ -]?key|access[_ -]?key|private[_ -]?key|client[_ -]?secret|secret|token|password|passwd|authorization|cookie|密码|密钥|口令|令牌|凭证)["']?\s*(?:[:=]|为|是|\bis\b)\s*\S|:\/\/[^/\s]+:[^/\s]+@/i;
const identifying =
  /(?:\b(?:https?|file|ssh|ftp):\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:^|[\s"'（(=:])(?:[a-z]:[\\/]|(?:\.{1,2}|~)?\/[\w.\p{L}~-])|(?:[\w.-]+\/){2}[\w.-]+|[\w.-]+\/[\w.-]+\.[a-z0-9]{1,8}\b|\/(?:Users|home|private|tmp|etc|var|opt)\/|\\\\[a-z0-9_.-]+\\|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b)/iu;
const genericQueryWord =
  /^(?:检查|进行|处理|流程|工作|任务|帮我|查看|整理|汇总|总结|编写|撰写|制作|准备|然后|完成|需要|生成|一下|check|make|sort|organize|prepare|use|the|and|for|with|this|task|please)$/;

function words(text: string): string[] {
  const parts = normalize(text).match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? [];
  const tokens = new Set<string>();
  for (const part of parts) {
    if (/\p{Script=Han}/u.test(part)) {
      if (part.length === 1) tokens.add(part);
      for (let i = 1; i < part.length; i++)
        tokens.add(part.slice(i - 1, i + 1));
    } else if (
      part.length > 1 &&
      !/^(the|and|for|with|this|task|please)$/.test(part)
    ) {
      tokens.add(part.length > 4 ? part.replace(/s$/, "") : part);
    }
  }
  return [...tokens];
}

function overlap(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const tokens = new Set(b);
  return a.filter((token) => tokens.has(token)).length;
}

interface Fingerprint {
  key: string;
  words: string[];
  negative: boolean;
}
function fingerprint(text: string): Fingerprint {
  // Summaries may qualify a completed item with 已 or 已经. Preserve 未 and
  // other negatives, which change which items the user wants to include.
  const comparable = text.replace(
    /(汇总|整理|列出|归纳|总结|收集|核对|检查)(?:已经|已)(?=\p{Script=Han})/gu,
    "$1",
  );
  return {
    key: hash(compact(comparable)),
    words: words(comparable).map(hash),
    negative:
      /不|未|勿|禁|别|无需|免除|\b(?:no|not|never|skip|avoid|without)\b/i.test(
        text,
      ),
  };
}
function similar(a: Fingerprint, b: Fingerprint, threshold: number) {
  if (a.key === b.key) return true;
  if (a.negative !== b.negative) return false;
  const shared = overlap(a.words, b.words);
  return (
    shared >= 2 && (2 * shared) / (a.words.length + b.words.length) >= threshold
  );
}
function sameActivity(a: Fingerprint, b: Fingerprint) {
  return similar(a, b, 0.62);
}

export function safeWorkflowObservation(
  input: unknown,
): WorkflowObservation | undefined {
  const parsed = workflowObservationSchema.safeParse(input);
  if (!parsed.success) return;
  const { activity, steps } = parsed.data;
  if (
    !compact(activity) ||
    [activity, ...steps].some(
      (text) =>
        credentials.test(text.normalize("NFKC")) ||
        identifying.test(text.normalize("NFKC")),
    )
  )
    return;
  const distinct: string[] = [];
  for (const step of steps) {
    if (
      compact(step) &&
      !distinct.some((previous) =>
        similar(fingerprint(previous), fingerprint(step), 0.8),
      )
    )
      distinct.push(step);
  }
  if (distinct.length >= 2 && distinct.join("\n").length <= 1000)
    return { activity, steps: distinct };
}

interface Candidate {
  id: string;
  activity: string;
  steps: Fingerprint[];
}

// At most eight steps per report. Use the ordered intersection so one-off
// steps and reversed sequences do not become reusable instructions.
function repeatedSteps(current: Fingerprint[], previous: Fingerprint[]) {
  const paths: number[][][] = Array.from({ length: current.length + 1 }, () =>
    Array.from({ length: previous.length + 1 }, () => []),
  );
  for (let i = 1; i <= current.length; i++) {
    for (let j = 1; j <= previous.length; j++) {
      if (similar(current[i - 1], previous[j - 1], 0.78)) {
        paths[i][j] = [...paths[i - 1][j - 1], i - 1];
      } else {
        paths[i][j] =
          paths[i - 1][j].length > paths[i][j - 1].length
            ? paths[i - 1][j]
            : paths[i][j - 1];
      }
    }
  }
  return paths[current.length][previous.length];
}

function validSource(id: string) {
  return typeof id === "string" && id.trim().length > 0 && id.length <= 256;
}
function validate(input: MemoryInput) {
  const value = memoryInputSchema.parse(input);
  if (
    credentials.test(value.title.normalize("NFKC")) ||
    credentials.test(value.content.normalize("NFKC"))
  )
    throw Error("记忆中不能包含凭证。");
  return value;
}

export class PersonalMemories {
  constructor(private store: Store) {}

  list(): PersonalMemory[] {
    return this.store
      .list<PersonalMemory>(records)
      .reverse()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private insert(
    input: MemoryInput,
    source: PersonalMemory["source"],
    evidenceCount: number,
  ) {
    const now = new Date().toISOString();
    const memory: PersonalMemory = {
      ...input,
      id: randomUUID(),
      source,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      evidenceCount,
    };
    this.store.put(records, memory.id, memory);
    return memory;
  }

  create(input: MemoryInput): PersonalMemory {
    const value = validate(input);
    return this.store.transaction(() => {
      if (this.list().length >= maxMemories)
        throw Error("个人记忆数量已达上限。");
      return this.insert(value, "manual", 0);
    });
  }

  private current(id: string, revision: number) {
    const current = this.store.get<PersonalMemory>(records, id);
    if (!current)
      throw Object.assign(Error("这条记忆不存在。"), { statusCode: 404 });
    if (revision !== current.revision)
      throw Object.assign(Error("这条记忆已更新，请刷新后重试。"), {
        statusCode: 409,
      });
    return current;
  }

  private suppress(input: MemoryInput) {
    if (input.kind === "preference") {
      for (const value of [input.title, input.content])
        this.store.put(suppressed, "preference:" + hash(compact(value)), true);
      return;
    }
    const topic = fingerprint(input.title);
    this.store.put(suppressed, "workflow:" + topic.key, { topic });
    for (const pending of this.store.list<Candidate>(candidates)) {
      if (sameActivity(topic, fingerprint(pending.activity)))
        this.store.remove(candidates, pending.id);
    }
  }

  update(
    id: string,
    input: MemoryInput,
    expectedRevision: number,
  ): PersonalMemory {
    const value = validate(input);
    return this.store.transaction(() => {
      const current = this.current(id, expectedRevision);
      this.suppress(current);
      const next: PersonalMemory = {
        ...current,
        ...value,
        source: "manual",
        evidenceCount: 0,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.store.put(records, id, next);
      return next;
    });
  }
  remove(id: string, expectedRevision: number): void {
    this.store.transaction(() => {
      this.suppress(this.current(id, expectedRevision));
      this.store.remove(records, id);
    });
  }

  rememberPreference(
    input: MemoryInput,
    sourceId: string,
  ): PersonalMemory | undefined {
    const parsed = memoryInputSchema.safeParse(input);
    if (
      !validSource(sourceId) ||
      !parsed.success ||
      parsed.data.kind !== "preference"
    )
      return;
    const value = parsed.data;
    if (
      [value.title, value.content].some((text) =>
        credentials.test(text.normalize("NFKC")),
      )
    )
      return;
    const source = "preference:" + hash(sourceId);
    return this.store.transaction(() => {
      if (this.store.get(evidence, source)) return;
      for (const part of [value.title, value.content]) {
        if (this.store.get(suppressed, "preference:" + hash(compact(part))))
          return;
      }
      const active = this.list();
      const matches = active.filter(
        (m) =>
          m.kind === "preference" &&
          (compact(m.title) === compact(value.title) ||
            compact(m.content) === compact(value.content)),
      );
      if (matches.some((m) => m.source === "manual")) return;
      const prior = matches[0];
      if (!prior && active.length >= maxMemories) return;
      this.store.put(evidence, source, true);
      if (!prior) return this.insert(value, "explicit", 1);
      const same = compact(prior.content) === compact(value.content);
      const next = {
        ...prior,
        ...(same ? {} : value),
        evidenceCount: same ? prior.evidenceCount + 1 : 1,
        revision: prior.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.store.put(records, prior.id, next);
      return next;
    });
  }

  workflowActivities(): string[] {
    const active = this.list()
      .filter((m) => m.kind === "workflow")
      .map((m) => m.title);
    const pending = this.store
      .list<Candidate>(candidates)
      .reverse()
      .map((c) => c.activity);
    return [...new Set([...pending, ...active])].slice(0, 12);
  }

  observeWorkflow(
    observation: WorkflowObservation,
    sourceTaskId: string,
  ): PersonalMemory | undefined {
    const safe = safeWorkflowObservation(observation);
    if (!safe || !validSource(sourceTaskId)) return;
    const { activity, steps } = safe;
    const topic = fingerprint(activity),
      signature = steps.map(fingerprint),
      id = hash(sourceTaskId);
    const source = "workflow:" + id;
    return this.store.transaction(() => {
      if (this.store.get(evidence, source)) return;
      if (
        this.store
          .list<{ topic?: Fingerprint } | true>(suppressed)
          .some(
            (row) =>
              row !== true && row.topic && sameActivity(topic, row.topic),
          )
      )
        return;
      const active = this.list();
      const matching = active.filter(
        (m) =>
          m.kind === "workflow" && sameActivity(topic, fingerprint(m.title)),
      );
      if (matching.some((m) => m.source === "manual")) return;
      this.store.put(evidence, source, true);
      for (const memory of matching) {
        if (
          repeatedSteps(signature, memory.content.split("\n").map(fingerprint))
            .length >= 2
        ) {
          const next = {
            ...memory,
            revision: memory.revision + 1,
            evidenceCount: memory.evidenceCount + 1,
            updatedAt: new Date().toISOString(),
          };
          this.store.put(records, memory.id, next);
          return next;
        }
      }
      if (active.length >= maxMemories) return;
      const pending = this.store.list<Candidate>(candidates);
      for (const prior of pending) {
        if (!sameActivity(topic, fingerprint(prior.activity))) continue;
        const common = repeatedSteps(signature, prior.steps);
        if (common.length < 2) continue;
        const content = common.map((i) => steps[i]).join("\n");
        this.store.remove(candidates, prior.id);
        return this.insert(
          { kind: "workflow", title: prior.activity, content },
          "learned",
          2,
        );
      }
      if (pending.length >= maxCandidates)
        this.store.remove(candidates, pending[0].id);
      this.store.put(candidates, id, {
        id,
        activity,
        steps: signature,
      } satisfies Candidate);
    });
  }

  select(text: string): PersonalMemory[] {
    const query = words(text.slice(0, 4000)).filter(
      (token) => !genericQueryWord.test(token),
    );
    const ranked = this.list()
      .map((memory) => {
        const title = overlap(words(memory.title), query);
        const body = overlap(words(memory.content), query);
        return { memory, relevance: title * 3 + (body > 1 ? body : 0) };
      })
      .filter(
        ({ memory, relevance }) =>
          memory.kind === "preference" || relevance > 0,
      );
    ranked.sort(
      (a, b) =>
        b.relevance - a.relevance ||
        Number(b.memory.source !== "learned") -
          Number(a.memory.source !== "learned"),
    );
    const selected: PersonalMemory[] = [];
    for (const { memory } of ranked) {
      if (JSON.stringify([...selected, memory]).length <= 1800)
        selected.push(memory);
      if (selected.length === 5) break;
    }
    return selected;
  }
}
