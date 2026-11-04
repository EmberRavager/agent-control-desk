export type NoticeKind = "attention" | "result" | "error";
export interface Notice {
  id: string;
  sequence: number;
  kind: NoticeKind;
  title: string;
  body: string;
  createdAt: string;
  taskId?: string;
  questionId?: string;
  messageId?: string;
  revision?: number;
  taskStatus?: string;
  readAt?: string;
  desktop:
    | "pending"
    | "claimed"
    | "submitted"
    | "failed"
    | "suppressed"
    | "unverified";
  active: boolean;
  superseded?: boolean;
}
export interface NoticePreferences {
  desktop: boolean;
  sound: boolean;
  details: boolean;
  background: boolean;
  attention: boolean;
  result: boolean;
  error: boolean;
}
export interface NoticeFeed {
  items: Notice[];
  unread: number;
  hasMore: boolean;
  preferences: NoticePreferences;
}
export interface DesktopNoticeStatus {
  supported: boolean;
  backgroundAvailable: boolean;
  canOpenSettings: boolean;
  lastResult: "unverified" | "submitted" | "failed";
  error?: string;
}
