import { createHash } from "node:crypto";
import type { Message, Task } from "../contracts/index.js";
import {
  inspectReportArtifacts,
  type ReportArtifact,
} from "./report-artifacts.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";
import { publicSnippet, type NativeActivityContext } from "./native-context.js";

export interface AssessmentContext {
  objective: string;
  outcome: "in_progress" | "delivered" | "no_delivery";
  summary: string;
  recentRequests?: string[];
}
export interface CompletionAssessment {
  outcome: AssessmentContext["outcome"];
  objective: string;
  evidence: string;
  summary: string;
  suggestions: string[];
}
export interface CompletionInput {
  previous?: AssessmentContext;
  userRequest?: string;
  artifacts?: ReportArtifact[];
  title: string;
  requirements: string[];
  result: string;
  progress: string;
}
export interface CompletionJob extends CompletionInput {
  id: string;
  messageId: string;
  executionKey: string;
  cwd?: string;
  taskId?: string;
  taskRevision?: number;
  native?: {
    id: string;
    sessionId: string;
    turnId?: string;
    agentName: string;
  };
  state: "pending" | "working" | "done" | "failed" | "skipped";
  attempts: number;
  retryAt: number;
  prepared: boolean;
  createdAt: string;
}
export function queueCompletion(
  store: Store,
  input: CompletionInput & {
    executionKey: string;
    cwd?: string;
    taskId?: string;
    taskRevision?: number;
    native?: CompletionJob["native"];
  },
) {
  const id = createHash("sha256").update(input.executionKey).digest("hex");
  const previous = store.get<CompletionJob>("completion-jobs", id);
  const job: CompletionJob = previous || {
    ...input,
    ...(input.userRequest
      ? { userRequest: publicSnippet(input.userRequest, 2000) }
      : {}),
    id,
    messageId: "completion-" + id,
    state: "pending",
    attempts: 0,
    retryAt: 0,
    prepared: !input.native,
    createdAt: new Date().toISOString(),
    requirements: input.requirements.map((text) => publicSnippet(text, 1500)),
    result: publicSnippet(input.result, 200000).slice(-6000),
  };
  if (!previous) store.put("completion-jobs", id, job);
  return job;
}

/** Durable post-processing of execution results; it never launches agent work. */
export class CompletionReporter {
  private stopped = false;
  private active?: Promise<void>;
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private readonly listener = () => {
    void this.pump();
  };
  constructor(
    private readonly runtime: Runtime,
    private readonly context: (
      sessionId: string,
      turnId?: string,
    ) => Promise<NativeActivityContext>,
  ) {
    for (const job of runtime.store.list<CompletionJob>("completion-jobs"))
      if (job.state === "working")
        runtime.store.put("completion-jobs", job.id, {
          ...job,
          state: "pending",
        });
  }
  start() {
    this.runtime.on("state", this.listener);
    this.timer = setInterval(this.listener, 5000);
    this.timer.unref();
    void this.pump();
  }
  retry(id: string) {
    const job = this.runtime.store.get<CompletionJob>("completion-jobs", id);
    if (!job) throw Error("结果报告不存在");
    if (job.state === "done" || job.state === "working") return;
    this.runtime.store.put("completion-jobs", id, {
      ...job,
      state: "pending",
      attempts: 0,
      retryAt: 0,
    });
    this.runtime.publish();
  }
  private async pump() {
    if (this.stopped || this.active) return;
    const run = this.drain();
    this.active = run;
    try {
      await run;
    } finally {
      this.active = undefined;
      if (
        !this.stopped &&
        this.runtime.store
          .list<CompletionJob>("completion-jobs")
          .some((job) => job.state === "pending" && job.retryAt <= Date.now())
      )
        queueMicrotask(this.listener);
    }
  }
  private current(job: CompletionJob) {
    if (job.taskId && job.taskRevision !== undefined) {
      const task = this.runtime.store.get<Task>("tasks", job.taskId);
      return (
        task?.revision === job.taskRevision &&
        ["review", "completed"].includes(task.status)
      );
    }
    return (
      !job.native ||
      !this.runtime.store.get<{ ignored?: boolean }>(
        "native-executions",
        job.native.id,
      )?.ignored
    );
  }
  private skip(job: CompletionJob) {
    this.runtime.store.put("completion-jobs", job.id, {
      ...job,
      state: "skipped",
    });
    const message = this.runtime.store.getMessage(job.messageId);
    // An upgrade or a retried assessment may already have a placeholder.
    if (message?.completion && message.completion.status !== "ready") {
      this.runtime.store.message({
        ...message,
        text: "",
        completion: { ...message.completion, status: "withheld" },
      });
      this.runtime.publish();
    }
  }
  private message(
    job: CompletionJob,
    status: "ready" | "failed",
    text: string,
  ): Message {
    return {
      id: job.messageId,
      role: "assistant",
      text,
      createdAt: new Date().toISOString(),
      taskIds: job.taskId ? [job.taskId] : [],
      completion: {
        id: job.id,
        title: job.title,
        status,
        nativeId: job.native?.id,
        turnId: job.native?.turnId,
        agentName: job.native?.agentName,
      },
    };
  }
  private async drain() {
    for (const pending of this.runtime.store.list<CompletionJob>(
      "completion-jobs",
    )) {
      if (this.stopped) return;
      if (pending.state !== "pending" || pending.retryAt > Date.now()) continue;
      if (!this.current(pending)) {
        this.skip(pending);
        continue;
      }
      const message = this.runtime.store.getMessage(pending.messageId);
      if (message?.completion?.status === "ready") {
        this.runtime.store.put("completion-jobs", pending.id, {
          ...pending,
          state: "done",
        });
        continue;
      }
      let job: CompletionJob = {
        ...pending,
        state: "working",
        attempts: pending.attempts + 1,
      };
      this.runtime.store.put("completion-jobs", job.id, job);
      try {
        if (job.native && !job.prepared) {
          const context = await this.context(
            job.native.sessionId,
            job.native.turnId,
          );
          job = {
            ...job,
            prepared: true,
            requirements: [
              ...new Set(
                [context.request, ...context.requests].filter(Boolean),
              ),
            ].map((text) => publicSnippet(text, 1500)),
            result: publicSnippet(context.finalAnswer || "", 6000),
          };
          this.runtime.store.put("completion-jobs", job.id, job);
        }
        const scope = job.native?.id || job.taskId;
        const checkpoint = scope
          ? this.runtime.store.get<
              AssessmentContext & {
                fingerprint: string;
                lastDelivery?: string;
                at: string;
              }
            >("completion-assessments", scope)
          : undefined;
        const previous =
          checkpoint && checkpoint.at <= job.createdAt ? checkpoint : undefined;
        const mayAdvance = !checkpoint || checkpoint.at <= job.createdAt;
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([job.requirements, job.result]))
          .digest("hex");
        const recentRequests = [
          ...new Set([
            ...(previous?.recentRequests || []),
            ...job.requirements,
          ]),
        ].slice(-4);
        if (
          !job.requirements.some((text) => text.trim()) ||
          checkpoint?.fingerprint === fingerprint ||
          checkpoint?.lastDelivery === fingerprint
        ) {
          this.skip(job);
          continue;
        }
        if (!job.result.trim()) {
          if (scope && mayAdvance)
            this.runtime.store.put("completion-assessments", scope, {
              // Preserve the user's requirements even if the agent has not yet produced output.
              objective: [
                ...new Set([
                  ...(previous?.outcome === "in_progress"
                    ? [previous.objective]
                    : []),
                  ...job.requirements,
                ]),
              ]
                .join("\n")
                .slice(0, 4000),
              outcome: "in_progress",
              summary: "尚无最终产物。",
              recentRequests,
              lastDelivery: previous?.lastDelivery,
              fingerprint,
              at: job.createdAt,
            });
          this.skip(job);
          continue;
        }
        const artifacts = job.cwd
          ? inspectReportArtifacts(
              job.cwd,
              [
                ...job.requirements,
                ...(job.userRequest ? [job.userRequest] : []),
                ...(previous?.outcome === "in_progress"
                  ? [previous.objective]
                  : []),
              ],
              job.result,
            )
          : [];
        const assessment = await this.runtime.summarizeCompletion(
          {
            title: job.title,
            ...(job.userRequest ? { userRequest: job.userRequest } : {}),
            requirements: job.requirements,
            result: job.result,
            progress: job.progress,
            ...(artifacts.length ? { artifacts } : {}),
            ...(previous
              ? {
                  previous: {
                    objective: previous.objective,
                    outcome: previous.outcome,
                    summary: previous.summary,
                    recentRequests: previous.recentRequests,
                  },
                }
              : {}),
          },
          this.controller.signal,
        );
        if (this.stopped) throw Error("报告服务正在退出");
        if (!this.current(job)) {
          this.skip(job);
          continue;
        }
        if (assessment.outcome === "delivered") this.deliver(job, assessment);
        else this.skip(job);
        if (scope && mayAdvance) {
          // A conversational acknowledgement must not erase an unfinished goal.
          // Keep the raw user constraints even when the model is inconclusive.
          const context =
            assessment.outcome === "no_delivery" && previous
              ? previous
              : assessment;
          this.runtime.store.put("completion-assessments", scope, {
            objective: context.objective,
            outcome: context.outcome,
            summary: context.summary,
            recentRequests,
            fingerprint,
            at: job.createdAt,
            lastDelivery:
              assessment.outcome === "delivered"
                ? fingerprint
                : previous?.lastDelivery,
          });
        }
      } catch (error) {
        if (this.stopped) {
          this.runtime.store.put("completion-jobs", job.id, {
            ...job,
            state: "pending",
          });
          return;
        }
        const text =
          error instanceof Error ? error.message : "暂时无法整理结果";
        this.runtime.store.put("completion-jobs", job.id, {
          ...job,
          state: job.attempts < 2 ? "pending" : "failed",
          retryAt: Date.now() + 30000,
        });
        if (job.attempts >= 2 && this.current(job)) {
          const message = this.message(
            job,
            "failed",
            "完成判定暂时失败，可重试。",
          );
          message.completion!.error = text;
          this.runtime.store.message(message);
        }
        this.runtime.publish();
      }
    }
  }
  private deliver(job: CompletionJob, assessment: CompletionAssessment) {
    const title = assessment.objective || job.title;
    const text = `「${title}」已交付。\n\n${assessment.summary}\n\n建议：\n${assessment.suggestions.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
    const message = this.message(job, "ready", text);
    message.completion = {
      ...message.completion!,
      title,
      summary: assessment.summary,
      suggestions: assessment.suggestions,
      assessed: true,
    };
    this.runtime.store.message(message);
    this.runtime.store.put("completion-jobs", job.id, {
      ...job,
      state: "done",
    });
    this.runtime.publish();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.runtime.off("state", this.listener);
    this.controller.abort();
    await this.active;
  }
}
