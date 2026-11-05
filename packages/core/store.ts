import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  truncateSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "../contracts/index.js";
export class Store {
  readonly db: DatabaseSync;
  private log: string;
  private seen = new Set<string>();
  private messages = new Map<string, Message>();
  private nativeReports = new Map<string, string>();
  private readyReportIds: string[] = [];
  private changedReports = new Set<string>();
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.log = join(directory, "conversation.jsonl");
    if (existsSync(this.log)) {
      const content = readFileSync(this.log, "utf8"),
        lines = content.split("\n");
      const tail = lines.pop()!;
      let valid = 0;
      const load = (line: string) => {
        const e = JSON.parse(line);
        if (typeof e.eventId !== "string" || !e.message)
          throw Error("Conversation log is corrupt; restore a backup.");
        this.seen.add(e.eventId);
        this.indexMessage(e.message);
      };
      for (const line of lines) {
        if (line) load(line);
        valid += Buffer.byteLength(line + "\n");
      }
      if (tail) {
        let complete = true;
        try {
          load(tail);
        } catch {
          complete = false;
          truncateSync(this.log, valid);
        }
        if (complete) {
          const fd = openSync(this.log, "a");
          try {
            writeSync(fd, "\n");
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
      }
    }
    this.db = new DatabaseSync(join(directory, "state.sqlite"));
    chmodSync(join(directory, "state.sqlite"), 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS pending_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,data TEXT NOT NULL); PRAGMA user_version=1;",
    );
    this.flush();
  }
  list<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM entities WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(String(r.data)));
  }
  get<T>(kind: string, id: string): T | undefined {
    const r = this.db
      .prepare("SELECT data FROM entities WHERE kind=? AND id=?")
      .get(kind, id);
    return r ? JSON.parse(String(r.data)) : undefined;
  }
  put(kind: string, id: string, data: unknown) {
    this.db
      .prepare(
        "INSERT INTO entities(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, id, JSON.stringify(data));
  }
  remove(kind: string, id: string) {
    this.db.prepare("DELETE FROM entities WHERE kind=? AND id=?").run(kind, id);
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  message(message: Message) {
    const event = { eventId: randomUUID(), message };
    this.db
      .prepare("INSERT INTO pending_log(event_id,data) VALUES(?,?)")
      .run(event.eventId, JSON.stringify(event));
    this.flush();
  }
  pendingRoutingMessages(): Message[] {
    return [...this.messages.values()].filter(
      (message) => message.routing?.status === "pending",
    );
  }
  private indexMessage(message: Message) {
    const previous = this.messages.get(message.id);
    this.messages.set(message.id, message);
    const ready = message.completion?.status === "ready";
    if (ready) {
      if (previous?.completion?.status !== "ready")
        this.readyReportIds.push(message.id);
      this.changedReports.add(message.id);
    }
    const nativeId = ready ? message.completion!.nativeId : undefined;
    const previousNativeId =
      previous?.completion?.status === "ready"
        ? previous.completion.nativeId
        : undefined;
    if (!previous) {
      if (nativeId) this.nativeReports.set(nativeId, message.id);
    } else if (previousNativeId !== nativeId) {
      // Changing report identity is rare; rebuild in original insertion order.
      // Ordinary report updates must never supersede a newer execution.
      this.nativeReports.clear();
      for (const entry of this.messages.values())
        if (entry.completion?.status === "ready" && entry.completion.nativeId)
          this.nativeReports.set(entry.completion.nativeId, entry.id);
    }
  }
  latestNativeReportId(nativeId: string): string | undefined {
    return this.nativeReports.get(nativeId);
  }
  getReadyReport(messageId: string) {
    const message = this.messages.get(messageId);
    if (message?.completion?.status !== "ready") return;
    const nativeId = message.completion.nativeId;
    if (
      nativeId &&
      this.get<{ ignored?: boolean }>("native-executions", nativeId)?.ignored
    )
      return;
    return message;
  }
  get readyReportCount() {
    return this.readyReportIds.length;
  }
  readyReportsAfter(count: number) {
    return this.readyReportIds
      .slice(count)
      .flatMap((id) => this.getReadyReport(id) ?? []);
  }
  latestReadyReport() {
    for (let i = this.readyReportIds.length - 1; i >= 0; i--) {
      const report = this.getReadyReport(this.readyReportIds[i]);
      if (report) return report;
    }
  }
  projectChangedReports(visit: (message: Message) => void) {
    for (const id of this.changedReports) {
      const message = this.getReadyReport(id);
      if (message) visit(message);
      this.changedReports.delete(id);
    }
  }
  getMessage(id: string): Message | undefined {
    return this.messages.get(id);
  }
  history(scope: "recent" | "all" = "recent"): Message[] {
    const messages = [...this.messages.values()];
    return scope === "all" ? messages : messages.slice(-200);
  }
  private flush() {
    for (const row of this.db
      .prepare("SELECT * FROM pending_log ORDER BY seq")
      .all()) {
      const event = JSON.parse(String(row.data));
      if (!this.seen.has(event.eventId)) {
        const fd = openSync(this.log, "a", 0o600);
        try {
          const data = Buffer.from(JSON.stringify(event) + "\n");
          let offset = 0;
          while (offset < data.length) offset += writeSync(fd, data, offset);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        this.seen.add(event.eventId);
      }
      this.indexMessage(event.message);
      this.db.prepare("DELETE FROM pending_log WHERE seq=?").run(row.seq);
    }
  }
  close() {
    this.db.close();
  }
}
