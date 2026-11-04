export type Locale = "zh-CN" | "en";
export interface AppPreferences {
  locale: Locale;
}
export type {
  Schedule,
  ScheduleInput,
  ScheduleRule,
  ScheduleRun,
} from "./schedules.js";
export type AgentKind =
  | "codex"
  | "claude"
  | "opencode"
  | "pi"
  | "deepseek-harness"
  | "openclaw"
  | "hermes"
  | "custom";
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "stopping"
  | "cancelled"
  | "unknown";
export type AgentCapability = "steer" | "resume" | "approval" | "input";
export interface AllocationRequest {
  targetAgentId?: string;
  requiredCapabilities?: AgentCapability[];
}
export interface AllocationSettings {
  globalAgentOrder?: string[];
  projectAgentOrders?: Record<string, string[]>;
  // Compatibility projection for clients that display the first preference.
  globalAgentId: string | null;
  projectAgentIds: Record<string, string>;
}
export interface AllocationDecision {
  policyVersion: 1;
  source:
    | "explicit"
    | "project-default"
    | "global-default"
    | "single-candidate"
    | "model";
  reason: string;
  requiredCapabilities: AgentCapability[];
  modelSuggestedAgentId?: string;
  excluded: { agentId: string; reason: string }[];
}
export interface AgentConnection {
  id: string;
  kind: AgentKind;
  name: string;
  executable: string;
  selected: boolean;
  available: boolean;
  discoverySource?: "scan" | "manual";
  supported?: boolean;
  verification?:
    "discovered" | "checking" | "verified" | "failed" | "unsupported";
  verificationMessage?: string;
  capabilities: {
    steer: boolean;
    resume: boolean;
    approval?: boolean;
    input?: boolean;
  };
}
export interface Task {
  inquiry?: {
    sourceId: string;
    sessionId: string;
    question: string;
    turnId?: string;
  };
  pendingTurnText?: string;
  followupQuestionId?: string;
  responseKind?: "answer" | "work";
  allocation?: AllocationDecision;
  scheduleId?: string;
  scheduleRunId?: string;
  sourceMessageId?: string;
  id: string;
  title: string;
  goal: string;
  agentId: string;
  cwd: string;
  status: TaskStatus;
  revision: number;
  sessionId?: string;
  turnId?: string;
  progress: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}
export interface RoutingReceipt {
  /** True only when no task action has been applied. Never inferred by clients. */
  retryable?: boolean;
  /** Explicit understanding attempts; completed retries return the existing receipt. */
  attempt?: number;
  status: "pending" | "completed" | "failed" | "interrupted";
  actions: Action["type"][];
}
export interface CompletionSummary {
  summary: string;
  suggestions: string[];
}
export interface CompletionReport extends Partial<CompletionSummary> {
  taskRevision?: number;
  id: string;
  title: string;
  status: "pending" | "ready" | "failed" | "withheld";
  assessed?: boolean;
  nativeId?: string;
  turnId?: string;
  agentName?: string;
  error?: string;
}
export interface Message {
  displayText?: string;
  inReplyToQuestionId?: string;
  taskOutcome?: { revision: number };
  replyTo?: string;
  completion?: CompletionReport;
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  taskIds: string[];
  createdAt: string;
  delivery?: "received" | "delivered" | "applied" | "deferred";
  attention?: boolean;
  routing?: RoutingReceipt;
  request?: { cwd: string; targetTaskId?: string } & AllocationRequest;
}
export interface Question {
  followup?: boolean;
  answerText?: string;
  answeredBy?: "user" | "supervisor";
  answerBasis?: string;
  answerDelivery?: "queued" | "submitted" | "not_submitted" | "unknown";
  sourceMessageId?: string;
  id: string;
  taskId?: string;
  revision?: number;
  kind: "approval" | "clarification" | "input";
  text: string;
  choices: string[];
  choiceLabels?: Record<string, string>;
  resolved: boolean;
  nativeRequestId?: string | number;
}
export interface ModelConfig {
  providerId?: string;
  protocol?: "openai-chat" | "anthropic-messages";
  baseUrl: string;
  model: string;
  hasKey: boolean;
}
export interface NativeInsight {
  requirements?: string[];
  title: string;
  summary: string;
  goal: string;
  currentStep: string;
  blocker: string;
  nextStep: string;
  generatedAt: string;
  model: string;
  basis: "public-fragments" | "metadata";
}
export interface NativeSession {
  taskTitle?: string;
  id: string;
  agentId: string;
  sessionId: string;
  turnId?: string;
  title: string;
  cwd: string;
  status: "running" | "waiting_input" | "idle" | "failed" | "unknown";
  endedReason?: "completed" | "aborted";
  /** A new terminal event was read after the source established its baseline. */
  completionObserved?: boolean;
  progress: string;
  observedAt: string;
  eventAt?: string;
}
export interface AgentObservation {
  excludedSessionIds?: string[];
  agentId: string;
  source?: "runtime-api" | "run-events";
  state: "connected" | "unavailable" | "unsupported";
  message: string;
  observedAt?: string;
  sessions: NativeSession[];
}
export interface Snapshot {
  preferences?: AppPreferences;
  allocationSettings?: AllocationSettings;
  schedules?: import("./schedules.js").Schedule[];
  environment?: "live" | "test";
  agents: AgentConnection[];
  tasks: Task[];
  messages: Message[];
  questions: Question[];
  model: ModelConfig | null;
  observations?: AgentObservation[];
  notifications?: import("./notifications.js").NoticeFeed;
}
export interface AdapterEvent {
  type:
    | "session"
    | "progress"
    | "output"
    | "completed"
    | "failed"
    | "cancelled"
    | "question"
    | "question_resolved";
  /** The adapter has not submitted this task's prompt to the executor. */
  taskNotSubmitted?: boolean;
  input?: boolean;
  choiceLabels?: Record<string, string>;
  text?: string;
  sessionId?: string;
  turnId?: string;
  requestId?: string | number;
  choices?: string[];
}
export interface RunHandle {
  steer(text: string): Promise<void>;
  stop(): Promise<void>;
  answer(requestId: string | number, choice: string): Promise<void>;
  dispose(): void;
}
export interface StartRun {
  task: Task;
  agent: AgentConnection;
  onEvent: (event: AdapterEvent) => void;
}
export interface AgentAdapter {
  start(input: StartRun): Promise<RunHandle>;
}
export type Action =
  | { type: "schedule_create"; input: import("./schedules.js").ScheduleInput }
  | {
      type: "schedule_control";
      scheduleId: string;
      operation: "pause" | "resume" | "delete";
      expectedUpdatedAt: string;
    }
  | { type: "schedule_status"; scheduleIds: string[] }
  | {
      type: "create";
      responseKind?: "answer" | "work";
      requiredCapabilities?: AgentCapability[];
      requestedAgentId?: string;
      title: string;
      goal: string;
      agentId: string;
      cwd: string;
    }
  | {
      type: "supplement";
      taskId: string;
      text: string;
      expectedRevision: number;
    }
  | { type: "stop"; taskId: string; expectedRevision: number }
  | { type: "status"; taskIds: string[] }
  | { type: "history"; query: string; sourceId?: string }
  | { type: "ask_agent"; sourceId: string; question: string }
  | { type: "clarify"; text: string; taskIds: string[] };
export interface RouteDecision {
  reply: string;
  actions: Action[];
}

export interface SkillSource {
  rootPath: string;
  scope: "global" | "project";
  agents: AgentKind[];
  label: string;
}
export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  directory: string;
  sources: SkillSource[];
  warnings: string[];
  valid: boolean;
}
export interface SkillCatalog {
  skills: SkillRecord[];
  roots: SkillSource[];
  warnings: string[];
  scannedAt: string | null;
  projectPath?: string;
}
export interface SkillDetail {
  skill: SkillRecord;
  content: string;
  truncated: boolean;
}

export interface SkillTranslation {
  description: string;
  content: string;
  truncated: boolean;
}

export interface SkillTrashEntry {
  id: string;
  name: string;
  rootPath: string;
  originalDirectory: string;
  createdAt: string;
}
export interface CreateSkillInput {
  rootPath: string;
  name: string;
  description: string;
  content: string;
}
