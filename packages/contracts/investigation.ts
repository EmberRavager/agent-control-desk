export interface HistoryEvidence {
  sourceId: string;
  kind: "task" | "native" | "conversation";
  title: string;
  cwd: string;
  agentId?: string;
  status?: string;
  messageIds: string[];
  excerpts: string[];
  truncated: boolean;
  match?: "explicit" | "content" | "recent";
}
export interface HistoryLookup {
  query: string;
  entries: HistoryEvidence[];
  hasMore: boolean;
}
export interface InvestigationContext {
  stage: "history";
  history: HistoryLookup;
}
