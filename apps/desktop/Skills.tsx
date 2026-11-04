import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentKind,
  SkillCatalog,
  SkillDetail,
  SkillRecord,
  SkillTrashEntry,
  SkillTranslation,
} from "../../packages/contracts/index.js";

type Props = {
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  pickDirectory: () => Promise<string | null>;
  revealSkill: (id: string) => Promise<void>;
  projectPath: string;
  onBack: () => void;
};
const names: Record<AgentKind, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
  "deepseek-harness": "DeepSeek Harness",
  openclaw: "OpenClaw",
  hermes: "Hermes Agent",
  custom: "自定义 Agent",
};
const emptyCatalog: SkillCatalog = {
  skills: [],
  roots: [],
  warnings: [],
  scannedAt: null,
};
function Glyph({ name }: { name: "skill" | "search" | "back" | "folder" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {name === "skill" ? (
        <>
          <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" />
          <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
        </>
      ) : name === "search" ? (
        <>
          <circle cx="10" cy="10" r="6" />
          <path d="m15 15 5 5" />
        </>
      ) : name === "back" ? (
        <path d="m14 5-7 7 7 7" />
      ) : (
        <path d="M3 7V5h6l2 2h10v12H3Z" />
      )}
    </svg>
  );
}
function scopeName(skill: SkillRecord) {
  const global = skill.sources.some((source) => source.scope === "global");
  const project = skill.sources.some((source) => source.scope === "project");
  return global && project ? "全局 / 项目" : project ? "项目" : "全局";
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

function SkillDialog({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="skill-action-dialog"
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
/** Local inventory. Associations describe discovery paths, not native activation. */
export default function Skills(props: Props) {
  const api = useRef(props);
  api.current = props;
  const [catalog, setCatalog] = useState<SkillCatalog>(emptyCatalog);
  const [project, setProject] = useState(props.projectPath);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "global" | "project">("all");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [translation, setTranslation] = useState<SkillTranslation | null>(null);
  const [translating, setTranslating] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translationError, setTranslationError] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [action, setAction] = useState<"create" | "delete" | "trash" | null>(
    null,
  );
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [createRoot, setCreateRoot] = useState("");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createContent, setCreateContent] = useState("");
  const [deleteRecord, setDeleteRecord] = useState<SkillRecord | null>(null);
  const [trash, setTrash] = useState<SkillTrashEntry[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const live = useRef(true);
  const scanVersion = useRef(0);
  const previewVersion = useRef(0);
  const selectedRef = useRef<string | null>(null);

  function resetTranslation() {
    setTranslation(null);
    setTranslating(false);
    setShowTranslation(false);
    setTranslationError("");
  }

  async function translate() {
    if (translation) {
      setShowTranslation((show) => !show);
      return;
    }
    if (!detail || !selectedRef.current || translating) return;
    const version = previewVersion.current;
    const id = selectedRef.current;
    setTranslating(true);
    setTranslationError("");
    try {
      const value = (await api.current.request(
        "POST",
        `/api/skills/${encodeURIComponent(id)}/translate`,
        {},
      )) as SkillTranslation;
      if (!live.current || version !== previewVersion.current) return;
      setTranslation(value);
      setShowTranslation(true);
    } catch (failure) {
      if (live.current && version === previewVersion.current)
        setTranslationError(errorMessage(failure));
    } finally {
      if (live.current && version === previewVersion.current)
        setTranslating(false);
    }
  }

  async function preview(id: string) {
    resetTranslation();
    selectedRef.current = id;
    setSelected(id);
    const version = ++previewVersion.current;
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    try {
      const value = (await api.current.request(
        "GET",
        `/api/skills/${encodeURIComponent(id)}`,
      )) as SkillDetail;
      if (!live.current || version !== previewVersion.current) return;
      setDetail(value);
    } catch (failure) {
      if (live.current && version === previewVersion.current)
        setDetailError(errorMessage(failure));
    } finally {
      if (live.current && version === previewVersion.current)
        setDetailLoading(false);
    }
  }

  async function scan(
    path: string,
    selectName?: string,
    preferredRoot?: string,
  ) {
    const version = ++scanVersion.current;
    setScanning(true);
    setError("");
    try {
      const value = (await api.current.request("POST", "/api/skills/scan", {
        ...(path ? { projectPath: path } : {}),
      })) as SkillCatalog;
      if (!live.current || version !== scanVersion.current) return;
      setCatalog(value);
      const retained = selectName
        ? value.skills.find(
            (skill) =>
              skill.name === selectName &&
              (!preferredRoot ||
                skill.sources.some(
                  (source) => source.rootPath === preferredRoot,
                )),
          )?.id
        : selectedRef.current;
      if (retained && value.skills.some((skill) => skill.id === retained))
        void preview(retained);
      else {
        selectedRef.current = null;
        setSelected(null);
        ++previewVersion.current;
        resetTranslation();
        setDetail(null);
        setDetailLoading(false);
        setDetailError("");
      }
    } catch (failure) {
      if (live.current && version === scanVersion.current)
        setError(errorMessage(failure));
    } finally {
      if (live.current && version === scanVersion.current) setScanning(false);
    }
  }
  useEffect(() => {
    live.current = true;
    void scan(api.current.projectPath);
    return () => {
      live.current = false;
      ++scanVersion.current;
      ++previewVersion.current;
    };
  }, []);

  async function chooseProject() {
    try {
      const path = await api.current.pickDirectory();
      if (!path || !live.current) return;
      setProject(path);
      selectedRef.current = null;
      ++previewVersion.current;
      setSelected(null);
      setDetail(null);
      void scan(path);
    } catch (failure) {
      if (live.current) setError(errorMessage(failure));
    }
  }
  async function reveal() {
    if (!selected) return;
    const id = selected;
    const version = previewVersion.current;
    setRevealing(true);
    setDetailError("");
    try {
      await api.current.revealSkill(id);
    } catch (failure) {
      if (
        live.current &&
        selectedRef.current === id &&
        version === previewVersion.current
      )
        setDetailError(errorMessage(failure));
    } finally {
      if (live.current) setRevealing(false);
    }
  }

  function openCreate() {
    const roots = catalog.roots;
    setCreateRoot(
      roots.find(
        (root) =>
          root.scope === "global" &&
          root.rootPath.replaceAll("\\", "/").endsWith("/.agents/skills"),
      )?.rootPath ||
        roots[0]?.rootPath ||
        "",
    );
    setCreateName("");
    setCreateDescription("");
    setCreateContent("");
    setMutationError("");
    setAction("create");
  }
  function openDelete(record: SkillRecord) {
    setDeleteRecord(record);
    setMutationError("");
    setAction("delete");
  }
  async function openTrash() {
    setAction("trash");
    setMutationError("");
    setTrashLoading(true);
    try {
      const entries = (await api.current.request(
        "GET",
        "/api/skills/trash",
      )) as SkillTrashEntry[];
      if (live.current) setTrash(entries);
    } catch (failure) {
      if (live.current) setMutationError(errorMessage(failure));
    } finally {
      if (live.current) setTrashLoading(false);
    }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (mutationBusy) return;
    setMutationBusy(true);
    setMutationError("");
    try {
      await api.current.request("POST", "/api/skills", {
        rootPath: createRoot,
        name: createName.trim(),
        description: createDescription.trim(),
        content: createContent,
      });
      if (!live.current) return;
      setAction(null);
      setQuery("");
      setScope("all");
      setIssuesOnly(false);
      await scan(project, createName.trim(), createRoot);
    } catch (failure) {
      if (live.current) setMutationError(errorMessage(failure));
    } finally {
      if (live.current) setMutationBusy(false);
    }
  }
  async function moveToTrash() {
    if (!deleteRecord || mutationBusy) return;
    const id = deleteRecord.id;
    setMutationBusy(true);
    setMutationError("");
    try {
      await api.current.request(
        "POST",
        `/api/skills/${encodeURIComponent(id)}/trash`,
        {},
      );
      if (!live.current) return;
      if (selectedRef.current === id) {
        selectedRef.current = null;
        setSelected(null);
        setDetail(null);
        ++previewVersion.current;
      }
      setAction(null);
      setDeleteRecord(null);
      await scan(project);
    } catch (failure) {
      if (live.current) setMutationError(errorMessage(failure));
    } finally {
      if (live.current) setMutationBusy(false);
    }
  }
  async function restore(entry: SkillTrashEntry) {
    if (mutationBusy) return;
    setMutationBusy(true);
    setMutationError("");
    try {
      await api.current.request(
        "POST",
        `/api/skills/trash/${encodeURIComponent(entry.id)}/restore`,
        {},
      );
      if (!live.current) return;
      setTrash((items) => items.filter((item) => item.id !== entry.id));
      await scan(project);
    } catch (failure) {
      if (live.current) setMutationError(errorMessage(failure));
    } finally {
      if (live.current) setMutationBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return catalog.skills.filter(
      (skill) =>
        (scope === "all" ||
          skill.sources.some((source) => source.scope === scope)) &&
        (!issuesOnly || skill.warnings.length > 0 || !skill.valid) &&
        (!term ||
          [skill.name, skill.description, skill.path].some((value) =>
            value.toLocaleLowerCase().includes(term),
          )),
    );
  }, [catalog, query, scope, issuesOnly]);
  const issueCount = catalog.skills.filter(
    (skill) => !skill.valid || skill.warnings.length,
  ).length;
  const record = catalog.skills.find((skill) => skill.id === selected);
  const linkedAgents = [
    ...new Set(record?.sources.flatMap((source) => source.agents) || []),
  ];
  const shortProject = project.split(/[\\/]/).filter(Boolean).at(-1);

  return (
    <section className="skills-page" aria-label="技能管理">
      <header className="topbar skills-topbar">
        <div className="row">
          <button
            className="icon"
            onClick={props.onBack}
            aria-label="返回总控对话"
          >
            <Glyph name="back" />
          </button>
          <h1>技能（skill）</h1>
          <span className="skills-total">{catalog.skills.length}</span>
        </div>
        <div className="row skills-toolbar-actions">
          <button
            className="button primary"
            disabled={scanning || mutationBusy || !catalog.roots.length}
            onClick={openCreate}
          >
            新建技能
          </button>
          <button
            className="button ghost"
            disabled={mutationBusy}
            onClick={() => void openTrash()}
          >
            回收区
          </button>
          <button
            className="button ghost skills-project"
            disabled={scanning}
            onClick={() => void chooseProject()}
            title={project || "选择项目以扫描项目级技能"}
          >
            <Glyph name="folder" />
            {shortProject || "选择项目"}
          </button>
          <button
            className="button"
            disabled={scanning}
            onClick={() => void scan(project)}
          >
            {scanning ? "扫描中…" : "重新扫描"}
          </button>
        </div>
      </header>
      <div className="skills-context">
        <span>本地技能目录</span>
        <span>已发现 ≠ 已启用</span>
      </div>
      {error && (
        <div className="skills-error" role="alert">
          <span>{error}</span>
          <button
            className="button ghost"
            disabled={scanning}
            onClick={() => void scan(project)}
          >
            重试
          </button>
        </div>
      )}
      {catalog.warnings.length > 0 && (
        <details className="skills-scan-warning">
          <summary>扫描提示 · {catalog.warnings.length}</summary>
          {catalog.warnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </details>
      )}
      <div className="skills-content">
        <div className="skills-browser">
          <div className="skills-find">
            <Glyph name="search" />
            <input
              type="search"
              aria-label="搜索技能"
              placeholder="搜索名称、用途或路径"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="skills-filters" aria-label="筛选技能范围">
            {(
              [
                ["all", "全部"],
                ["global", "全局"],
                ["project", "项目"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={scope === value}
                onClick={() => setScope(value)}
              >
                {label}
              </button>
            ))}
            {issueCount > 0 && (
              <button
                className="skills-issue-filter"
                aria-pressed={issuesOnly}
                onClick={() => setIssuesOnly((value) => !value)}
              >
                待检查 {issueCount}
              </button>
            )}
          </div>
          <div
            className="skills-list"
            aria-label="本地技能列表"
            aria-busy={scanning}
          >
            {scanning && catalog.skills.length === 0 ? (
              <p className="skills-empty" role="status">
                正在扫描本地技能…
              </p>
            ) : filtered.length === 0 ? (
              <div className="skills-empty">
                <Glyph name="skill" />
                <p>
                  {catalog.skills.length
                    ? "没有匹配的技能"
                    : "暂未发现本地技能"}
                </p>
                <small>
                  {catalog.skills.length
                    ? "换个关键词或筛选条件试试。"
                    : "可选择项目目录，再扫描已有的技能文件。"}
                </small>
              </div>
            ) : (
              filtered.map((skill) => (
                <button
                  className={
                    "skills-item " + (skill.id === selected ? "selected" : "")
                  }
                  aria-current={skill.id === selected ? "true" : undefined}
                  key={skill.id}
                  onClick={() => void preview(skill.id)}
                >
                  <span className="skills-item-heading">
                    <strong>{skill.name}</strong>
                    <span className="skills-scope">{scopeName(skill)}</span>
                  </span>
                  <span className="skills-description">
                    {skill.description || "缺少用途说明"}
                  </span>
                  <span className="skills-item-meta">
                    <span>
                      {[
                        ...new Set(skill.sources.map((source) => source.label)),
                      ].join(" / ")}
                    </span>
                    {(!skill.valid || skill.warnings.length > 0) && (
                      <span className="skills-item-warning">待检查</span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="skills-list-footer">
            {filtered.length} 项
            {scanning
              ? " · 更新中"
              : catalog.scannedAt
                ? " · 本地扫描结果"
                : ""}
          </div>
        </div>
        <div
          className="skills-inspector"
          aria-label="技能详情"
          aria-busy={detailLoading}
        >
          {!record ? (
            <div className="skills-detail-empty">
              <Glyph name="skill" />
              <h2>查看已有的工作方法。</h2>
              <p>选择一个技能，查看说明、来源和关联路径。</p>
            </div>
          ) : (
            <>
              <div className="skills-detail-header">
                <div>
                  <span className="skills-scope">{scopeName(record)}</span>
                  <h2>{record.name}</h2>
                </div>
                <div className="skills-detail-actions">
                  <button
                    className="button ghost"
                    disabled={!detail || detailLoading || translating}
                    aria-pressed={showTranslation}
                    title="使用总控模型翻译为中文，仅用于阅读"
                    onClick={() => void translate()}
                  >
                    {translating
                      ? "翻译中…"
                      : showTranslation
                        ? "原文"
                        : "翻译"}
                  </button>
                  <button
                    className="button ghost danger"
                    disabled={mutationBusy || scanning}
                    onClick={() => openDelete(record)}
                  >
                    删除
                  </button>
                  <button
                    className="icon"
                    disabled={revealing}
                    title="在文件夹中显示"
                    aria-label="在文件夹中显示此技能"
                    onClick={() => void reveal()}
                  >
                    <Glyph name="folder" />
                  </button>
                </div>
              </div>
              <p className="skills-detail-description">
                {(showTranslation
                  ? translation?.description
                  : record.description) || "此技能缺少 description 元信息。"}
              </p>
              {translationError && (
                <div className="skills-error" role="alert">
                  {translationError}
                </div>
              )}
              <div className="skills-associations">
                <span>路径关联 · 加载未验证</span>
                <div>
                  {linkedAgents.length ? (
                    linkedAgents.map((kind) => (
                      <span className="skills-agent" key={kind}>
                        {names[kind]}
                      </span>
                    ))
                  ) : (
                    <span className="small">未识别关联 Agent</span>
                  )}
                </div>
              </div>
              {(record.warnings.length > 0 || !record.valid) && (
                <div className="skills-record-warnings" role="status">
                  <strong>需要检查</strong>
                  {record.warnings.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                  {!record.valid && record.warnings.length === 0 && (
                    <p>技能元信息不完整或格式无效。</p>
                  )}
                </div>
              )}
              <details className="skills-source-detail">
                <summary>来源与文件位置</summary>
                <p className="skills-full-path">{record.path}</p>
                {record.sources.map((source, index) => (
                  <div className="skills-source" key={index}>
                    <span>
                      {source.label} ·{" "}
                      {source.scope === "global" ? "全局" : "项目"}
                    </span>
                    <code>{source.rootPath}</code>
                  </div>
                ))}
              </details>
              <div className="skills-preview-heading">
                <h3>SKILL.md</h3>
                <span>
                  {showTranslation ? "中文译文 · 仅供阅读" : "只读预览"}
                </span>
              </div>
              {detailError && (
                <div className="skills-error" role="alert">
                  <span>{detailError}</span>
                  <button
                    className="button ghost"
                    onClick={() => void preview(record.id)}
                  >
                    重试
                  </button>
                </div>
              )}
              {detailLoading ? (
                <p className="skills-preview-loading" role="status">
                  正在读取技能…
                </p>
              ) : (
                detail && (
                  <>
                    <pre className="skills-preview">
                      {showTranslation ? translation?.content : detail.content}
                    </pre>
                    {(showTranslation
                      ? translation?.truncated
                      : detail.truncated) && (
                      <p className="skills-truncated">
                        {showTranslation
                          ? "文件较长，仅翻译前 12,000 字。可切回原文查看。"
                          : "文件较长，仅展示前段内容。可在文件夹中打开原文件。"}
                      </p>
                    )}
                  </>
                )
              )}
            </>
          )}
        </div>
      </div>
      {action === "create" && (
        <SkillDialog
          title="新建技能"
          busy={mutationBusy}
          onClose={() => setAction(null)}
        >
          <form onSubmit={create}>
            <label className="setting-field">
              <span>保存位置</span>
              <select
                value={createRoot}
                onChange={(event) => setCreateRoot(event.target.value)}
                required
              >
                {catalog.roots.map((root) => (
                  <option key={root.rootPath} value={root.rootPath}>
                    {root.scope === "project" ? "项目" : "全局"} · {root.label}{" "}
                    · {root.rootPath}
                  </option>
                ))}
              </select>
            </label>
            <label className="setting-field">
              <span>技能名称</span>
              <input
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                required
                maxLength={64}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="例如：weekly-review"
                autoComplete="off"
              />
              <small>小写字母、数字和连字符。</small>
            </label>
            <label className="setting-field">
              <span>用途说明</span>
              <textarea
                rows={2}
                required
                maxLength={1024}
                value={createDescription}
                onChange={(event) => setCreateDescription(event.target.value)}
                placeholder="这个技能做什么，什么时候使用。"
              />
            </label>
            <label className="setting-field">
              <span>技能内容</span>
              <textarea
                className="skill-content-input"
                rows={8}
                required
                value={createContent}
                onChange={(event) => setCreateContent(event.target.value)}
                placeholder="填写工作步骤与要求，系统会生成标准 SKILL.md。"
              />
            </label>
            {mutationError && (
              <p className="form-error" role="alert">
                {mutationError}
              </p>
            )}
            <div className="modal-footer">
              <span className="small">创建文件，不会自动执行或启用。</span>
              <button className="button primary" disabled={mutationBusy}>
                {mutationBusy ? "正在创建…" : "创建技能"}
              </button>
            </div>
          </form>
        </SkillDialog>
      )}
      {action === "delete" && deleteRecord && (
        <SkillDialog
          title="删除技能"
          busy={mutationBusy}
          onClose={() => setAction(null)}
        >
          <p className="skill-delete-name">{deleteRecord.name}</p>
          <p className="settings-note">
            将此技能目录及其配套资源移入回收区，可以恢复。关联路径下的 Agent
            后续可能无法发现它；运行中的会话不会因此自动卸载。
          </p>
          <div className="skill-delete-sources">
            {deleteRecord.sources.map((source, index) => (
              <div key={index}>
                <strong>
                  {source.scope === "global" ? "全局" : "项目"} · {source.label}
                </strong>
                <code>{source.rootPath}</code>
              </div>
            ))}
          </div>
          <p className="skills-full-path">{deleteRecord.directory}</p>
          {mutationError && (
            <p className="form-error" role="alert">
              {mutationError}
            </p>
          )}
          <div className="modal-footer">
            <button
              className="button"
              disabled={mutationBusy}
              onClick={() => setAction(null)}
            >
              保留技能
            </button>
            <button
              className="button danger"
              disabled={mutationBusy}
              onClick={() => void moveToTrash()}
            >
              {mutationBusy ? "正在移入…" : "移入回收区"}
            </button>
          </div>
        </SkillDialog>
      )}
      {action === "trash" && (
        <SkillDialog
          title="技能回收区"
          busy={mutationBusy}
          onClose={() => setAction(null)}
        >
          <p className="modal-intro">恢复到原位置；已有同名目录时不会覆盖。</p>
          {mutationError && (
            <p className="form-error" role="alert">
              {mutationError}
            </p>
          )}
          {trashLoading ? (
            <p className="skills-empty" role="status">
              正在读取回收区…
            </p>
          ) : trash.length === 0 ? (
            <p className="skills-empty">回收区为空</p>
          ) : (
            <div className="skill-trash-list">
              {trash.map((entry) => (
                <article key={entry.id}>
                  <div>
                    <strong>{entry.name}</strong>
                    <small>{entry.originalDirectory}</small>
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <button
                    className="button"
                    disabled={mutationBusy}
                    onClick={() => void restore(entry)}
                  >
                    恢复
                  </button>
                </article>
              ))}
            </div>
          )}
        </SkillDialog>
      )}
    </section>
  );
}
