import type { WeChatSecret, WeChatLogin } from "./wechat/client.js";
import { createHash } from "node:crypto";
// Credentials are scoped to the selected API origin, never stored in state or JSONL.
export interface SecretVault {
  get(scope?: string): Promise<string | null>;
  set(value: string, scope?: string): Promise<void>;
}
export class SystemVault implements SecretVault {
  private account(scope?: string) {
    return (
      "supervisor:" +
      createHash("sha256")
        .update(scope ? new URL(scope).origin : "default")
        .digest("hex")
    );
  }
  async get(scope?: string) {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry("agent-control-desk", this.account(scope)).getPassword();
  }
  async set(value: string, scope?: string) {
    const { Entry } = await import("@napi-rs/keyring");
    new Entry("agent-control-desk", this.account(scope)).setPassword(value);
  }
}

// Separate account from supervisor keys and from other ACD data directories.
export class WeChatVault implements WeChatSecret {
  constructor(private readonly directory: string) {}
  private async entry() {
    const { Entry } = await import("@napi-rs/keyring");
    const account =
      "wechat:" + createHash("sha256").update(this.directory).digest("hex");
    return new Entry("agent-control-desk", account);
  }
  async get() {
    const raw = (await this.entry()).getPassword();
    return raw ? (JSON.parse(raw) as WeChatLogin) : null;
  }
  async set(value: WeChatLogin) {
    (await this.entry()).setPassword(JSON.stringify(value));
  }
  async clear() {
    const entry = await this.entry();
    if (entry.getPassword()) entry.deletePassword();
  }
}
