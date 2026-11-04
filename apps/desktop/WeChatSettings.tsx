import React, { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { WeChatStatus } from "../../packages/contracts/wechat.js";
interface Props {
  active: boolean;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  pickDirectory: () => Promise<string | null>;
}
const labels: Record<WeChatStatus["state"], string> = {
  disconnected: "未连接",
  waiting_scan: "等待扫码",
  scanned: "已扫码，请在手机确认",
  need_code: "需要手机验证码",
  connecting: "正在连接",
  connected: "已连接",
  paused: "已暂停",
  expired: "需要重新扫码",
  error: "连接失败",
};
export default function WeChatSettings({
  active,
  request,
  pickDirectory,
}: Props) {
  const [status, setStatus] = useState<WeChatStatus | null>(null),
    [cwd, setCwd] = useState(""),
    [notifications, setNotifications] = useState(true),
    [completionReports, setCompletionReports] = useState(false),
    [qr, setQr] = useState(""),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [readError, setReadError] = useState(""),
    [testSubmitted, setTestSubmitted] = useState(false);
  const api = useRef({ request, pickDirectory });
  api.current = { request, pickDirectory };
  const loaded = useRef(false),
    working = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    if (!active) return;
    let live = true,
      inFlight = false;
    const load = async () => {
      if (inFlight || working.current) return;
      inFlight = true;
      const version = generation.current;
      try {
        const next = (await api.current.request(
          "GET",
          "/api/wechat",
        )) as WeChatStatus;
        if (live && version === generation.current) {
          setStatus(next);
          setReadError("");
          if (!loaded.current) {
            loaded.current = true;
            setCwd(next.cwd);
            setNotifications(next.notifications);
            setCompletionReports(next.completionReports ?? false);
          }
        }
      } catch (e) {
        if (live && version === generation.current)
          setReadError(e instanceof Error ? e.message : "无法读取微信状态");
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active]);
  useEffect(() => {
    let live = true;
    setQr("");
    if (status?.qrContent)
      QRCode.toDataURL(status.qrContent, {
        width: 216,
        margin: 2,
        color: { dark: "#101010", light: "#ffffff" },
      })
        .then((data) => {
          if (live) setQr(data);
        })
        .catch(() => {
          if (live) setError("二维码无法显示，请重新获取。");
        });
    return () => {
      live = false;
    };
  }, [status?.qrContent]);
  async function action(path: string, body: unknown = {}) {
    if (working.current) return;
    working.current = true;
    generation.current++;
    setBusy(true);
    setError("");
    setTestSubmitted(false);
    try {
      const next = (await api.current.request(
        "POST",
        "/api/wechat/" + path,
        body,
      )) as WeChatStatus;
      setReadError("");
      setStatus(next);
      if (path === "test") setTestSubmitted(true);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : "微信操作失败");
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function choose() {
    try {
      const path = await api.current.pickDirectory();
      if (path) setCwd(path);
    } catch {
      setError("无法选择工作目录");
    }
  }
  async function connect() {
    let path = cwd;
    if (!path) {
      try {
        path = (await api.current.pickDirectory()) || "";
        if (!path) return;
        setCwd(path);
      } catch {
        setError("无法选择工作目录");
        return;
      }
    }
    await action("login", { cwd: path, notifications, completionReports });
  }
  const configured =
    status &&
    (status.paired ?? Boolean(status.ownerHint)) &&
    !["disconnected", "waiting_scan", "scanned", "need_code"].includes(
      status.state,
    );
  return (
    <>
      <div className="settings-section-heading">
        <div>
          <h2 id="settings-wechat-title">个人微信</h2>
          <p>用手机交代任务，回到总控查看同一份进展。</p>
        </div>
        <span
          className={
            "settings-config-state " +
            (status?.state === "connected" ? "configured" : "")
          }
        >
          {status ? labels[status.state] : "正在读取…"}
        </span>
      </div>
      <div className="settings-info-block wechat-controls">
        <label className="field-label" htmlFor="wechat-cwd">
          微信新任务的工作目录
        </label>
        <div className="wechat-directory">
          <input
            id="wechat-cwd"
            readOnly
            value={cwd}
            title={cwd}
            placeholder="选择本机文件夹"
          />
          <button
            className="button"
            disabled={busy}
            onClick={() => void choose()}
          >
            选择文件夹
          </button>
        </div>
        <p className="field-help">
          默认使用 ACD
          专用目录，可更换。只影响微信新任务，已有任务保留各自目录。
        </p>
        <label className="wechat-notify">
          <input
            type="checkbox"
            checked={notifications}
            onChange={(e) => setNotifications(e.target.checked)}
          />
          同步桌面任务进展
        </label>
        <p className="field-help">
          微信内的提问和任务始终回复；开启后，也同步桌面发起的总控回复、确认问题和任务反馈。
        </p>
        <label className="wechat-notify">
          <input
            type="checkbox"
            checked={completionReports}
            onChange={(event) => setCompletionReports(event.target.checked)}
          />
          推送完成报告与建议
        </label>
        <p className="field-help">
          发往当前扫码绑定的微信，包含任务名、结果摘要和建议，不发送执行日志或文件。仅推送开启后完成的报告。
        </p>
        {configured && (
          <button
            className="button"
            disabled={busy || !cwd}
            onClick={() =>
              void action("configure", {
                cwd,
                notifications,
                completionReports,
              })
            }
          >
            保存微信设置
          </button>
        )}
      </div>
      {(qr ||
        status?.state === "waiting_scan" ||
        status?.state === "scanned" ||
        status?.state === "need_code") && (
        <div className="wechat-pairing">
          <div className="wechat-qr">
            {qr ? (
              <img src={qr} width="216" height="216" alt="微信登录二维码" />
            ) : (
              <span>正在生成二维码…</span>
            )}
          </div>
          <div>
            <h3>{status ? labels[status.state] : "扫码连接"}</h3>
            <p>
              使用个人微信扫码，在手机上确认连接。连接后先发送
              /帮助，收到回复后再开始使用。
            </p>
            <p className="field-help">
              只有扫码绑定者可以调控 ACD。二维码到期后需重新获取。
            </p>
            {status?.state === "need_code" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action("verify", { code });
                  setCode("");
                }}
              >
                <label htmlFor="wechat-code">手机显示的验证码</label>
                <div className="wechat-directory">
                  <input
                    id="wechat-code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={8}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  />
                  <button
                    className="button"
                    disabled={busy || !/^\d{4,8}$/.test(code)}
                  >
                    提交
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
      {(error || readError || status?.error) && (
        <p className="form-error" role="alert">
          {error || readError || status?.error}
        </p>
      )}
      <div className="wechat-actions">
        <button
          className="button primary"
          disabled={busy || !status}
          onClick={() => void connect()}
        >
          {busy
            ? "正在处理…"
            : status?.state === "waiting_scan" ||
                status?.state === "expired" ||
                status?.state === "error"
              ? "重新获取二维码"
              : configured
                ? "重新扫码"
                : "扫码连接微信"}
        </button>
        {(configured || status?.canResume) &&
          ((status?.canResume ?? status?.state === "paused") ? (
            <button
              className="button"
              disabled={busy}
              onClick={() => void action("resume")}
            >
              恢复连接
            </button>
          ) : status?.state === "connected" ||
            status?.state === "connecting" ? (
            <button
              className="button"
              disabled={busy}
              onClick={() => void action("pause")}
            >
              暂停连接
            </button>
          ) : null)}
        {status && status.state !== "disconnected" && (
          <button
            className="button ghost"
            disabled={busy}
            onClick={() => void action("disconnect")}
          >
            断开并移除登录
          </button>
        )}
      </div>
      {status?.state === "connected" && (
        <div className="settings-info-block">
          <div className="settings-info-heading">
            <h3>
              {status.lastSubmissionHasMessageId === false
                ? "微信送达待核对"
                : status.lastReceivedAt && status.lastSubmittedAt
                  ? "已收到消息并提交回复"
                  : "收发待验证"}
            </h3>
            <button
              className="button"
              disabled={busy}
              onClick={() => void action("test")}
            >
              发送测试消息
            </button>
          </div>
          <p className="field-help">
            {status.lastSubmissionHasMessageId === false
              ? "最近一次请求已提交，微信未返回消息编号。可在绑定会话发送 /帮助 检查回复。"
              : "在微信发送 /帮助 后，可测试回传并在手机上确认。"}
          </p>
          {testSubmitted && (
            <p className="field-help" role="status">
              测试消息已提交，请在微信确认收到。
            </p>
          )}
        </div>
      )}
      {status?.ownerHint && (
        <dl className="settings-facts">
          <div>
            <dt>绑定者</dt>
            <dd>{status.ownerHint}</dd>
          </div>
          {status.lastPollAt && (
            <div>
              <dt>最近同步</dt>
              <dd>{new Date(status.lastPollAt).toLocaleString()}</dd>
            </div>
          )}
          {status.lastReceivedAt && (
            <div>
              <dt>最近收到消息</dt>
              <dd>{new Date(status.lastReceivedAt).toLocaleString()}</dd>
            </div>
          )}
          {status.lastSubmittedAt && (
            <div>
              <dt>最近提交反馈</dt>
              <dd>{new Date(status.lastSubmittedAt).toLocaleString()}</dd>
            </div>
          )}
        </dl>
      )}
      {status?.lastIgnoredReason && !status.lastReceivedAt && (
        <p className="field-help">
          已收到但未处理：{status.lastIgnoredReason}
          。请在扫码账号与当前联系人的私聊中发送 /帮助。
        </p>
      )}
      {Boolean(status?.uncertainDeliveries) && (
        <p className="field-help">
          有 {status!.uncertainDeliveries}{" "}
          条反馈未能确认是否提交，未自动重发。请在微信发送 /状态 核对。
        </p>
      )}
      {Boolean(status?.uncertainOperations) && (
        <p className="form-error" role="alert">
          有 {status!.uncertainOperations}{" "}
          条此前操作的结果待核对，没有自动重放，请在总控检查任务。
        </p>
      )}
      <div className="settings-info-block">
        <h3>在微信里怎么用</h3>
        <p>
          直接发文字交代任务，或补充已有要求。指令与自然语言消息共用现有总控和任务。
        </p>
        <dl className="settings-storage-list">
          <div>
            <dt>
              <code>/状态</code>
            </dt>
            <dd>查看最近任务和待处理问题。</dd>
          </div>
          <div>
            <dt>
              <code>/停止 任务编号</code>
            </dt>
            <dd>请求停止，已经产生的文件修改仍会保留。</dd>
          </div>
          <div>
            <dt>
              <code>/回答 问题编号 选项或说明</code>
            </dt>
            <dd>回答澄清或授权问题，原生授权使用给定选项。</dd>
          </div>
          <div>
            <dt>
              <code>/完成 任务编号</code>
            </dt>
            <dd>检查产出之后确认完成。</dd>
          </div>
        </dl>
        <p className="field-help">
          电脑和本地后台需要保持运行。当前只接收绑定者的一对一文字，不读取其他聊天或处理群消息。微信账号是否能完成扫码、收发，仍受平台实际开放情况影响。
        </p>
      </div>
    </>
  );
}
