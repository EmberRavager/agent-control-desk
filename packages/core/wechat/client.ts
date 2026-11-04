import { randomBytes } from "node:crypto";
const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
// Protocol reference: Tencent/openclaw-weixin docs/protocol_zh_CN.md, 2026-11-03.
// ACD identifies itself through bot_agent; channel_version describes the referenced protocol client.
export function wechatBase(value = DEFAULT_BASE) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.hostname === "ilinkai.weixin.qq.com" ||
      url.hostname.endsWith(".weixin.qq.com")
    )
  )
    throw Error("微信返回的服务地址不受支持，请重新连接");
  return url.origin;
}
export interface WeChatLogin {
  binding?: string;
  token: string;
  baseUrl: string;
  botId: string;
  ownerId: string;
  contextToken?: string;
}
export interface WeChatSecret {
  get(): Promise<WeChatLogin | null>;
  set(value: WeChatLogin): Promise<void>;
  clear(): Promise<void>;
}
export interface Incoming {
  message_id?: number | string;
  seq?: number;
  client_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  message_state?: number;
  group_id?: string;
  context_token?: string;
  item_list?: { type?: number; text_item?: { text?: string } }[];
}
export class WeChatApiError extends Error {
  constructor(
    readonly expired: boolean,
    text: string,
  ) {
    super(text);
  }
}
export class WeChatClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async call(
    base: string,
    path: string,
    body: unknown,
    token: string | undefined,
    signal: AbortSignal,
    query?: URLSearchParams,
    timeout = 45000,
  ) {
    const url = new URL("/ilink/bot/" + path, wechatBase(base));
    if (query) url.search = query.toString();
    const response = await this.fetcher(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: {
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String(0x02040a),
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              AuthorizationType: "ilink_bot_token",
              "X-WECHAT-UIN": Buffer.from(
                String(randomBytes(4).readUInt32BE()),
              ).toString("base64"),
            }),
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WeChatApiError(
        response.status === 401 || response.status === 403,
        "微信接口暂不可用，请检查连接或重新扫码",
      );
    }
    let raw = "",
      size = 0;
    const decoder = new TextDecoder();
    if (!response.body) throw Error("微信返回了空响应");
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += part.byteLength;
      if (size > 1024 * 1024) {
        throw Error("微信响应超出处理上限");
      }
      raw += decoder.decode(part, { stream: true });
    }
    raw += decoder.decode();
    let value: any;
    try {
      value = JSON.parse(raw, (key, parsed, context?: { source?: string }) => {
        if (
          ["message_id", "msg_id", "svr_id"].includes(key) &&
          typeof parsed === "number" &&
          !Number.isSafeInteger(parsed)
        ) {
          if (!context?.source || !/^\d+$/.test(context.source))
            throw Error("消息编号无法安全解析");
          return context.source;
        }
        return parsed;
      });
    } catch {
      throw Error("微信响应格式无法识别");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("微信响应格式无法识别");
    for (const field of ["ret", "errcode"])
      if (value[field] !== undefined && !Number.isInteger(value[field]))
        throw Error("微信返回码格式无法识别");
    if (
      (typeof value.ret === "number" && value.ret !== 0) ||
      (typeof value.errcode === "number" && value.errcode !== 0)
    )
      throw new WeChatApiError(
        value.ret === -14 || value.errcode === -14,
        "微信会话失效或请求被拒绝，请重新扫码连接",
      );
    return value;
  }
  qr(signal: AbortSignal) {
    return this.call(
      DEFAULT_BASE,
      "get_bot_qrcode",
      { local_token_list: [] },
      undefined,
      signal,
      new URLSearchParams({ bot_type: "3" }),
    );
  }
  qrStatus(qrcode: string, base: string, signal: AbortSignal, code?: string) {
    return this.call(
      base,
      "get_qrcode_status",
      undefined,
      undefined,
      signal,
      new URLSearchParams({ qrcode, ...(code ? { verify_code: code } : {}) }),
    );
  }
  updates(login: WeChatLogin, cursor: string, signal: AbortSignal) {
    return this.call(
      login.baseUrl,
      "getupdates",
      { get_updates_buf: cursor, base_info: this.info() },
      login.token,
      signal,
    );
  }
  lifecycle(login: WeChatLogin, event: "start" | "stop", signal: AbortSignal) {
    return this.call(
      login.baseUrl,
      "msg/notify" + event,
      { base_info: this.info() },
      login.token,
      signal,
      undefined,
      5000,
    );
  }
  async send(
    login: WeChatLogin,
    clientId: string,
    text: string,
    signal: AbortSignal,
  ) {
    if (!login.contextToken)
      throw Error("请先在微信给 ACD 发一条消息，再接收反馈");
    const value = await this.call(
      login.baseUrl,
      "sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: login.ownerId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: login.contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: this.info(),
      },
      login.token,
      signal,
    );
    // Server acceptance is not a phone delivery receipt.
    return {
      ret: value.ret as number | undefined,
      errcode: value.errcode as number | undefined,
      hasServerMessageId:
        typeof value.message_id === "string"
          ? Boolean(value.message_id.trim()) && value.message_id.trim() !== "0"
          : Number.isSafeInteger(value.message_id) && value.message_id > 0,
    };
  }
  private info() {
    return { channel_version: "2.4.10", bot_agent: "AgentControlDesk/0.1.0" };
  }
}
