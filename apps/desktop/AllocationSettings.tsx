import { useI18n } from "./i18n.js";
import React, { useEffect, useRef, useState } from "react";
import type {
  AgentConnection,
  AllocationSettings as Preferences,
} from "../../packages/contracts/index.js";
import { assignable } from "./AllocationControls.js";

interface Props {
  active: boolean;
  agents: AgentConnection[];
  preferences?: Preferences;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  pickDirectory: () => Promise<string | null>;
}
function PriorityList({
  label,
  order,
  agents,
  disabled,
  onChange,
}: {
  label: string;
  order: string[];
  agents: AgentConnection[];
  disabled: boolean;
  onChange: (order: string[]) => void;
}) {
  const { t } = useI18n();
  function move(index: number, step: number) {
    const next = [...order];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    onChange(next);
  }
  if (!order.length)
    return (
      <p className="field-help">{t("接入可用的 Agent 后，即可设置优先级。")}</p>
    );
  return (
    <ol className="allocation-ranking" aria-label={label}>
      {order.map((id, index) => {
        const agent = agents.find((item) => item.id === id);
        const name = agent?.name || id;
        return (
          <li key={id}>
            <span className="allocation-position" aria-hidden="true">
              {index + 1}
            </span>
            <span className="allocation-name">{name}</span>
            {(!agent || !assignable(agent)) && <small>{t("当前不可用")}</small>}
            <button
              className="button ghost"
              type="button"
              aria-label={t("上移 {name}", { name })}
              title={t("上移")}
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
            >
              ↑
            </button>
            <button
              className="button ghost"
              type="button"
              aria-label={t("下移 {name}", { name })}
              title={t("下移")}
              disabled={disabled || index === order.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export default function AllocationSettings(props: Props) {
  const { t } = useI18n();
  const [preferences, setPreferences] = useState<Preferences>(
    props.preferences || { globalAgentId: null, projectAgentIds: {} },
  );
  const [globalDraft, setGlobalDraft] = useState<string[] | null>(null);
  const [projectDraft, setProjectDraft] = useState<string[] | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    setReady(false);
    if (!props.active) return;
    let live = true;
    setError("");
    setSaved("");
    current.current
      .request("GET", "/api/allocation")
      .then((value) => {
        if (!live) return;
        setPreferences(value as Preferences);
        setGlobalDraft(null);
        setProjectDraft(null);
        setReady(true);
      })
      .catch((failure) => {
        if (live)
          setError(
            failure instanceof Error
              ? failure.message
              : t("无法读取分配设置。"),
          );
      });
    return () => {
      live = false;
    };
  }, [props.active, retry]);
  const candidates = props.agents
    .filter(assignable)
    .map((agent) => agent.id)
    .sort();
  const global =
    preferences.globalAgentOrder ??
    (preferences.globalAgentId ? [preferences.globalAgentId] : []);
  const projects: Record<string, string[]> = {
    ...Object.fromEntries(
      Object.entries(preferences.projectAgentIds).map(([path, id]) => [
        path,
        [id],
      ]),
    ),
    ...preferences.projectAgentOrders,
  };
  const globalOrder = [
    ...new Set([...(globalDraft ?? global), ...candidates]),
  ].filter((id) => global.includes(id) || candidates.includes(id));
  const project = projects[projectPath] || [];
  const projectOrder = [
    ...new Set([...(projectDraft ?? project), ...global, ...candidates]),
  ].filter((id) => project.includes(id) || candidates.includes(id));
  const disabled = busy || !ready;
  function editProject(path: string) {
    setProjectPath(path);
    setProjectDraft(null);
    setSaved("");
  }
  async function save(agentIds: string[], path?: string) {
    if (disabled) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const next = (await props.request("PUT", "/api/allocation", {
        agentIds,
        ...(path ? { projectPath: path } : {}),
      })) as Preferences;
      setPreferences(next);
      if (path) {
        if (path === projectPath) setProjectDraft(null);
        setSaved(
          agentIds.length
            ? t("项目优先级已保存。")
            : t("此项目已恢复使用全局设置。"),
        );
      } else {
        setGlobalDraft(null);
        setSaved(
          agentIds.length ? t("全局优先级已保存。") : t("已恢复自动分配。"),
        );
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : t("分配设置未能保存。"),
      );
    } finally {
      setBusy(false);
    }
  }
  async function chooseProject() {
    setError("");
    try {
      const path = await props.pickDirectory();
      if (path) editProject(path);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : t("无法选择项目目录。"),
      );
    }
  }
  return (
    <>
      <div className="settings-section-heading">
        <div>
          <h2 id="settings-allocation-title">{t("任务分配")}</h2>
          <p>
            {t("自动分配从第 1 位开始，依次跳过不可用或能力不匹配的 Agent。")}
          </p>
        </div>
      </div>
      <h3>{t("全局优先级")}</h3>
      <p className="field-help">
        {global.length
          ? t("适用于未设置项目优先级的新任务，调整顺序后保存生效。")
          : t("尚未设置优先级。下方是初始顺序，保存后生效。")}
      </p>
      <PriorityList
        label={t("全局优先级")}
        order={globalOrder}
        agents={props.agents}
        disabled={disabled}
        onChange={(order) => {
          setGlobalDraft(order);
          setSaved("");
        }}
      />
      <div className="settings-form-actions">
        <button
          className="button"
          disabled={disabled || !globalOrder.length}
          onClick={() => void save(globalOrder)}
        >
          {t("保存全局优先级")}
        </button>
        {global.length > 0 && (
          <button
            className="button ghost"
            disabled={disabled}
            onClick={() => void save([])}
          >
            {t("清除全局排序")}
          </button>
        )}
      </div>
      <div className="settings-divider" />
      <h3>{t("项目优先级")}</h3>
      <p className="field-help">
        {t("项目可单独排序。未设置时沿用全局设置。")}
      </p>
      <button
        className="button allocation-directory"
        disabled={disabled}
        onClick={() => void chooseProject()}
      >
        {projectPath ? t("更换项目目录") : t("选择项目目录")}
      </button>
      {projectPath && (
        <>
          <p className="field-help allocation-path">
            {projectPath} ·{" "}
            {project.length ? t("项目专属顺序") : t("沿用全局设置")}
          </p>
          <PriorityList
            label={t("项目优先级")}
            order={projectOrder}
            agents={props.agents}
            disabled={disabled}
            onChange={(order) => {
              setProjectDraft(order);
              setSaved("");
            }}
          />
          <div className="settings-form-actions">
            <button
              className="button"
              disabled={disabled || !projectOrder.length}
              onClick={() => void save(projectOrder, projectPath)}
            >
              {t("保存项目优先级")}
            </button>
            {project.length > 0 && (
              <button
                className="button ghost"
                disabled={disabled}
                onClick={() => void save([], projectPath)}
              >
                {t("恢复全局设置")}
              </button>
            )}
          </div>
        </>
      )}
      <div className="allocation-projects">
        {Object.entries(projects)
          .filter(([path, ids]) => path !== projectPath && ids.length)
          .map(([path, ids]) => (
            <div className="allocation-project" key={path}>
              <div>
                <strong>{path}</strong>
                <p className="field-help">
                  {ids
                    .map(
                      (id) =>
                        props.agents.find((agent) => agent.id === id)?.name ||
                        id,
                    )
                    .join(" → ")}
                </p>
              </div>
              <button
                className="button ghost"
                disabled={disabled}
                aria-label={t("编辑项目优先级：{path}", { path })}
                onClick={() => editProject(path)}
              >
                {t("编辑")}
              </button>
            </div>
          ))}
      </div>
      {!ready && !error && (
        <p className="field-help" role="status">
          {t("正在读取分配设置…")}
        </p>
      )}
      {saved && (
        <p className="settings-saved" role="status">
          {saved}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}{" "}
          {!ready && (
            <button
              className="button ghost"
              onClick={() => setRetry(retry + 1)}
            >
              {t("重新读取")}
            </button>
          )}
        </p>
      )}
    </>
  );
}
