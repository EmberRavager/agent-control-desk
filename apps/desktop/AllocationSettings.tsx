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
export default function AllocationSettings(props: Props) {
  const [preferences, setPreferences] = useState<Preferences>(
    props.preferences || { globalAgentId: null, projectAgentIds: {} },
  );
  const [globalAgentId, setGlobalAgentId] = useState(
    props.preferences?.globalAgentId || "",
  );
  const [projectPath, setProjectPath] = useState("");
  const [projectAgentId, setProjectAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    if (!props.active) return;
    let live = true;
    setLoading(true);
    current.current
      .request("GET", "/api/allocation")
      .then((value) => {
        if (!live) return;
        const next = value as Preferences;
        setPreferences(next);
        setGlobalAgentId(next.globalAgentId || "");
        setError("");
      })
      .catch((failure) => {
        if (live)
          setError(
            failure instanceof Error ? failure.message : "无法读取分配设置。",
          );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [props.active]);
  const candidates = props.agents.filter(assignable);
  const name = (id: string) =>
    props.agents.find((agent) => agent.id === id)?.name || id;
  const options = (selectedId: string) => (
    <>
      <option value="">不设默认</option>
      {selectedId && !candidates.some((agent) => agent.id === selectedId) && (
        <option value={selectedId}>{name(selectedId)} · 已不可用</option>
      )}
      {candidates.map((agent) => (
        <option value={agent.id} key={agent.id}>
          {agent.name}
        </option>
      ))}
    </>
  );
  async function save(agentId: string, path?: string) {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const next = (await props.request("PUT", "/api/allocation", {
        agentId: agentId || null,
        ...(path ? { projectPath: path } : {}),
      })) as Preferences;
      setPreferences(next);
      setGlobalAgentId(next.globalAgentId || "");
      setSaved(path ? "项目默认已更新。" : "全局默认已更新。");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "分配设置未能保存。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function chooseProject() {
    setError("");
    try {
      const path = await props.pickDirectory();
      if (path) {
        setProjectPath(path);
        setProjectAgentId(preferences.projectAgentIds[path] || "");
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "无法选择项目目录。",
      );
    }
  }
  return (
    <>
      <div className="settings-section-heading">
        <div>
          <h2 id="settings-allocation-title">任务分配</h2>
          <p>为新任务设置默认执行者，也可以在发送时临时指定。</p>
        </div>
      </div>
      <label className="setting-field">
        <span>全局默认 Agent</span>
        <select
          value={globalAgentId}
          disabled={busy || loading}
          onChange={(event) => {
            setGlobalAgentId(event.target.value);
            setSaved("");
          }}
        >
          {options(globalAgentId)}
        </select>
      </label>
      <p className="field-help">
        项目未设置默认时使用。默认执行者不可用或不满足必需能力时，自动分配会继续选择其他合格候选。
      </p>
      <div className="settings-form-actions">
        <button
          className="button"
          disabled={busy || loading}
          onClick={() => void save(globalAgentId)}
        >
          保存全局默认
        </button>
      </div>
      <div className="settings-divider" />
      <h3>项目默认 Agent</h3>
      <p className="field-help">按工作目录设置，已有任务继续使用原执行者。</p>
      <button
        className="button"
        disabled={busy || loading}
        onClick={() => void chooseProject()}
      >
        {projectPath || "选择项目目录"}
      </button>
      {projectPath && (
        <>
          <label className="setting-field">
            <span>项目默认 Agent</span>
            <select
              value={projectAgentId}
              disabled={busy || loading}
              onChange={(event) => {
                setProjectAgentId(event.target.value);
                setSaved("");
              }}
            >
              {options(projectAgentId)}
            </select>
          </label>
          <div className="settings-form-actions">
            <button
              className="button"
              disabled={busy || loading}
              onClick={() => void save(projectAgentId, projectPath)}
            >
              保存项目默认
            </button>
          </div>
        </>
      )}
      <div className="allocation-projects">
        {Object.entries(preferences.projectAgentIds).map(([path, agentId]) => (
          <div className="allocation-project" key={path}>
            <div>
              <strong>
                {name(agentId)}
                {!candidates.some((agent) => agent.id === agentId)
                  ? " · 已不可用"
                  : ""}
              </strong>
              <p className="field-help">{path}</p>
            </div>
            <button
              className="button ghost"
              disabled={busy || loading}
              aria-label={"清除项目默认：" + path}
              onClick={() => void save("", path)}
            >
              清除
            </button>
          </div>
        ))}
      </div>
      <p className="field-help">
        本次明确指定的 Agent 不可用时，会说明原因并保留消息，不会自动改派。
      </p>
      {loading && (
        <p className="field-help" role="status">
          正在读取分配设置…
        </p>
      )}
      {saved && (
        <p className="field-help" role="status">
          {saved}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
