import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  Snapshot,
  Message,
  Task,
  Question,
  AgentConnection,
  AgentCapability,
  RoutingReceipt,
  NativeSession,
  NativeInsight,
  CompletionReport as Report,
} from "../../packages/contracts/index.js";
import type { ModelCatalog } from "../../packages/contracts/providers.js";
import "./style.css";
import Notifications from "./Notifications.js";
import CompletionReport from "./CompletionReport.js";
import {
  conversationMessages,
  latestNativeReports,
} from "../../packages/contracts/completion.js";
import { ComposerDrafts, type PendingSend } from "./composer-drafts.js";
import type {
  Notice,
  DesktopNoticeStatus,
} from "../../packages/contracts/notifications.js";
import Skills from "./Skills.js";
import Schedules from "./Schedules.js";
import NativeObservation, { nativeLabels } from "./NativeObservation.js";
import type { NativeInsightCache } from "./native-insight-cache.js";
import Settings, { type LocalInfo } from "./Settings.js";
import {
  AllocationControls,
  AllocationReason,
  assignable,
} from "./AllocationControls.js";

type NoticeTarget = {
  id?: string;
  kind?: Notice["kind"];
  taskId?: string;
  questionId?: string;
  messageId?: string;
  inbox?: boolean;
};
type Bridge = {
  getNoticeStatus?(): Promise<DesktopNoticeStatus>;
  testNotice?(): Promise<DesktopNoticeStatus>;
  openNoticeSettings?(): Promise<void>;
  subscribeNotices?(callback: (target: NoticeTarget) => void): () => void;
  getLocalInfo(): Promise<LocalInfo>;
  openDataDirectory(): Promise<void>;
  revealSkill(id: string): Promise<void>;
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  pickDirectory(): Promise<string | null>;
  pickExecutable(): Promise<string | null>;
  subscribe(
    state: (value: Snapshot) => void,
    connected: (value: boolean) => void,
    error: (value: string) => void,
  ): () => void;
};
declare global {
  interface Window {
    acd?: Bridge;
  }
}
const labels: Record<Task["status"], string> = {
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
type OnboardingAgent = AgentConnection & {
  supported?: boolean;
  verification?:
    "discovered" | "checking" | "verified" | "failed" | "unsupported";
  verificationMessage?: string;
};
function agentStatus(a: OnboardingAgent) {
  if (a.supported === false || a.verification === "unsupported")
    return "已安装 · 暂不支持接入";
  if (a.verification === "checking") return "正在检查";
  if (a.verification === "failed") return "启动检查失败";
  if (a.verification === "verified") return "程序可启动";
  return a.available ? "已安装 · 等待检查" : "暂不可用";
}
const routingActions: Record<RoutingReceipt["actions"][number], string> = {
  create: "新任务",
  schedule_create: "创建定时任务",
  schedule_control: "管理定时任务",
  schedule_status: "查询定时任务",
  supplement: "补充",
  status: "查进度",
  stop: "停止",
  clarify: "待澄清",
};
function routingLabel(receipt: RoutingReceipt): string {
  switch (receipt.status) {
    case "pending":
      return "总控理解中…";
    case "failed":
      return "理解失败";
    case "interrupted":
      return "理解已中断";
    case "completed":
      return receipt.actions.length
        ? "已识别：" +
            receipt.actions.map((action) => routingActions[action]).join("、")
        : "直接对话";
  }
}
function conversationChanged(
  previous: Snapshot | null,
  next: Snapshot,
): boolean {
  return (
    !previous ||
    previous.messages.length !== next.messages.length ||
    next.messages.some((message, index) => {
      const before = previous.messages[index];
      return message.id !== before?.id || message.text !== before.text;
    }) ||
    previous.tasks.length !== next.tasks.length ||
    next.tasks.some((task, index) => {
      const before = previous.tasks[index];
      return (
        task.id !== before?.id ||
        task.status !== before.status ||
        task.progress !== before.progress ||
        task.result !== before.result
      );
    }) ||
    previous.questions.length !== next.questions.length ||
    next.questions.some((question, index) => {
      const before = previous.questions[index];
      return (
        question.id !== before?.id || question.resolved !== before.resolved
      );
    })
  );
}
function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePreference(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
const needsAttention = (t: Task) =>
  ["waiting_input", "blocked", "unknown", "review", "failed"].includes(
    t.status,
  );
const ended = (t: Task) => ["completed", "cancelled"].includes(t.status);
function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    bell: (
      <>
        <path d="M6 9a6 6 0 0 1 12 0v6l2 3H4l2-3Z" />
        <path d="M10 21h4" />
      </>
    ),
    skill: (
      <>
        <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" />
        <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
      </>
    ),
    branch: (
      <>
        <path d="M3 12h5a4 4 0 0 0 4-4V5h7M8 12a4 4 0 0 1 4 4v3h7" />
        <circle cx="20" cy="5" r="1" />
        <circle cx="20" cy="19" r="1" />
      </>
    ),
    chat: (
      <>
        <path d="M20 11a8 8 0 0 1-8 8H4l1.5-4A8 8 0 1 1 20 11Z" />
        <path d="M8 10h8m-8 3h5" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16M8 4v6m8 4v6" />
      </>
    ),
    folder: <path d="M3 7V5h6l2 2h10v12H3Z" />,
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-5 2 2-14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    moon: <path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    reply: <path d="m9 6-5 5 5 5m-5-5h10a5 5 0 0 1 5 5v2" />,
    link: (
      <>
        <path d="m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name] || paths.code}
    </svg>
  );
}
function Modal({
  title,
  onClose,
  children,
  dismissible = true,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  dismissible?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className={className}
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon"
          disabled={!dismissible}
          onClick={onClose}
          aria-label="关闭"
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
type SendReceipt = PendingSend & { error?: string };
function App({ drafts }: { drafts: ComposerDrafts }) {
  const [initialDraft] = useState(() => drafts.read());
  const restoredQuestionId = useRef(initialDraft.composer.questionId);
  const restoredContext = useRef(false);
  const [view, setView] = useState<
    "chat" | "skills" | "schedules" | "settings" | "notifications" | "native"
  >("chat");
  const [nativeDetail, setNativeDetail] = useState<{
    agentId: string;
    sessionId?: string;
  } | null>(null);
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [settingsReturn, setSettingsReturn] = useState<
    "chat" | "skills" | "schedules" | "notifications" | "native"
  >("chat");
  const [state, setState] = useState<Snapshot | null>(null),
    [error, setError] = useState(drafts.warning),
    [connectionError, setConnectionError] = useState(""),
    [connected, setConnected] = useState(false);
  const [text, setText] = useState(initialDraft.composer.text),
    [cwd, setCwd] = useState(
      () => initialDraft.composer.cwd || readPreference("acd.cwd") || "",
    ),
    [target, setTarget] = useState<string | null>(
      initialDraft.composer.targetTaskId || null,
    ),
    [answer, setAnswer] = useState<Question | null>(null);
  const [targetAgentId, setTargetAgentId] = useState(
    initialDraft.composer.targetAgentId || "",
  );
  const [requiredCapabilities, setRequiredCapabilities] = useState<
    AgentCapability[]
  >(initialDraft.composer.requiredCapabilities || []);
  const [modal, setModal] = useState<"agents" | "search" | null>(null),
    [archivedReport, setArchivedReport] = useState<
      Report | { unavailable: string } | null
    >(null),
    [detail, setDetail] = useState<string | null>(null),
    [menu, setMenu] = useState(false),
    [scanBusy, setScanBusy] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [connectBusy, setConnectBusy] = useState(false),
    [reportComplete, setReportComplete] = useState(false),
    [agentError, setAgentError] = useState(""),
    [theme, setTheme] = useState<"light" | "dark">(() =>
      readPreference("acd.theme") === "dark" ? "dark" : "light",
    );
  const [query, setQuery] = useState(""),
    [unread, setUnread] = useState(false),
    [pending, setPending] = useState<string[]>([]),
    [failedSends, setFailedSends] = useState<SendReceipt[]>(() =>
      initialDraft.pending.map((receipt) => ({
        ...receipt,
        error: "上次发送尚未确认。重试会复用原消息编号，不会自动发送。",
      })),
    ),
    [pendingAnswers, setPendingAnswers] = useState<string[]>([]),
    [pendingRoutingRetries, setPendingRoutingRetries] = useState<string[]>([]),
    [recoveryConfirmed, setRecoveryConfirmed] = useState<string | null>(null);
  const nativeInsightCache = useRef<NativeInsightCache>(new Map());
  const scroll = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    stick = useRef(true),
    snapshotRef = useRef<Snapshot | null>(null),
    onboardingStarted = useRef(false),
    answersInFlight = useRef(new Set<string>()),
    sendsInFlight = useRef(new Set<string>()),
    routingRetriesInFlight = useRef(new Set<string>());
  const refresh = async () => {
    if (!window.acd) return;
    const next = (await window.acd.request("GET", "/api/state")) as Snapshot;
    receive(next);
  };
  function receive(next: Snapshot) {
    if (
      JSON.stringify(snapshotRef.current?.model) !== JSON.stringify(next.model)
    )
      nativeInsightCache.current.clear();
    if (!stick.current && conversationChanged(snapshotRef.current, next))
      setUnread(true);
    try {
      drafts.acknowledge(
        new Set(
          next.messages
            .filter((message) => message.role === "user")
            .map((message) => message.id),
        ),
      );
    } catch (failure) {
      setError(
        "消息已接收，本机重试记录暂未更新。" +
          (failure instanceof Error ? failure.message : "请检查本地存储。"),
      );
    }
    snapshotRef.current = next;
    setState(next);
    setFailedSends((items) =>
      items.filter(
        (item) => !next.messages.some((message) => message.id === item.id),
      ),
    );
    if (!onboardingStarted.current) {
      onboardingStarted.current = true;
      if (!next.agents.some((a) => a.selected && a.available)) {
        setModal("agents");
        setSelected([]);
        void scan();
      }
    }
  }
  useEffect(() => {
    if (!state || restoredContext.current) return;
    restoredContext.current = true;
    if (restoredQuestionId.current) {
      const question = state.questions.find(
        (item) => item.id === restoredQuestionId.current && !item.resolved,
      );
      if (question) {
        setAnswer(question);
        setTarget(
          question.taskId || initialDraft.composer.targetTaskId || null,
        );
      } else {
        restoredQuestionId.current = undefined;
        setTarget(null);
        if (text.trim())
          setError("原问题已结束，文字草稿已保留，请确认后再发送。");
      }
    } else if (target && !state.tasks.some((task) => task.id === target)) {
      setTarget(null);
      if (text.trim())
        setError("原目标已不可用，文字草稿已保留，请重新确认目标。");
    }
  }, [state]);
  useEffect(() => {
    if (!answer || !state) return;
    if (
      !state.questions.some(
        (question) => question.id === answer.id && !question.resolved,
      )
    ) {
      restoredQuestionId.current = undefined;
      setAnswer(null);
      setTarget(null);
      if (text.trim())
        setError("原问题已处理，文字草稿已保留，请确认后再发送。");
    }
  }, [state, answer]);
  useEffect(() => {
    try {
      drafts.saveComposer({
        text,
        cwd,
        ...(target ? { targetTaskId: target } : {}),
        ...(targetAgentId ? { targetAgentId } : {}),
        ...(requiredCapabilities.length ? { requiredCapabilities } : {}),
        ...(answer?.id || restoredQuestionId.current
          ? { questionId: answer?.id || restoredQuestionId.current }
          : {}),
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "草稿暂未保存");
    }
  }, [text, cwd, target, answer, state, targetAgentId, requiredCapabilities]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  useEffect(() => {
    if (!window.acd) {
      setError(
        "请在 ACD 桌面客户端打开此界面。浏览器预览没有本地服务访问权限。",
      );
      return;
    }
    const off = window.acd.subscribe(
      receive,
      (value) => {
        setConnected(value);
        if (value) setConnectionError("");
      },
      setConnectionError,
    );
    refresh().catch((e) => setConnectionError(String(e.message || e)));
    const offNotices = window.acd.subscribeNotices?.(
      (target) => void openNotice(target),
    );
    return () => {
      off();
      offNotices?.();
    };
  }, []);
  useLayoutEffect(() => {
    if (view === "chat" && stick.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [view, state, pending, failedSends]);
  useEffect(() => {
    const element = scroll.current;
    if (view !== "chat" || !element || typeof ResizeObserver === "undefined")
      return;
    const observer = new ResizeObserver(() => {
      if (stick.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [view]);
  function showChat() {
    stick.current = true;
    setUnread(false);
    setView("chat");
  }
  async function perform(method: string, path: string, body?: unknown) {
    if (!window.acd) {
      setError("桌面连接不可用");
      return false;
    }
    try {
      await window.acd.request(method, path, body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return false;
    }
    try {
      await refresh();
      setError("");
    } catch {
      setError("操作已提交，暂时无法刷新进展。请等待重新连接，无需重复提交。");
    }
    return true;
  }
  async function answerQuestion(q: Question, choice: string) {
    if (answersInFlight.current.has(q.id)) return false;
    answersInFlight.current.add(q.id);
    setPendingAnswers((items) => [...items, q.id]);
    try {
      return await perform(
        "POST",
        `/api/questions/${encodeURIComponent(q.id)}/answer`,
        { choice },
      );
    } finally {
      answersInFlight.current.delete(q.id);
      setPendingAnswers((items) => items.filter((id) => id !== q.id));
    }
  }
  async function retryRouting(id: string) {
    if (routingRetriesInFlight.current.has(id)) return;
    routingRetriesInFlight.current.add(id);
    setPendingRoutingRetries((items) => [...items, id]);
    try {
      await perform("POST", `/api/messages/${id}/retry`, {});
    } finally {
      routingRetriesInFlight.current.delete(id);
      setPendingRoutingRetries((items) => items.filter((item) => item !== id));
    }
  }
  async function transmit(receipt: SendReceipt) {
    if (sendsInFlight.current.has(receipt.id)) return;
    sendsInFlight.current.add(receipt.id);
    setPending((items) => [...items, receipt.id]);
    try {
      if (!window.acd) throw Error("桌面连接不可用");
      drafts.stageSend({
        id: receipt.id,
        text: receipt.text,
        cwd: receipt.cwd,
        ...(receipt.targetTaskId ? { targetTaskId: receipt.targetTaskId } : {}),
        ...(receipt.targetAgentId
          ? { targetAgentId: receipt.targetAgentId }
          : {}),
        ...(receipt.requiredCapabilities?.length
          ? { requiredCapabilities: receipt.requiredCapabilities }
          : {}),
      });
      const acknowledged = (await window.acd.request("POST", "/api/messages", {
        text: receipt.text,
        cwd: receipt.cwd,
        targetTaskId: receipt.targetTaskId,
        clientMessageId: receipt.id,
        ...(receipt.targetAgentId
          ? { targetAgentId: receipt.targetAgentId }
          : {}),
        ...(receipt.requiredCapabilities?.length
          ? { requiredCapabilities: receipt.requiredCapabilities }
          : {}),
      })) as Message;
      if (
        acknowledged?.id !== receipt.id ||
        acknowledged.role !== "user" ||
        acknowledged.text !== receipt.text
      )
        throw Error(
          "收到的消息回执与发送内容不一致，请等待同步或用原编号重试。",
        );
      const current = snapshotRef.current;
      if (
        current &&
        acknowledged.id === receipt.id &&
        acknowledged.role === "user" &&
        !current.messages.some((message) => message.id === receipt.id)
      )
        receive({
          ...current,
          messages: [...current.messages, acknowledged]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .slice(-200),
        });
      try {
        drafts.acknowledge(new Set([receipt.id]));
      } catch (failure) {
        setError(
          "消息已接收，本机重试记录暂未更新。" +
            (failure instanceof Error ? failure.message : "请检查本地存储。"),
        );
      }
      setFailedSends((items) => items.filter((item) => item.id !== receipt.id));
      try {
        await refresh();
        setError("");
      } catch {
        setError(
          "消息已接收，暂时无法刷新进展。请等待重新连接，无需重新发送。",
        );
      }
    } catch (e) {
      if (
        snapshotRef.current?.messages.some(
          (message) => message.id === receipt.id,
        )
      ) {
        setFailedSends((items) =>
          items.filter((item) => item.id !== receipt.id),
        );
        setError("消息已接收，正在等待进展连接恢复。");
      } else {
        const failure = {
          ...receipt,
          error: e instanceof Error ? e.message : "暂时无法确认消息是否接收",
        };
        setFailedSends((items) => [
          ...items.filter((item) => item.id !== receipt.id),
          failure,
        ]);
      }
    } finally {
      sendsInFlight.current.delete(receipt.id);
      setPending((items) => items.filter((id) => id !== receipt.id));
    }
  }
  async function directory() {
    try {
      const value = await window.acd?.pickDirectory();
      if (value) {
        setCwd(value);
        writePreference("acd.cwd", value);
      }
    } catch (e) {
      setError(String(e));
    }
  }
  async function openNotice(notice: NoticeTarget) {
    if (notice.id)
      await perform("POST", "/api/notifications/read", { ids: [notice.id] });
    const current = snapshotRef.current;
    if (notice.taskId && current?.tasks.some((t) => t.id === notice.taskId)) {
      locate(notice.taskId);
      return;
    }
    const original = conversationMessages(current?.messages || []).find(
      (message) => message.id === notice.messageId,
    );
    if (
      notice.kind === "result" &&
      notice.messageId &&
      notice.id &&
      !original
    ) {
      setMenu(false);
      setModal(null);
      setDetail(null);
      setView("notifications");
      try {
        if (!window.acd) throw Error("桌面连接不可用");
        const report = (await window.acd.request(
          "GET",
          `/api/notifications/${notice.id}/report`,
        )) as Report;
        setArchivedReport(report);
      } catch (e) {
        setArchivedReport({
          unavailable: e instanceof Error ? e.message : "暂时无法读取报告",
        });
      }
      return;
    }
    const elementId =
      notice.questionId &&
      current?.questions.some((q) => q.id === notice.questionId)
        ? "question-" + notice.questionId
        : original
          ? "message-" + original.id
          : null;
    if (elementId) {
      stick.current = false;
      setUnread(false);
      setView("chat");
      setModal(null);
      setDetail(null);
      requestAnimationFrame(() => {
        const element = document.getElementById(elementId);
        element?.scrollIntoView({ block: "center" });
        element?.focus({ preventScroll: true });
      });
    } else {
      setView("notifications");
      setModal(null);
      setMenu(false);
    }
  }
  function locate(id: string) {
    stick.current = false;
    setUnread(false);
    setView("chat");
    setModal(null);
    setMenu(false);
    setDetail(null);
    requestAnimationFrame(() => {
      const element = document.getElementById("task-" + id);
      element?.scrollIntoView({
        block: "center",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
      element?.focus({ preventScroll: true });
    });
  }
  function clearComposerTarget() {
    restoredQuestionId.current = undefined;
    setTarget(null);
    setAnswer(null);
  }
  function supplement(id: string, q?: Question) {
    restoredQuestionId.current = q?.id;
    setTarget(id);
    setAnswer(q || null);
    setDetail(null);
    input.current?.focus();
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    if (value.length > 20000) {
      setError("消息不能超过 20,000 字符，草稿已保留。");
      return;
    }
    if (restoredQuestionId.current && !answer) {
      setError("正在恢复待处理问题，请连接后台后再发送。");
      return;
    }
    const chosen = target,
      question = answer;
    if (!question && !state?.model) {
      setError("请先配置总控模型，输入的消息已保留。");
      openModel();
      return;
    }
    let chosenCwd =
      cwd ||
      (chosen ? state?.tasks.find((task) => task.id === chosen)?.cwd : "") ||
      "";
    if (!question && !chosenCwd) {
      try {
        const directory = await window.acd?.pickDirectory();
        if (!directory) return;
        chosenCwd = directory;
        setCwd(directory);
        writePreference("acd.cwd", directory);
      } catch (e) {
        setError(e instanceof Error ? e.message : "无法选择工作文件夹");
        return;
      }
    }
    if (
      !question &&
      !chosen &&
      targetAgentId &&
      !state?.agents.some(
        (agent) => agent.id === targetAgentId && assignable(agent),
      )
    ) {
      setError("所选执行者已不可用，请重新选择；输入已保留。");
      return;
    }
    const receipt: PendingSend = {
      id: crypto.randomUUID(),
      text: value,
      cwd: chosenCwd,
      ...(chosen ? { targetTaskId: chosen } : {}),
      ...(!chosen && !question && targetAgentId ? { targetAgentId } : {}),
      ...(!chosen && !question && requiredCapabilities.length
        ? { requiredCapabilities }
        : {}),
    };
    try {
      if (question)
        drafts.saveComposer({
          text: "",
          cwd: chosenCwd,
          ...(targetAgentId ? { targetAgentId } : {}),
          ...(requiredCapabilities.length ? { requiredCapabilities } : {}),
        });
      else drafts.stageSend(receipt, true);
    } catch (failure) {
      setError(
        "本次未发送，输入已保留。" +
          (failure instanceof Error ? failure.message : "草稿暂未保存。"),
      );
      return;
    }
    setText("");
    if (!chosen && !question) {
      setTargetAgentId("");
      setRequiredCapabilities([]);
    }
    clearComposerTarget();
    stick.current = true;
    if (question) {
      const ok = await answerQuestion(question, value);
      if (!ok && !input.current?.value.trim()) {
        setText(value);
        const stillOpen = snapshotRef.current?.questions.some(
          (item) => item.id === question.id && !item.resolved,
        );
        setTarget(stillOpen ? chosen : null);
        restoredQuestionId.current = stillOpen ? question.id : undefined;
        setAnswer(stillOpen ? question : null);
      }
    } else void transmit(receipt);
  }
  async function scan() {
    if (!window.acd) return;
    setScanBusy(true);
    setReportComplete(false);
    setAgentError("");
    try {
      await window.acd.request("POST", "/api/agents/scan");
      await refresh();
      setSelected(
        snapshotRef.current?.agents
          .filter((a) => a.selected)
          .map((a) => a.id) || [],
      );
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : "扫描失败，请重试。");
    } finally {
      setScanBusy(false);
    }
  }
  async function addManual() {
    if (!window.acd) return;
    try {
      const executable = await window.acd.pickExecutable();
      if (!executable) return;
      await window.acd.request("POST", "/api/agents/manual", { executable });
      await refresh();
      setReportComplete(false);
      setAgentError("");
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : "无法添加程序");
    }
  }
  async function checkAgents() {
    if (
      !window.acd ||
      (!selected.length && !snapshotRef.current?.agents.some((a) => a.selected))
    )
      return;
    setConnectBusy(true);
    setAgentError("");
    setReportComplete(false);
    try {
      await window.acd.request("PUT", "/api/agents", { ids: selected });
      await refresh();
      setReportComplete(true);
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : "检查失败，请重试。");
      await refresh().catch(() => {});
    } finally {
      setConnectBusy(false);
    }
  }
  function chooseTheme(value: "light" | "dark") {
    setTheme(value);
    if (!writePreference("acd.theme", value))
      setError("外观已在当前窗口应用，但本机偏好暂未保存。");
  }
  function openAgents() {
    setReportComplete(false);
    setAgentError("");
    setSelected(state?.agents.filter((a) => a.selected).map((a) => a.id) || []);
    setModal("agents");
  }
  function openModel() {
    if (view !== "settings") setSettingsReturn(view);
    setSettingsOpened(true);
    setModal(null);
    setDetail(null);
    setMenu(false);
    setView("settings");
  }
  const tasks = state?.tasks || [],
    agents = (state?.agents || []) as OnboardingAgent[],
    questions = state?.questions || [],
    messages = conversationMessages(state?.messages || []);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name || id;
  const rendered = new Set<string>();
  function question(q: Question) {
    return (
      <div
        className="decision"
        key={q.id}
        id={"question-" + q.id}
        tabIndex={-1}
      >
        <div className="request-meta">
          {q.kind === "approval" ? "操作确认" : "补充信息"}
        </div>
        <p className="decision-label">{q.text}</p>
        <div className="decision-actions">
          {q.choices.length
            ? q.choices.map((choice) => (
                <button
                  className="button"
                  key={choice}
                  disabled={pendingAnswers.includes(q.id)}
                  onClick={() => void answerQuestion(q, choice)}
                >
                  {q.choiceLabels?.[choice] ||
                    (q.kind === "clarification"
                      ? tasks.find((task) => task.id === choice)?.title ||
                        choice
                      : (
                          {
                            accept: "允许这次操作",
                            decline: "拒绝",
                            cancel: "取消任务",
                          } as Record<string, string>
                        )[choice] || choice)}
                </button>
              ))
            : null}
          {(!q.choices.length ||
            q.kind === "clarification" ||
            q.kind === "input") && (
            <button
              className="button"
              onClick={() => {
                setAnswer(q);
                setTarget(q.taskId || null);
                input.current?.focus();
              }}
            >
              {q.choices.length ? "补充说明" : "回答问题"}
            </button>
          )}
        </div>
      </div>
    );
  }
  function task(t: Task) {
    const qs = questions.filter(
      (q) =>
        !q.resolved &&
        q.taskId === t.id &&
        (q.revision === undefined || q.revision === t.revision),
    );
    return (
      <article
        className={"task-card " + (qs.length ? "needs-action" : "")}
        id={"task-" + t.id}
        tabIndex={-1}
        key={t.id}
        aria-label={t.title}
      >
        <div className="task-head">
          <span className="task-id">{t.id.slice(0, 8)}</span>
          <div className="task-title">
            <h3>{t.title}</h3>
          </div>
          <span
            className={
              "pill " +
              (needsAttention(t)
                ? "waiting"
                : t.status === "running"
                  ? "running"
                  : t.status === "completed"
                    ? "done"
                    : "")
            }
          >
            {labels[t.status]}
          </span>
        </div>
        <div className="task-body">
          {qs.length ? (
            qs.map(question)
          ) : (
            <p className="task-progress">{t.progress}</p>
          )}
          {t.result && (
            <div className="task-result">
              <details>
                <summary>查看结果</summary>
                <pre>{t.result}</pre>
              </details>
            </div>
          )}
          {t.status === "review" && (
            <>
              {!t.result && (
                <p className="result-empty-note">
                  执行已结束，未返回文字结果。请检查工作目录中的产出。
                </p>
              )}
              <div className="result-actions">
                <button
                  className="button primary"
                  onClick={() =>
                    void perform(
                      "POST",
                      `/api/tasks/${encodeURIComponent(t.id)}/accept`,
                    )
                  }
                >
                  确认完成
                </button>
                <button className="button" onClick={() => supplement(t.id)}>
                  继续修改
                </button>
              </div>
            </>
          )}
        </div>
        <div className="task-tail">
          <span className="task-owner">
            <Icon name="code" />
            {agentName(t.agentId)}
          </span>
          <div className="task-actions">
            {["queued", "running", "waiting_input", "blocked"].includes(
              t.status,
            ) && (
              <button
                className="task-action"
                onClick={() =>
                  void perform(
                    "POST",
                    `/api/tasks/${encodeURIComponent(t.id)}/stop`,
                  )
                }
              >
                停止
              </button>
            )}
            <button className="task-action" onClick={() => supplement(t.id)}>
              <Icon name="reply" />
              补充
            </button>
            <button
              className="task-action detail"
              onClick={() => setDetail(t.id)}
              aria-label={"查看 " + t.title + " 详情"}
            >
              <Icon name="chevron" />
            </button>
          </div>
        </div>
      </article>
    );
  }
  const observations = state?.observations || [];
  const nativeSessions = observations.flatMap((item) => item.sessions);
  const nativeEndedReports = latestNativeReports(messages).filter(
    (message) =>
      !nativeSessions.some(
        (session) =>
          session.id === message.completion!.nativeId &&
          ["running", "waiting_input"].includes(session.status),
      ),
  );
  const nativeUnsynced =
    agents.some((agent) => agent.selected) &&
    (!observations.length ||
      observations.some((item) => item.state !== "connected"));
  function openNative(agentId: string, sessionId?: string) {
    setNativeDetail({ agentId, sessionId });
    setView("native");
    setModal(null);
    setDetail(null);
    setMenu(false);
  }
  function group(title: string, list: Task[], native: NativeSession[] = []) {
    return (
      <>
        <div className="section-label">
          <span>{title}</span>
          <span>
            {list.length +
              native.length +
              (title === "已结束" ? nativeEndedReports.slice(-12).length : 0)}
            {title === "进行中" && nativeUnsynced ? " · 外部未同步" : ""}
          </span>
        </div>
        {list.length ||
        native.length ||
        (title === "已结束" && nativeEndedReports.length > 0) ? (
          list.map((t) => (
            <button
              className={"task-link " + (needsAttention(t) ? "attention" : "")}
              key={t.id}
              onClick={() => locate(t.id)}
            >
              <span className="task-symbol">
                <span
                  className={
                    "dot " +
                    (needsAttention(t)
                      ? "amber"
                      : t.status === "running"
                        ? "blue"
                        : "")
                  }
                />
              </span>
              <span>
                <strong>{t.title}</strong>
                <small>
                  {agentName(t.agentId)} · {labels[t.status]}
                </small>
              </span>
            </button>
          ))
        ) : (
          <div className="empty-note">暂无</div>
        )}
        {native.map((session) => (
          <button
            className={
              "task-link" +
              (session.status === "waiting_input" ? " attention" : "") +
              (view === "native" && nativeDetail?.sessionId === session.id
                ? " native-selected"
                : "")
            }
            key={session.id}
            onClick={() => openNative(session.agentId, session.id)}
          >
            <span className="task-symbol">
              <span
                className={
                  "dot " + (session.status === "running" ? "blue" : "amber")
                }
              />
            </span>
            <span className="task-link-copy">
              <strong title={session.taskTitle || undefined}>
                {session.taskTitle ||
                  (state?.model ? "任务标题待识别" : "配置模型以识别任务")}
              </strong>
              <small>
                {agentName(session.agentId)} · {nativeLabels[session.status]}
              </small>
            </span>
          </button>
        ))}
        {title === "已结束" &&
          nativeEndedReports
            .slice(-12)
            .reverse()
            .map((message) => (
              <button
                className="task-link"
                key={message.id}
                onClick={() => void openNotice({ messageId: message.id })}
              >
                <span className="task-symbol">
                  <span className="dot" />
                </span>
                <span className="task-link-copy">
                  <strong title={message.completion!.title}>
                    {message.completion!.title}
                  </strong>
                  <small>
                    {message.completion!.agentName || "Agent"} ·{" "}
                    {message.completion!.assessed ? "已交付" : "本轮结束"}
                  </small>
                </span>
              </button>
            ))}
        <div className="side-divider" />
      </>
    );
  }
  const selectedNativeSession = nativeSessions.find(
    (session) => session.id === nativeDetail?.sessionId,
  );
  const selectedNativeReport = selectedNativeSession
    ? messages.find(
        (message) =>
          message.completion?.nativeId === selectedNativeSession.id &&
          message.completion?.turnId === selectedNativeSession.turnId,
      )?.completion
    : undefined;
  const focused = tasks.find((t) => t.id === detail);
  return (
    <div className={"app" + (state?.environment === "test" ? " is-test" : "")}>
      {state?.environment === "test" && (
        <div className="test-environment-banner" role="alert">
          <strong>测试环境</strong>
          <span>后台含模拟路由或执行；这里的模型选择不代表实际调用。</span>
        </div>
      )}
      <aside
        className={"sidebar " + (menu ? "open" : "")}
        aria-label="任务和连接"
      >
        <div className="brand">
          <div className="brand-icon">
            <Icon name="branch" />
          </div>
          <div className="brand-name">
            acd<span>control desk</span>
          </div>
        </div>
        <button
          className={"nav-main " + (view !== "chat" ? "nav-inactive" : "")}
          onClick={() => {
            showChat();
            setMenu(false);
            input.current?.focus();
          }}
        >
          <Icon name="chat" />
          总控对话
        </button>
        <button
          className={"skill-nav " + (view === "skills" ? "selected" : "")}
          onClick={() => {
            setView("skills");
            setMenu(false);
          }}
        >
          <Icon name="skill" />
          技能（skill）
        </button>
        <button
          className={"skill-nav " + (view === "schedules" ? "selected" : "")}
          onClick={() => {
            setView("schedules");
            setMenu(false);
          }}
        >
          <Icon name="clock" />
          定时任务
        </button>
        <div className="side-scroll">
          {group(
            "需要你处理",
            tasks.filter(needsAttention),
            nativeSessions.filter((session) =>
              ["waiting_input", "failed", "unknown"].includes(session.status),
            ),
          )}
          {group(
            "进行中",
            tasks.filter((t) => !needsAttention(t) && !ended(t)),
            nativeSessions.filter((session) => session.status === "running"),
          )}
          {group("已结束", tasks.filter(ended))}
        </div>
        <details className="agent-footer">
          <summary>
            <span className="row">
              <Icon name="link" />
              连接
            </span>
            <span className="small">
              {agents.filter((a) => a.selected).length} 个 Agent
            </span>
          </summary>
          <div className="connection-content">
            {agents
              .filter((a) => a.selected)
              .map((a) => (
                <div key={a.id}>
                  <div className="agent-line">
                    <span>{a.name}</span>
                    <span className="small">{agentStatus(a)}</span>
                  </div>
                  <button
                    className="native-observation-link"
                    onClick={() => openNative(a.id)}
                  >
                    {observations.find((item) => item.agentId === a.id)
                      ?.state === "connected"
                      ? "原生会话已同步"
                      : "原生会话未同步"}
                    <Icon name="chevron" />
                  </button>
                </div>
              ))}
            <div className="connection-actions">
              <button className="button ghost" onClick={openAgents}>
                管理 Agent
              </button>
            </div>
          </div>
        </details>
        <div className="bottom-tools">
          <span className="small">
            {state?.environment === "test" ? "隔离验收工作区" : "本地工作空间"}
          </span>
          <div className="row">
            <button
              className="icon notice-entry"
              aria-label={
                state?.notifications?.unread
                  ? `消息中心，${state.notifications.unread} 条未读`
                  : "消息中心"
              }
              onClick={() => {
                setView("notifications");
                setMenu(false);
              }}
            >
              <Icon name="bell" />
              {Boolean(state?.notifications?.unread) && (
                <span className="notice-badge" aria-hidden="true">
                  {state!.notifications!.unread > 99
                    ? "99+"
                    : state!.notifications!.unread}
                </span>
              )}
            </button>
            <button
              className="settings-entry"
              aria-current={view === "settings" ? "page" : undefined}
              onClick={openModel}
            >
              <Icon name="settings" />
              设置
            </button>
          </div>
        </div>
      </aside>
      {settingsOpened && (
        <main
          className="workspace settings-workspace"
          hidden={view !== "settings"}
        >
          <Settings
            agents={state?.agents || []}
            allocationSettings={state?.allocationSettings}
            noticePreferences={state?.notifications?.preferences}
            saveNotices={async (input) => {
              if (!window.acd) throw Error("桌面连接不可用");
              receive(
                (await window.acd.request(
                  "PUT",
                  "/api/notifications/preferences",
                  input,
                )) as Snapshot,
              );
            }}
            getNoticeStatus={async () => {
              if (!window.acd?.getNoticeStatus)
                throw Error("请重新打开桌面客户端加载提醒组件");
              return window.acd.getNoticeStatus();
            }}
            testNotice={async () => {
              if (!window.acd?.testNotice)
                throw Error("请重新打开桌面客户端加载提醒组件");
              return window.acd.testNotice();
            }}
            openNoticeSettings={async () => {
              if (!window.acd?.openNoticeSettings)
                throw Error("请手动打开系统通知设置");
              return window.acd.openNoticeSettings();
            }}
            request={async (method, path, body) => {
              if (!window.acd) throw Error("桌面连接不可用");
              return window.acd.request(method, path, body);
            }}
            pickDirectory={async () => window.acd?.pickDirectory() || null}
            active={view === "settings"}
            config={state?.model || null}
            ready={Boolean(state)}
            connected={connected}
            theme={theme}
            onTheme={chooseTheme}
            save={async (input) => {
              if (!window.acd) throw Error("桌面连接不可用");
              const next = (await window.acd.request(
                "PUT",
                "/api/model",
                input,
              )) as Snapshot;
              receive(next);
            }}
            loadModels={async (input) => {
              if (!window.acd) throw Error("桌面连接不可用");
              return (await window.acd.request(
                "POST",
                "/api/model/models",
                input,
              )) as ModelCatalog;
            }}
            getLocalInfo={async () => {
              if (!window.acd) throw Error("桌面连接不可用");
              return window.acd.getLocalInfo();
            }}
            openDataDirectory={async () => {
              if (!window.acd) throw Error("桌面连接不可用");
              await window.acd.openDataDirectory();
            }}
            onBack={() => setView(settingsReturn)}
            returnLabel={
              settingsReturn === "schedules"
                ? "定时任务"
                : settingsReturn === "skills"
                  ? "技能"
                  : settingsReturn === "notifications"
                    ? "消息中心"
                    : settingsReturn === "native"
                      ? "原生会话"
                      : "总控"
            }
            onOpenSidebar={() => setMenu((value) => !value)}
          />
        </main>
      )}
      {view === "settings" ? null : view === "native" && nativeDetail ? (
        <main className="workspace">
          <NativeObservation
            agentName={agentName(nativeDetail.agentId)}
            observation={observations.find(
              (item) => item.agentId === nativeDetail.agentId,
            )}
            sessionId={nativeDetail.sessionId}
            modelKey={JSON.stringify(state?.model || null)}
            cache={nativeInsightCache.current}
            completion={selectedNativeReport}
            retryCompletion={async () => {
              if (!selectedNativeReport || !window.acd)
                throw Error("结果报告不存在");
              await window.acd.request(
                "POST",
                `/api/reports/${selectedNativeReport.id}/retry`,
                {},
              );
              await refresh();
            }}
            onSelect={(id) => openNative(nativeDetail.agentId, id)}
            onBack={showChat}
            refresh={async () => {
              if (!window.acd) throw Error("桌面连接不可用");
              receive(
                (await window.acd.request(
                  "POST",
                  "/api/observations/refresh",
                  {},
                )) as Snapshot,
              );
            }}
            analyze={async (id, force) => {
              if (!window.acd) throw Error("桌面连接不可用");
              return (await window.acd.request(
                "POST",
                `/api/observations/${encodeURIComponent(id)}/analyze`,
                { force },
              )) as NativeInsight;
            }}
          />
        </main>
      ) : view === "notifications" ? (
        <main className="workspace">
          <Notifications
            feed={state?.notifications}
            request={async (method, path, body) => {
              if (!window.acd) throw Error("桌面连接不可用");
              const result = await window.acd.request(method, path, body);
              if (method !== "GET") await refresh();
              return result;
            }}
            onOpen={(notice) => void openNotice(notice)}
            onBack={showChat}
            onMenu={() => setMenu((v) => !v)}
          />
        </main>
      ) : view === "schedules" ? (
        <main className="workspace">
          <Schedules
            schedules={state?.schedules}
            agents={agents}
            tasks={tasks}
            connected={connected}
            projectPath={cwd}
            request={async (method, path, body) => {
              if (!window.acd) throw Error("桌面连接不可用");
              const result = await window.acd.request(method, path, body);
              if (method !== "GET") void refresh().catch(() => {});
              return result;
            }}
            pickDirectory={async () => window.acd?.pickDirectory() || null}
            onOpenTask={(id) => {
              showChat();
              setDetail(id);
            }}
            onBack={showChat}
            onMenu={() => setMenu((value) => !value)}
          />
        </main>
      ) : view === "skills" ? (
        <main className="workspace">
          <Skills
            request={async (method, path, body) => {
              if (!window.acd) throw Error("桌面连接不可用");
              return window.acd.request(method, path, body);
            }}
            pickDirectory={async () => window.acd?.pickDirectory() || null}
            revealSkill={async (id) => {
              if (!window.acd) throw Error("桌面连接不可用");
              await window.acd.revealSkill(id);
            }}
            projectPath={cwd}
            onBack={showChat}
          />
        </main>
      ) : (
        <main className="workspace">
          <header className="topbar">
            <div className="row">
              <button
                className="icon mobile-toggle"
                aria-label="打开任务侧栏"
                onClick={() => setMenu((v) => !v)}
              >
                <Icon name="menu" />
              </button>
              <h1>总控对话</h1>
            </div>
            <div className="top-actions">
              <button
                className="icon"
                aria-label="搜索任务"
                onClick={() => setModal("search")}
              >
                <Icon name="search" />
              </button>
              <button className="button ghost model-button" onClick={openModel}>
                <span className={"dot " + (!connected ? "amber" : "")} />
                {state?.model?.model || "配置总控模型"}
              </button>
            </div>
          </header>
          {(error || connectionError) && (
            <div role="alert" className="ui-error">
              <span>{error || connectionError}</span>
              <button
                className="icon"
                aria-label="关闭提示"
                onClick={() => {
                  setError("");
                  setConnectionError("");
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          {state && !connected && (
            <div role="status" className="ui-error">
              进展连接已断开，正在重连。任务状态可能尚未更新。
            </div>
          )}
          <div
            className="conversation-scroll"
            ref={scroll}
            onScroll={() => {
              const el = scroll.current;
              if (el) {
                stick.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 70;
                if (stick.current) setUnread(false);
              }
            }}
          >
            <div className="conversation">
              {!state ? (
                <p className="loading">正在连接本地服务…</p>
              ) : messages.length === 0 && tasks.length === 0 ? (
                <div className="empty-desk">
                  <Icon name="branch" />
                  <h2>从一件事开始。</h2>
                  <p>
                    {state.model &&
                    agents.some((agent) => agent.selected && agent.available)
                      ? "选择工作文件夹，直接描述你要完成的事。"
                      : "接入电脑里的 Agent，配置总控模型，然后交代任务。"}
                  </p>
                  <div className="row empty-actions">
                    {!agents.some(
                      (agent) => agent.selected && agent.available,
                    ) && (
                      <button className="button primary" onClick={openAgents}>
                        接入 Agent
                      </button>
                    )}
                    {!state.model && (
                      <button className="button" onClick={openModel}>
                        配置模型
                      </button>
                    )}
                    {state.model &&
                      agents.some(
                        (agent) => agent.selected && agent.available,
                      ) &&
                      [
                        [
                          "梳理项目",
                          "梳理这个项目的目录与启动方式，先不要修改文件。",
                        ],
                        [
                          "检查修改",
                          "检查当前项目的未提交修改，指出具体问题，先不要修改文件。",
                        ],
                        [
                          "整理资料",
                          "梳理这个工作目录中的资料，先给出整理建议，不要移动或删除文件。",
                        ],
                      ].map(([label, prompt]) => (
                        <button
                          key={label}
                          className="button"
                          onClick={() => {
                            setText(prompt);
                            input.current?.focus();
                          }}
                        >
                          {label}
                        </button>
                      ))}
                  </div>
                </div>
              ) : (
                messages.map((m) => {
                  const linked =
                    m.role === "user"
                      ? []
                      : m.taskIds
                          .map((id) => tasks.find((t) => t.id === id))
                          .filter((t): t is Task => !!t && !rendered.has(t.id));
                  linked.forEach((t) => rendered.add(t.id));
                  return (
                    <div key={m.id} id={"message-" + m.id} tabIndex={-1}>
                      {m.role === "user" ? (
                        <div className="user-message">
                          <div className="bubble ui-message">{m.text}</div>
                          <div className="message-meta">
                            {m.taskIds.map((id) => (
                              <button key={id} onClick={() => locate(id)}>
                                {id.slice(0, 8)}
                              </button>
                            ))}
                            {m.routing && (
                              <span
                                className={
                                  m.routing.status === "pending"
                                    ? "routing-pending"
                                    : undefined
                                }
                              >
                                {routingLabel(m.routing)}
                              </span>
                            )}
                            {m.routing?.retryable &&
                              ["failed", "interrupted"].includes(
                                m.routing.status,
                              ) && (
                                <button
                                  disabled={pendingRoutingRetries.includes(
                                    m.id,
                                  )}
                                  onClick={() => void retryRouting(m.id)}
                                >
                                  {pendingRoutingRetries.includes(m.id)
                                    ? "提交中…"
                                    : "重新判断"}
                                </button>
                              )}
                            {m.delivery && !m.routing && (
                              <span>
                                {
                                  {
                                    received: "已接收",
                                    delivered: "已送达",
                                    applied: "已采用",
                                    deferred: "暂未生效",
                                  }[m.delivery]
                                }
                              </span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="assistant-message">
                          <div className="assistant-mark">
                            <Icon name="branch" />
                          </div>
                          <div className="assistant-body">
                            <div className="speaker">ACD</div>
                            {m.completion ? (
                              <CompletionReport
                                report={m.completion}
                                onRetry={async () => {
                                  if (!window.acd)
                                    throw Error("桌面连接不可用");
                                  await window.acd.request(
                                    "POST",
                                    `/api/reports/${m.completion!.id}/retry`,
                                    {},
                                  );
                                  await refresh();
                                }}
                                onOpen={
                                  m.completion.nativeId &&
                                  nativeSessions.some(
                                    (session) =>
                                      session.id === m.completion!.nativeId &&
                                      session.turnId === m.completion!.turnId,
                                  )
                                    ? () => {
                                        const session = nativeSessions.find(
                                          (session) =>
                                            session.id ===
                                            m.completion!.nativeId,
                                        )!;
                                        openNative(session.agentId, session.id);
                                      }
                                    : undefined
                                }
                              />
                            ) : (
                              <p className="ui-message">{m.text}</p>
                            )}
                            {linked.map(task)}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
              {tasks.filter((t) => !rendered.has(t.id)).map(task)}
              {questions.filter((q) => !q.resolved && !q.taskId).map(question)}
              {failedSends.map((receipt) => (
                <div className="send-failure" key={receipt.id} role="alert">
                  <p className="send-failure-label">尚未确认接收</p>
                  <p className="ui-message">{receipt.text}</p>
                  <div>
                    <span>{receipt.error}</span>
                    <button
                      className="button"
                      disabled={pending.includes(receipt.id)}
                      onClick={() => void transmit(receipt)}
                    >
                      {pending.includes(receipt.id) ? "重试中…" : "重试发送"}
                    </button>
                    <button
                      className="button ghost"
                      disabled={pending.includes(receipt.id)}
                      title="只移除本机重试记录，不停止任务"
                      onClick={() => {
                        try {
                          drafts.forget(receipt.id);
                          setFailedSends((items) =>
                            items.filter((item) => item.id !== receipt.id),
                          );
                        } catch (failure) {
                          setError(
                            failure instanceof Error
                              ? failure.message
                              : "暂时无法移除记录",
                          );
                        }
                      }}
                    >
                      移除提示
                    </button>
                  </div>
                </div>
              ))}
              {pending.length > 0 && (
                <p className="pending-send" role="status">
                  {pending.length} 条消息正在送达…
                </p>
              )}
            </div>
          </div>
          <div className="composer-area">
            <div className="composer-wrap">
              {unread && (
                <div className="updates-anchor">
                  <button
                    className="updates-button"
                    onClick={() => {
                      stick.current = true;
                      setUnread(false);
                      if (scroll.current)
                        scroll.current.scrollTop = scroll.current.scrollHeight;
                    }}
                  >
                    回到最新 ↓
                  </button>
                </div>
              )}
              <form className="composer" onSubmit={send}>
                {(target || answer) && (
                  <div className="target-chip">
                    {answer
                      ? "回答问题"
                      : "补充给 " +
                        (tasks.find((task) => task.id === target)?.title ||
                          target?.slice(0, 8))}
                    <button
                      type="button"
                      aria-label="取消任务归属"
                      onClick={() => {
                        clearComposerTarget();
                      }}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                )}
                <textarea
                  ref={input}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  aria-label="交代任务或询问进展"
                  placeholder={answer ? answer.text : "交代任务，或询问进展…"}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing &&
                      e.keyCode !== 229
                    ) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <div className="composer-controls">
                    <button
                      type="button"
                      className="button ui-directory"
                      onClick={() => void directory()}
                      title={cwd || "选择工作目录"}
                    >
                      <Icon name="folder" />
                      {cwd ? cwd.split(/[\\/]/).pop() : "选择工作目录"}
                    </button>
                    <AllocationControls
                      agents={state?.agents || []}
                      targetAgentId={targetAgentId}
                      requiredCapabilities={requiredCapabilities}
                      locked={Boolean(
                        target || answer || restoredQuestionId.current,
                      )}
                      onAgentChange={setTargetAgentId}
                      onCapabilitiesChange={setRequiredCapabilities}
                    />
                  </div>
                  <button
                    type="submit"
                    className="send"
                    disabled={!text.trim() || !state}
                    aria-label="发送消息"
                  >
                    <Icon name="arrow" />
                  </button>
                </div>
              </form>
            </div>
          </div>
        </main>
      )}
      {modal === "agents" && (
        <Modal
          className="agent-picker"
          title={reportComplete ? "接入检查结果" : "接入你的 Agent"}
          dismissible={!connectBusy}
          onClose={() => {
            if (!connectBusy) setModal(null);
          }}
        >
          <p className="modal-intro">
            {scanBusy
              ? "正在被动查找本机已安装的 Agent，不会执行它们。"
              : "选择需要管理的 Agent，再检查程序能否启动。"}
          </p>
          <div className="agent-picker-toolbar">
            <button
              className="button"
              disabled={scanBusy || connectBusy}
              onClick={() => void scan()}
            >
              {scanBusy ? "正在扫描…" : "重新扫描"}
            </button>
            <button
              className="button ghost"
              disabled={scanBusy || connectBusy}
              onClick={() => void addManual()}
            >
              手动添加程序
            </button>
            <span className="small agent-count">已发现 {agents.length} 个</span>
          </div>
          {reportComplete && (
            <div className="connection-report" role="status">
              <strong>检查完成</strong>
              <p>
                通过程序启动检查的 Agent
                已接入。账号和模型权限仍待首次实际执行验证。
              </p>
            </div>
          )}
          <div className="agent-grid">
            {agents.map((a) => {
              const unsupported =
                a.supported === false || a.verification === "unsupported";
              return (
                <label
                  className={
                    "scan-choice " + (unsupported ? "unsupported-agent" : "")
                  }
                  key={a.id}
                >
                  <span className="agent-box-top">
                    <span className="agent-mark">
                      <Icon
                        name={
                          a.kind === "codex"
                            ? "code"
                            : a.kind === "claude"
                              ? "chat"
                              : "branch"
                        }
                      />
                    </span>
                    <input
                      type="checkbox"
                      checked={selected.includes(a.id)}
                      disabled={
                        unsupported ||
                        connectBusy ||
                        scanBusy ||
                        (!a.available && a.verification !== "failed")
                      }
                      onChange={(e) => {
                        setReportComplete(false);
                        setSelected((ids) =>
                          e.target.checked
                            ? [...ids, a.id]
                            : ids.filter((id) => id !== a.id),
                        );
                      }}
                    />
                  </span>
                  <span className="scan-name">
                    <strong>{a.name}</strong>
                    <span
                      className={
                        "agent-verification " +
                        (a.verification === "failed"
                          ? "failed"
                          : a.verification === "verified"
                            ? "verified"
                            : "")
                      }
                    >
                      {connectBusy && selected.includes(a.id)
                        ? "正在检查启动…"
                        : agentStatus(a)}
                    </span>
                    {unsupported && (
                      <small className="agent-check-note">
                        ACD 当前还不能给它分配任务。
                      </small>
                    )}
                    <small className="agent-install-path" title={a.executable}>
                      {a.executable}
                    </small>
                    {(a.verification === "failed" ||
                      a.verification === "verified") && (
                      <small className="agent-check-note">
                        {a.verificationMessage}
                      </small>
                    )}
                    {a.selected && (
                      <small className="agent-enrolled">
                        已接入 · 账号待验证
                      </small>
                    )}
                  </span>
                </label>
              );
            })}
            {!scanBusy && !agents.length && (
              <p className="empty-note">
                没有发现候选程序。可重新扫描，或手动指定安装路径。
              </p>
            )}
          </div>
          {agentError && (
            <p className="form-error" role="alert">
              {agentError}
            </p>
          )}
          <div className="modal-footer">
            <span className="small">已选 {selected.length} 个</span>
            <div className="row">
              {reportComplete && (
                <button className="button" onClick={() => setModal(null)}>
                  完成
                </button>
              )}
              <button
                className="button primary"
                disabled={
                  scanBusy ||
                  connectBusy ||
                  (!selected.length && !agents.some((a) => a.selected))
                }
                onClick={() => void checkAgents()}
              >
                {connectBusy
                  ? "正在检查…"
                  : reportComplete
                    ? "重新检查"
                    : "检查并接入"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {modal === "search" && (
        <Modal title="查找任务" onClose={() => setModal(null)}>
          <input
            className="inline-search"
            autoFocus
            type="search"
            placeholder="搜索任务、编号或工作目录"
            aria-label="搜索任务"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="search-results">
            {tasks
              .filter((t) =>
                [t.id, t.title, t.cwd].some((v) =>
                  v.toLowerCase().includes(query.toLowerCase()),
                ),
              )
              .map((t) => (
                <button
                  className="search-result"
                  key={t.id}
                  onClick={() => locate(t.id)}
                >
                  <span>
                    <strong>{t.title}</strong>
                    <small>{t.cwd}</small>
                  </span>
                  <span className="pill">{labels[t.status]}</span>
                </button>
              ))}
          </div>
        </Modal>
      )}
      {archivedReport && (
        <Modal title="历史报告" onClose={() => setArchivedReport(null)}>
          {"unavailable" in archivedReport ? (
            <p role="alert">{archivedReport.unavailable}</p>
          ) : (
            <CompletionReport report={archivedReport} />
          )}
        </Modal>
      )}
      {focused && (
        <Modal title={focused.title} onClose={() => setDetail(null)}>
          <span className="pill">{labels[focused.status]}</span>
          <section className="detail-section">
            <h3>最终目标</h3>
            <p>{focused.goal}</p>
          </section>
          <section className="detail-section">
            <h3>当前进展</h3>
            <p>{focused.progress}</p>
          </section>
          {focused.status === "unknown" && (
            <section className="detail-section recovery-panel">
              <p>
                ACD 无法确认原执行状态。请先在原 Agent
                或进程中核对已停止，再解除占用。
              </p>
              <label className="recovery-check">
                <input
                  type="checkbox"
                  checked={recoveryConfirmed === focused.id}
                  onChange={(e) =>
                    setRecoveryConfirmed(e.target.checked ? focused.id : null)
                  }
                />
                我已核对原执行已停止
              </label>
              <button
                className="button"
                disabled={recoveryConfirmed !== focused.id}
                onClick={async () => {
                  if (recoveryConfirmed !== focused.id) return;
                  if (
                    await perform(
                      "POST",
                      `/api/tasks/${encodeURIComponent(focused.id)}/reconcile`,
                      { outcome: "stopped" },
                    )
                  ) {
                    setRecoveryConfirmed(null);
                    setDetail(null);
                  }
                }}
              >
                确认停止并解除占用
              </button>
              <p className="scan-note">
                此操作依据你的核对记录状态，不会重新执行任务。
              </p>
            </section>
          )}
          <section className="detail-section">
            <h3>执行范围</h3>
            <dl className="detail-data">
              <dt>Agent</dt>
              <dd>{agentName(focused.agentId)}</dd>
              <dt>工作目录</dt>
              <dd>{focused.cwd}</dd>
              <dt>要求版本</dt>
              <dd>{focused.revision}</dd>
              <dt>任务编号</dt>
              <dd>{focused.id}</dd>
            </dl>
          </section>
          {focused.allocation && (
            <AllocationReason allocation={focused.allocation} />
          )}
          {focused.result && (
            <section className="detail-section task-result">
              <h3>交付结果</h3>
              <pre>{focused.result}</pre>
            </section>
          )}
          <div className="modal-footer">
            <button className="button" onClick={() => supplement(focused.id)}>
              补充要求
            </button>
            {!ended(focused) && focused.status !== "stopping" && (
              <button
                className="button danger"
                onClick={async () => {
                  if (
                    await perform(
                      "POST",
                      `/api/tasks/${encodeURIComponent(focused.id)}/stop`,
                    )
                  )
                    setDetail(null);
                }}
              >
                停止任务
              </button>
            )}
          </div>
          <p className="scan-note">
            停止不会撤销已经产生的修改。结果无法确认时保留“状态待确认”。
          </p>
        </Modal>
      )}
    </div>
  );
}
async function start() {
  let storage: Storage | undefined, scope: string | undefined;
  try {
    const info = await window.acd?.getLocalInfo();
    scope = info?.dataDirectory;
    storage = localStorage;
  } catch {
    /* The editor still opens, with an actionable storage error. */
  }
  createRoot(document.getElementById("root")!).render(
    <App drafts={new ComposerDrafts(storage, scope)} />,
  );
}
void start();
