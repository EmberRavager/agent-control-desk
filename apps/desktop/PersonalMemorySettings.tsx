import { useI18n } from "./i18n.js";
import React, { useEffect, useRef, useState } from "react";
import {
  memoryInputSchema,
  type PersonalMemory,
} from "../../packages/contracts/memory.js";

type Kind = PersonalMemory["kind"];
type Draft = Pick<PersonalMemory, "title" | "content" | "kind"> & {
  id?: string;
  revision?: number;
};
interface Props {
  active: boolean;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
}
const kinds = { preference: "使用偏好", workflow: "工作流程" } as const;
const sources = {
  manual: "手动维护",
  explicit: "对话中明确要求",
  learned: "从任务中学到",
};

export default function PersonalMemorySettings({ active, request }: Props) {
  const { t } = useI18n();
  const [memories, setMemories] = useState<PersonalMemory[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<PersonalMemory | null>(null);
  const [reload, setReload] = useState(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requester = useRef(request);
  requester.current = request;
  useEffect(() => {
    if (!active) return;
    let current = true;
    setReady(false);
    setError("");
    setDeleting(null);
    requester
      .current("GET", "/api/memories")
      .then((value) => {
        if (!current) return;
        setMemories(value as PersonalMemory[]);
        setReady(true);
      })
      .catch((failure) => {
        if (current)
          setError(
            failure instanceof Error
              ? failure.message
              : t("个人记忆加载失败。"),
          );
      });
    return () => {
      current = false;
    };
  }, [active, reload]);

  const latest = draft?.id
    ? memories.find((item) => item.id === draft.id)
    : undefined;
  const stale = Boolean(
    draft?.id && ready && draft.revision !== latest?.revision,
  );
  const locked = busy || !ready;
  function begin(next: Draft) {
    setError("");
    setNotice("");
    setDraft(next);
  }
  async function write(action: "save" | "delete") {
    if (locked) return;
    if (
      action === "save" &&
      (!draft || stale || !draft.title.trim() || !draft.content.trim())
    )
      return;
    if (action === "delete" && !deleting) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "delete" && deleting) {
        await request("POST", "/api/memories/" + deleting.id + "/delete", {
          expectedRevision: deleting.revision,
        });
        setDeleting(null);
        setNotice(t("记忆已删除。"));
      } else if (draft) {
        const input = {
          kind: draft.kind,
          title: draft.title.trim(),
          content: draft.content.trim(),
        };
        if (draft.id) {
          await request("PUT", "/api/memories/" + draft.id, {
            ...input,
            expectedRevision: draft.revision,
          });
        } else {
          await request("POST", "/api/memories", input);
        }
        setDraft(null);
        setNotice(t("记忆已保存。"));
      }
      setReload((value) => value + 1);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : t("操作失败，请重新加载后重试。"),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="settings-section-heading">
        <div>
          <h2 id="settings-memory-title">{t("个人记忆")}</h2>
          <p>
            {t(
              "总控会在相关对话中参考你要求记住的偏好，以及在多个任务中学到的流程。",
            )}
          </p>
        </div>
        <button
          className="button"
          disabled={locked || Boolean(draft || deleting)}
          onClick={() => begin({ kind: "preference", title: "", content: "" })}
        >
          {t("添加记忆")}
        </button>
      </div>
      {error && (
        <div className="memory-feedback">
          <p className="form-error" role="alert">
            {error}
          </p>
          <button
            className="button"
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          >
            {t("重新加载")}
          </button>
        </div>
      )}
      {!ready && !error && (
        <p className="field-help" role="status">
          {t("正在读取个人记忆…")}
        </p>
      )}
      {notice && (
        <p className="settings-saved" role="status">
          {notice}
        </p>
      )}
      {draft && (
        <form
          className="personal-memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            void write("save");
          }}
        >
          <h3>{draft.id ? t("编辑记忆") : t("添加记忆")}</h3>
          <label className="setting-field">
            <span>{t("类型")}</span>
            <select
              name="kind"
              value={draft.kind}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, kind: event.target.value as Kind })
              }
            >
              <option value="preference">{t("使用偏好")}</option>
              <option value="workflow">{t("工作流程")}</option>
            </select>
          </label>
          <label className="setting-field">
            <span>{t("标题")}</span>
            <input
              name="title"
              autoFocus
              required
              maxLength={memoryInputSchema.shape.title.maxLength ?? undefined}
              disabled={busy}
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label className="setting-field">
            <span>
              {draft.kind === "workflow" ? t("流程步骤") : t("偏好内容")}
            </span>
            <textarea
              name="content"
              rows={3}
              required
              maxLength={memoryInputSchema.shape.content.maxLength ?? undefined}
              disabled={busy}
              value={draft.content}
              placeholder={
                draft.kind === "workflow"
                  ? t("每行写一个步骤")
                  : t("希望总控怎样配合你？")
              }
              onChange={(event) =>
                setDraft({ ...draft, content: event.target.value })
              }
            />
          </label>
          {stale && (
            <div className="memory-conflict" role="alert">
              {latest ? (
                <>
                  <strong>
                    {t("这条记忆已更新。请核对最新内容后再保存草稿。")}
                  </strong>
                  <p>
                    {t(kinds[latest.kind])} · {latest.title}
                  </p>
                  <p>{latest.content}</p>
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      setDraft({ ...draft, revision: latest.revision })
                    }
                  >
                    {t("按最新版本继续编辑")}
                  </button>
                </>
              ) : (
                t("这条记忆已删除。你的草稿仍保留在上方，可以复制。")
              )}
            </div>
          )}
          <div className="memory-actions">
            <button
              type="submit"
              className="button primary"
              disabled={
                locked || stale || !draft.title.trim() || !draft.content.trim()
              }
            >
              {t("保存记忆")}
            </button>
            <button
              type="button"
              className="button ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                if (ready) setError("");
              }}
            >
              {t("取消")}
            </button>
          </div>
        </form>
      )}
      {(Object.keys(kinds) as Kind[]).map((kind) => {
        const items = memories.filter((memory) => memory.kind === kind);
        return (
          <section
            className="settings-info-block personal-memory-group"
            key={kind}
            aria-label={t(kinds[kind])}
          >
            <h3>
              {t(kinds[kind])}
              {ready && <small>{items.length}</small>}
            </h3>
            {ready && !items.length && (
              <p>
                {kind === "workflow"
                  ? t("还没有保存的工作流程。")
                  : t("还没有保存的使用偏好。")}
              </p>
            )}
            <ul>
              {items.map((memory) => (
                <li key={memory.id}>
                  <div className="memory-row-heading">
                    <strong>{memory.title}</strong>
                    <div className="memory-actions">
                      <button
                        className="button ghost"
                        aria-label={t("编辑 {title}", { title: memory.title })}
                        disabled={locked || Boolean(draft || deleting)}
                        onClick={() => begin(memory)}
                      >
                        {t("编辑")}
                      </button>
                      <button
                        className="button ghost danger"
                        aria-label={t("删除 {title}", { title: memory.title })}
                        disabled={locked || Boolean(draft || deleting)}
                        onClick={() => {
                          setError("");
                          setNotice("");
                          setDeleting(memory);
                        }}
                      >
                        {t("删除")}
                      </button>
                    </div>
                  </div>
                  <p className="memory-content">{memory.content}</p>
                  <p className="memory-source">
                    {t("来源 · {source}", {
                      source: t(sources[memory.source]),
                    })}
                    {kind === "workflow" &&
                      t(" · {count} 个独立任务", {
                        count: memory.evidenceCount,
                      })}
                  </p>
                  {deleting?.id === memory.id && (
                    <div className="memory-confirm">
                      <span>{t("删除后，总控将停止参考这条记忆。")}</span>
                      <div className="memory-actions">
                        <button
                          className="button danger"
                          disabled={locked}
                          onClick={() => void write("delete")}
                        >
                          {t("确认删除")}
                        </button>
                        <button
                          className="button ghost"
                          disabled={busy}
                          onClick={() => {
                            setDeleting(null);
                            setError("");
                          }}
                        >
                          {t("取消删除")}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
