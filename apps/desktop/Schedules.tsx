import React, {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  AgentConnection,
  Schedule,
  ScheduleInput,
  ScheduleRule,
  ScheduleRun,
  Task,
} from "../../packages/contracts/index.js";
import { scheduleInputSchema } from "../../packages/contracts/schedules.js";

type Props = {
  schedules?: Schedule[];
  agents: AgentConnection[];
  tasks: Task[];
  projectPath: string;
  connected: boolean;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  pickDirectory: () => Promise<string | null>;
  onOpenTask: (id: string) => void;
  onBack: () => void;
  onMenu: () => void;
};
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const states: Record<Schedule["status"], string> = {
  active: "已启用",
  paused: "已暂停",
  finished: "已结束",
};
const runStates: Record<ScheduleRun["status"], string> = {
  dispatched: "已分配",
  missed: "已错过",
  skipped: "已跳过",
  failed: "触发失败",
  unknown: "状态待确认",
};
const taskStates: Record<Task["status"], string> = {
  queued: "等待执行",
  running: "执行中",
  waiting_input: "等你处理",
  blocked: "已阻塞",
  review: "待检查",
  completed: "已完成",
  failed: "执行失败",
  stopping: "正在停止",
  cancelled: "已停止",
  unknown: "状态待确认",
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试。";
const localZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
export function scheduleRuleLabel(rule: ScheduleRule): string {
  if (rule.kind === "once") return "单次 · " + dateLabel(rule.at);
  if (rule.kind === "interval") return `每 ${rule.minutes} 分钟`;
  const prefix =
    rule.kind === "daily"
      ? "每天"
      : [...rule.days]
          .sort((a, b) => a - b)
          .map((day) => weekdays[day])
          .join("、");
  return `${prefix} ${rule.time} · ${rule.timeZone}`;
}
function dateLabel(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "—";
}
function localDateInput(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function Clock() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function Dialog({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="schedule-dialog"
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
function ScheduleEditor({
  record,
  agents,
  projectPath,
  pickDirectory,
  save,
  onClose,
}: {
  record: Schedule | null;
  agents: AgentConnection[];
  projectPath: string;
  pickDirectory: Props["pickDirectory"];
  save: (input: ScheduleInput) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(record?.name || "");
  const [prompt, setPrompt] = useState(record?.prompt || "");
  const [cwd, setCwd] = useState(record?.cwd || projectPath);
  const [agentId, setAgentId] = useState(
    record?.agentId || agents[0]?.id || "",
  );
  const [kind, setKind] = useState<ScheduleRule["kind"]>(
    record?.rule.kind || "daily",
  );
  const [at, setAt] = useState(() =>
    localDateInput(
      record?.rule.kind === "once"
        ? record.rule.at
        : new Date(Date.now() + 3600000).toISOString(),
    ),
  );
  const [minutes, setMinutes] = useState(
    record?.rule.kind === "interval" ? String(record.rule.minutes) : "60",
  );
  const [time, setTime] = useState(
    record?.rule.kind === "daily" || record?.rule.kind === "weekly"
      ? record.rule.time
      : "09:00",
  );
  const [timeZone, setTimeZone] = useState(
    record?.rule.kind === "daily" || record?.rule.kind === "weekly"
      ? record.rule.timeZone
      : localZone(),
  );
  const [days, setDays] = useState<number[]>(
    record?.rule.kind === "weekly" ? record.rule.days : [1],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function chooseDirectory() {
    setBusy(true);
    setError("");
    try {
      const path = await pickDirectory();
      if (path) setCwd(path);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    let rule: ScheduleRule;
    if (kind === "once") {
      const date = new Date(at);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
        setError("请选择将来的执行时间。");
        return;
      }
      rule = { kind, at: date.toISOString() };
    } else if (kind === "interval") rule = { kind, minutes: Number(minutes) };
    else if (kind === "daily") rule = { kind, time, timeZone: timeZone.trim() };
    else
      rule = {
        kind,
        time,
        timeZone: timeZone.trim(),
        days: [...days].sort((a, b) => a - b),
      };
    const parsed = scheduleInputSchema.safeParse({
      name,
      prompt,
      cwd,
      agentId,
      rule,
    });
    if (!parsed.success) {
      setError(
        "请完整填写名称、执行内容、Agent 和目录，并检查时间、时区与星期。间隔须为 1–525600 分钟的整数。",
      );
      return;
    }
    setBusy(true);
    try {
      await save(parsed.data);
      onClose();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={record ? "编辑定时任务" : "新建定时任务"}
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy} className="schedule-form-fields">
          <label className="setting-field">
            <span>名称</span>
            <input
              autoFocus
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：每日项目进展"
            />
          </label>
          <label className="setting-field">
            <span>每次执行的内容</span>
            <textarea
              required
              rows={4}
              maxLength={20000}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="明确每次要完成的工作、范围和交付结果"
            />
          </label>
          {!agents.length && (
            <p className="form-error">
              请先在“连接”中接入一个可用的执行 Agent。
            </p>
          )}
          <div className="schedule-form-grid">
            <label className="setting-field">
              <span>执行 Agent</span>
              <select
                required
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
              >
                <option value="" disabled>
                  选择已接入的 Agent
                </option>
                {record &&
                  !agents.some((agent) => agent.id === record.agentId) && (
                    <option value={record.agentId} disabled>
                      原 Agent 当前不可用
                    </option>
                  )}
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="setting-field">
              <span>执行频率</span>
              <select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as ScheduleRule["kind"])
                }
              >
                <option value="once">仅执行一次</option>
                <option value="interval">固定间隔</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
              </select>
            </label>
          </div>
          <label className="setting-field">
            <span>工作目录</span>
            <div className="schedule-directory">
              <input
                required
                readOnly
                value={cwd}
                placeholder="选择本机工作目录"
                title={cwd}
              />
              <button
                type="button"
                className="button"
                onClick={() => void chooseDirectory()}
              >
                选择目录
              </button>
            </div>
          </label>
          {kind === "once" ? (
            <label className="setting-field">
              <span>执行时间 · {localZone()}</span>
              <input
                required
                type="datetime-local"
                value={at}
                onChange={(event) => setAt(event.target.value)}
              />
              <small className="field-help">
                按本机当前时区选择，保存为固定时间。
              </small>
            </label>
          ) : kind === "interval" ? (
            <label className="setting-field">
              <span>每隔多少分钟</span>
              <input
                type="number"
                min={1}
                max={525600}
                step={1}
                required
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
              <small className="field-help">
                首次执行在保存后一个间隔，后续按此节奏运行。
              </small>
            </label>
          ) : (
            <div className="schedule-form-grid">
              <label className="setting-field">
                <span>执行时刻</span>
                <input
                  required
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </label>
              <label className="setting-field">
                <span>时区</span>
                <input
                  required
                  value={timeZone}
                  onChange={(event) => setTimeZone(event.target.value)}
                  placeholder="Asia/Shanghai"
                />
              </label>
            </div>
          )}
          {kind === "weekly" && (
            <fieldset className="schedule-weekdays">
              <legend>执行日期</legend>
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    checked={days.includes(day)}
                    onChange={(event) =>
                      setDays(
                        event.target.checked
                          ? [...days, day]
                          : days.filter((item) => item !== day),
                      )
                    }
                  />
                  {weekdays[day]}
                </label>
              ))}
            </fieldset>
          )}
        </fieldset>
        <p className="schedule-form-note">
          后台运行且电脑在线时执行。离线错过不补跑；上一轮未结束时跳过本轮。
          {record ? "修改只影响后续触发。" : "保存后即启用。"}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button className="button primary" disabled={busy || !agents.length}>
            {busy ? "保存中…" : record ? "保存修改" : "创建并启用"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export default function Schedules(props: Props) {
  const api = useRef(props);
  api.current = props;
  const [loaded, setLoaded] = useState<Schedule[]>(props.schedules || []),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<Schedule | "new" | null>(null),
    [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const [runs, setRuns] = useState<ScheduleRun[]>([]),
    [runsLoading, setRunsLoading] = useState(false),
    [runsError, setRunsError] = useState("");
  const live = useRef(true),
    loadVersion = useRef(0),
    runsVersion = useRef(0);
  const schedules = loaded;
  const record = schedules.find((item) => item.id === selected);
  const available = props.agents.filter(
    (agent) => agent.selected && agent.available && agent.supported !== false,
  );
  async function load() {
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadError("");
    try {
      const values = (await api.current.request(
        "GET",
        "/api/schedules",
      )) as Schedule[];
      if (live.current && version === loadVersion.current) setLoaded(values);
    } catch (failure) {
      if (live.current && version === loadVersion.current)
        setLoadError(message(failure));
    } finally {
      if (live.current && version === loadVersion.current) setLoading(false);
    }
  }
  async function loadRuns(id: string) {
    const version = ++runsVersion.current;
    setRunsLoading(true);
    setRunsError("");
    setRuns([]);
    try {
      const values = (await api.current.request(
        "GET",
        `/api/schedules/${encodeURIComponent(id)}/runs`,
      )) as ScheduleRun[];
      if (live.current && version === runsVersion.current) setRuns(values);
    } catch (failure) {
      if (live.current && version === runsVersion.current)
        setRunsError(message(failure));
    } finally {
      if (live.current && version === runsVersion.current)
        setRunsLoading(false);
    }
  }
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
      ++loadVersion.current;
      ++runsVersion.current;
    };
  }, []);
  useEffect(() => {
    if (props.schedules) {
      setLoaded(props.schedules);
      setLoading(false);
      setLoadError("");
    }
  }, [props.schedules]);
  useEffect(() => {
    if (selected && record) void loadRuns(selected);
    else {
      ++runsVersion.current;
      setRuns([]);
      setRunsError("");
      setRunsLoading(false);
    }
  }, [selected, record?.lastRun?.id, record?.lastRun?.status]);
  async function control(
    item: Schedule,
    operation: "pause" | "resume" | "delete",
  ) {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await api.current.request(
        "POST",
        `/api/schedules/${encodeURIComponent(item.id)}/${operation}`,
        {},
      );
      if (!live.current) return;
      if (operation === "delete") {
        setDeleting(null);
        if (selected === item.id) setSelected(null);
      }
      await load();
    } catch (failure) {
      if (live.current) setActionError(message(failure));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="schedules-page" aria-label="定时任务管理">
      <header className="topbar">
        <div className="row">
          <button
            className="icon mobile-toggle"
            aria-label="打开任务侧栏"
            onClick={props.onMenu}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <button
            className="icon"
            aria-label="返回总控对话"
            onClick={props.onBack}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m14 5-7 7 7 7" />
            </svg>
          </button>
          <h1>定时任务</h1>
          <span className="small">{schedules.length}</span>
        </div>
        <button
          className="button primary"
          disabled={!props.connected || Boolean(loadError) || loading}
          onClick={() => {
            setEditor("new");
            setActionError("");
          }}
        >
          新建定时任务
        </button>
      </header>
      <div className="schedule-context">
        <Clock />
        <p>让已接入的 Agent 按时间执行。电脑需保持在线，ACD 后台需保持运行。</p>
      </div>
      {!props.connected && (
        <p className="schedule-alert" role="status">
          本地后台未连接，连接恢复后才能管理定时任务。
        </p>
      )}
      {loadError && (
        <div className="schedule-alert" role="alert">
          <span>{loadError}</span>
          <button
            className="button"
            onClick={() => void load()}
            disabled={loading || !props.connected}
          >
            重新加载
          </button>
        </div>
      )}
      {actionError && !deleting && (
        <p className="schedule-alert" role="alert">
          {actionError}
        </p>
      )}
      <div className="schedule-layout">
        <div className="schedule-list" aria-label="定时任务列表">
          {loading && !schedules.length ? (
            <p className="schedule-empty" role="status">
              正在加载定时任务…
            </p>
          ) : !schedules.length && !loadError ? (
            <div className="schedule-empty">
              <Clock />
              <h2>把重复的工作交给时间</h2>
              <p>
                例如每天整理项目进展，或每周检查文档。创建后，每次触发都会生成独立任务。
              </p>
              <button
                className="button"
                disabled={!props.connected}
                onClick={() => setEditor("new")}
              >
                创建第一个定时任务
              </button>
            </div>
          ) : (
            schedules.map((item) => (
              <button
                key={item.id}
                className={
                  "schedule-row " + (selected === item.id ? "selected" : "")
                }
                aria-pressed={selected === item.id}
                onClick={() => {
                  setSelected(item.id);
                  setActionError("");
                }}
              >
                <span className="row between">
                  <strong>{item.name}</strong>
                  <span className={"schedule-state " + item.status}>
                    {states[item.status]}
                  </span>
                </span>
                <span className="schedule-rule">
                  {scheduleRuleLabel(item.rule)}
                </span>
                <span className="schedule-next">
                  <span>
                    {item.status === "paused"
                      ? "已暂停"
                      : item.status === "finished"
                        ? "执行计划已结束"
                        : "下次执行"}
                  </span>
                  {item.status === "active" && (
                    <time dateTime={item.nextRunAt || undefined}>
                      {dateLabel(item.nextRunAt)}
                    </time>
                  )}
                </span>
                {item.lastRun && (
                  <span className="schedule-last">
                    最近触发 · {runStates[item.lastRun.status]}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
        <section className="schedule-inspector" aria-label="定时任务详情">
          {record ? (
            <>
              <div className="schedule-detail-heading">
                <div>
                  <span className="small">执行计划</span>
                  <h2>{record.name}</h2>
                </div>
                <div className="schedule-detail-actions">
                  <button
                    className="button"
                    disabled={busy || !props.connected}
                    onClick={() => setEditor(record)}
                  >
                    编辑
                  </button>
                  {record.status !== "finished" && (
                    <button
                      className="button"
                      disabled={busy || !props.connected}
                      onClick={() =>
                        void control(
                          record,
                          record.status === "active" ? "pause" : "resume",
                        )
                      }
                    >
                      {record.status === "active" ? "暂停" : "恢复"}
                    </button>
                  )}
                  <button
                    className="button ghost"
                    disabled={busy || !props.connected}
                    onClick={() => {
                      setDeleting(record);
                      setActionError("");
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
              <dl className="schedule-facts">
                <div>
                  <dt>规则</dt>
                  <dd>{scheduleRuleLabel(record.rule)}</dd>
                </div>
                <div>
                  <dt>下次执行</dt>
                  <dd>
                    {record.status === "active"
                      ? dateLabel(record.nextRunAt)
                      : states[record.status]}
                  </dd>
                </div>
                <div>
                  <dt>执行 Agent</dt>
                  <dd>
                    {props.agents.find((agent) => agent.id === record.agentId)
                      ?.name || "原 Agent 已移除"}
                  </dd>
                </div>
                <div>
                  <dt>工作目录</dt>
                  <dd className="mono">{record.cwd}</dd>
                </div>
              </dl>
              <div className="schedule-prompt">
                <h3>每次执行的内容</h3>
                <p>{record.prompt}</p>
              </div>
              <div className="schedule-history-heading">
                <h3>最近触发</h3>
                <button
                  className="button ghost"
                  disabled={runsLoading || !props.connected}
                  onClick={() => void loadRuns(record.id)}
                >
                  {runsLoading ? "加载中…" : "刷新记录"}
                </button>
              </div>
              <p className="small">
                显示最近 30 次触发。已分配表示任务已创建，实际结果请查看任务。
              </p>
              {runsError && (
                <p className="form-error" role="alert">
                  {runsError}
                </p>
              )}
              {!runs.length && !runsLoading && !runsError && (
                <p className="schedule-history-empty">
                  尚未触发，将在计划时间生成任务。
                </p>
              )}
              <ol className="schedule-runs">
                {runs.map((run) => {
                  const task = props.tasks.find(
                    (item) => item.id === run.taskId,
                  );
                  return (
                    <li key={run.id}>
                      <div className="row between">
                        <span className={"schedule-run-state " + run.status}>
                          {runStates[run.status]}
                        </span>
                        <time dateTime={run.scheduledFor}>
                          {dateLabel(run.scheduledFor)}
                        </time>
                      </div>
                      <p>{run.detail}</p>
                      {run.taskId && (
                        <button
                          className="button ghost"
                          disabled={!task}
                          onClick={() => props.onOpenTask(run.taskId!)}
                        >
                          查看任务
                          {task
                            ? ` · ${taskStates[task.status]}`
                            : " · 暂不可见"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
              <p className="schedule-detail-note">
                错过的触发不补跑；上一轮仍在执行、等待输入或状态待确认时，跳过本轮。暂停或删除计划不会停止已创建的任务。
              </p>
            </>
          ) : (
            <div className="schedule-detail-empty">
              <Clock />
              <h2>按你的节奏运行</h2>
              <p>选择一个定时任务，查看下次执行时间、执行内容和触发记录。</p>
            </div>
          )}
        </section>
      </div>
      {editor && (
        <ScheduleEditor
          key={editor === "new" ? "new" : editor.id}
          record={editor === "new" ? null : editor}
          agents={available}
          projectPath={props.projectPath}
          pickDirectory={props.pickDirectory}
          onClose={() => setEditor(null)}
          save={async (input) => {
            const value = (await props.request(
              editor === "new" ? "POST" : "PUT",
              editor === "new"
                ? "/api/schedules"
                : `/api/schedules/${encodeURIComponent(editor.id)}`,
              input,
            )) as Schedule;
            setSelected(value.id);
            await load();
          }}
        />
      )}
      {deleting && (
        <Dialog
          title="删除定时任务"
          busy={busy}
          onClose={() => {
            setDeleting(null);
            setActionError("");
          }}
        >
          <p>
            删除“{deleting.name}
            ”后将不再触发后续执行。已经创建的任务会继续保留和执行。
          </p>
          {actionError && (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          )}
          <div className="modal-footer">
            <button
              className="button"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy || !props.connected}
              onClick={() => void control(deleting, "delete")}
            >
              {busy ? "删除中…" : "删除计划"}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
