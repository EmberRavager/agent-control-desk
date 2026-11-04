import React from "react";
import type { CompletionReport as Report } from "../../packages/contracts/index.js";
export default function CompletionReport({
  report,
  onRetry,
  onOpen,
  showHeading = true,
}: {
  report: Report;
  onRetry?: () => Promise<void>;
  onOpen?: () => void;
  showHeading?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  async function retry() {
    if (busy || !onRetry) return;
    setBusy(true);
    setError("");
    try {
      await onRetry();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "暂时无法重试完成判定",
      );
    } finally {
      setBusy(false);
    }
  }
  if (report.status === "withheld") return null;
  return (
    <section className="completion-report" aria-label="任务结果与建议">
      {showHeading && (
        <div className="completion-heading">
          <h3>{report.title}</h3>
          <span>
            {report.status === "pending"
              ? "整理中"
              : report.status === "failed"
                ? "判定待重试"
                : report.assessed
                  ? "AI 判定已交付"
                  : "结果待检查"}
          </span>
        </div>
      )}
      {report.status === "pending" ? (
        <p className="completion-pending" role="status">
          正在整理结果与建议…
        </p>
      ) : report.status === "ready" ? (
        <>
          <p className="completion-summary">{report.summary}</p>
          {!!report.suggestions?.length && (
            <div className="completion-suggestions">
              <h4>建议</h4>
              <ol>
                {report.suggestions.map((suggestion, index) => (
                  <li key={index}>{suggestion}</li>
                ))}
              </ol>
            </div>
          )}
        </>
      ) : (
        <div className="completion-failed">
          <p>{report.error || "结果与建议暂未生成。"}</p>
          {onRetry && (
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => void retry()}
            >
              {busy ? "重试中…" : "重试完成判定"}
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {onOpen && (
        <button className="button ghost completion-source" onClick={onOpen}>
          查看任务
        </button>
      )}
    </section>
  );
}
