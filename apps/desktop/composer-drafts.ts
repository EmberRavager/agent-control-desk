import { z } from "zod";

const allocationFields = {
  targetAgentId: z.string().min(1).max(200).optional(),
  requiredCapabilities: z
    .array(z.enum(["steer", "resume", "approval", "input"]))
    .max(4)
    .optional(),
};
const composerSchema = z
  .object({
    text: z.string().max(100000),
    cwd: z.string().max(32768),
    targetTaskId: z.string().max(200).optional(),
    ...allocationFields,
    questionId: z.string().max(200).optional(),
  })
  .strict();
const pendingSchema = z
  .object({
    id: z.uuid(),
    text: z.string().min(1).max(20000),
    cwd: z.string().min(1).max(32768),
    targetTaskId: z.string().max(200).optional(),
    ...allocationFields,
  })
  .strict();
const draftSchema = z
  .object({
    version: z.literal(1),
    composer: composerSchema,
    pending: z
      .array(pendingSchema)
      .max(100)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
      ),
  })
  .strict();
export type ComposerContent = z.infer<typeof composerSchema>;
export type PendingSend = z.infer<typeof pendingSchema>;
type DraftRecord = z.infer<typeof draftSchema>;
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One local profile's composer and unconfirmed sends. Never sends automatically. */
export class ComposerDrafts {
  private value: DraftRecord = {
    version: 1,
    composer: { text: "", cwd: "" },
    pending: [],
  };
  private writable = true;
  readonly key: string;
  warning = "";
  constructor(
    private readonly storage?: DraftStorage,
    scope?: string,
  ) {
    this.key = "acd.composer.v1:" + encodeURIComponent(scope || "unavailable");
    if (!storage || !scope) {
      this.writable = false;
      this.warning =
        "无法读取本机草稿存储，重新打开客户端后再发送；当前输入仍可编辑。";
      return;
    }
    let raw: string | null;
    try {
      raw = storage.getItem(this.key);
    } catch {
      this.writable = false;
      this.warning = "无法读取本机草稿，请检查本地存储后重试。";
      return;
    }
    if (!raw) return;
    try {
      if (raw.length > 5 * 1024 * 1024) throw Error("Draft too large");
      this.value = draftSchema.parse(JSON.parse(raw));
    } catch {
      try {
        storage.setItem(this.key + ".recovery-" + crypto.randomUUID(), raw);
        storage.removeItem(this.key);
        this.warning = "旧草稿格式异常，原记录已另存为恢复副本。";
      } catch {
        this.writable = false;
        this.warning = "旧草稿无法恢复，原记录仍保留；请检查本地存储后重试。";
      }
    }
  }
  read(): DraftRecord {
    return structuredClone(this.value);
  }
  saveComposer(composer: ComposerContent) {
    if (JSON.stringify(this.value.composer) === JSON.stringify(composer))
      return;
    this.commit({ ...this.value, composer });
  }
  stageSend(input: PendingSend, clearComposer = false) {
    const receipt = pendingSchema.parse(input);
    const existing = this.value.pending.find((item) => item.id === receipt.id);
    if (
      existing &&
      (existing.text !== receipt.text ||
        existing.cwd !== receipt.cwd ||
        existing.targetTaskId !== receipt.targetTaskId ||
        existing.targetAgentId !== receipt.targetAgentId ||
        JSON.stringify(
          [...new Set(existing.requiredCapabilities || [])].sort(),
        ) !==
          JSON.stringify(
            [...new Set(receipt.requiredCapabilities || [])].sort(),
          ))
    )
      throw Error("发送编号已对应其他内容，请重新发送新消息。");
    if (existing && !clearComposer) return;
    this.commit({
      ...this.value,
      ...(clearComposer ? { composer: { text: "", cwd: receipt.cwd } } : {}),
      pending: existing ? this.value.pending : [...this.value.pending, receipt],
    });
  }
  acknowledge(ids: Set<string>) {
    const pending = this.value.pending.filter((item) => !ids.has(item.id));
    if (pending.length !== this.value.pending.length)
      this.commit({ ...this.value, pending });
  }
  forget(id: string) {
    this.acknowledge(new Set([id]));
  }
  private commit(value: DraftRecord) {
    if (!this.storage || !this.writable)
      throw Error(
        "无法保存本机草稿与发送编号，请重新打开客户端或检查本地存储。",
      );
    const checked = draftSchema.safeParse(value);
    if (!checked.success)
      throw Error("草稿或待确认消息过多，请缩短内容或先处理已有发送记录。");
    try {
      this.storage.setItem(this.key, JSON.stringify(checked.data));
    } catch {
      throw Error("本机草稿保存失败，请检查可用空间或本地存储。");
    }
    this.value = checked.data;
  }
}
