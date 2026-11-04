export interface WeChatStatus {
  state:
    | "disconnected"
    | "waiting_scan"
    | "scanned"
    | "need_code"
    | "connecting"
    | "connected"
    | "paused"
    | "expired"
    | "error";
  cwd: string;
  notifications: boolean;
  completionReports?: boolean;
  paired?: boolean;
  canResume?: boolean;
  ownerHint?: string;
  qrContent?: string;
  qrExpiresAt?: string;
  error?: string;
  lifecycle?: "registered" | "unconfirmed";
  lastPollAt?: string;
  receivedMessages?: number;
  ignoredMessages?: number;
  lastIgnoredReason?: string;
  lastReceivedAt?: string;
  lastSubmittedAt?: string;
  lastSubmissionHasMessageId?: boolean;
  uncertainDeliveries: number;
  uncertainOperations: number;
}
