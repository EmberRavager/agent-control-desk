import React, { useEffect, useRef, useState } from "react";
import type {
  DesktopNoticeStatus,
  NoticePreferences,
} from "../../packages/contracts/notifications.js";
interface Props {
  active: boolean;
  preferences?: NoticePreferences;
  save: (preferences: NoticePreferences) => Promise<void>;
  getStatus: () => Promise<DesktopNoticeStatus>;
  test: () => Promise<DesktopNoticeStatus>;
  openSystem: () => Promise<void>;
  onWechat: () => void;
}
export default function NotificationSettings(props: Props) {
  const [native, setNative] = useState<DesktopNoticeStatus | null>(null),
    [busy, setBusy] = useState(false),
    [testing, setTesting] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    if (!props.active) return;
    let live = true;
    const load = () =>
      current.current
        .getStatus()
        .then((value) => {
          if (live) setNative(value);
        })
        .catch(() => {
          if (live) setError("无法读取桌面提醒组件，请重新打开客户端后重试。");
        });
    void load();
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
  }, [props.active]);
  async function change(key: keyof NoticePreferences, value: boolean) {
    if (!props.preferences || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await props.save({ ...props.preferences, [key]: value });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "提醒设置未能保存");
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setTesting(true);
    setError("");
    try {
      setNative(await props.test());
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法发起测试通知");
    } finally {
      setTesting(false);
    }
  }
  const choices: [keyof NoticePreferences, string, string][] = [
    [
      "desktop",
      "桌面通知",
      "在 ACD 处于后台时提醒；前台使用时只记录到消息中心。",
    ],
    ["sound", "提醒声音", "实际声音仍由系统通知和专注模式设置决定。"],
    ["details", "显示任务名称和摘要", "关闭时，系统通知仅显示提醒类型。"],
    [
      "background",
      "关闭窗口后继续接收提醒",
      "保留托盘或菜单栏入口；可从菜单明确退出桌面端。",
    ],
  ];
  return (
    <>
      <div className="settings-section-heading">
        <div>
          <h2 id="settings-notifications-title">消息提醒</h2>
          <p>重要进展及时知道，普通进度安静更新。</p>
        </div>
        {saved && (
          <span className="settings-config-state configured" role="status">
            已保存
          </span>
        )}
      </div>
      {!props.preferences && (
        <p className="form-error">
          本地后台尚无消息提醒能力，请处理进行中的任务后重启 ACD。
        </p>
      )}
      <div className="notification-toggles">
        {choices.map(([key, title, description]) => (
          <label className="notification-toggle" key={key}>
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            <input
              type="checkbox"
              checked={props.preferences?.[key] ?? false}
              disabled={!props.preferences || busy}
              onChange={(e) => void change(key, e.target.checked)}
            />
          </label>
        ))}
      </div>
      <div className="settings-info-block">
        <h3>提醒哪些进展</h3>
        <div className="notification-categories">
          {(
            [
              ["attention", "需要我处理"],
              ["result", "结果待检查"],
              ["error", "失败、阻塞或状态待核对"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={props.preferences?.[key] ?? false}
                disabled={!props.preferences || busy}
                onChange={(e) => void change(key, e.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
        <p className="field-help">
          这些选项控制桌面弹窗。消息中心仍保留全部关键进展；重复快照和逐字输出不会反复提醒。
        </p>
      </div>
      <div className="settings-info-block">
        <div className="settings-info-heading">
          <h3>系统通知</h3>
          <span className="small">
            {!native
              ? "正在检查…"
              : !native.supported
                ? "当前系统不支持"
                : native.lastResult === "failed"
                  ? "上次提交失败"
                  : native.lastResult === "submitted"
                    ? "系统已接收"
                    : "尚未验证显示"}
          </span>
        </div>
        <p className="field-help">
          应用无法据此确认当前系统授权。请发送一次测试，并在系统设置中检查通知权限和专注模式。
        </p>
        <div className="row">
          <button
            className="button"
            disabled={!native?.supported || testing}
            onClick={() => void test()}
          >
            {testing ? "正在测试…" : "发送测试通知"}
          </button>
          {native?.canOpenSettings && (
            <button
              className="button ghost"
              onClick={() =>
                void props
                  .openSystem()
                  .catch(() =>
                    setError("无法打开系统通知设置，请手动前往系统设置。"),
                  )
              }
            >
              系统通知设置
            </button>
          )}
        </div>
        {native?.error && (
          <p className="form-error" role="alert">
            {native.error}
          </p>
        )}
        {native && !native.backgroundAvailable && (
          <p className="field-help">
            当前托盘不可用，关闭窗口将退出桌面端；应用内记录和已启用的微信通道仍由后台保留。
          </p>
        )}
      </div>
      <div className="settings-info-block">
        <div className="settings-info-heading">
          <h3>微信提醒</h3>
          <button className="button ghost" onClick={props.onWechat}>
            管理个人微信
          </button>
        </div>
        <p>
          已连接的微信可同步总控回复、确认问题和任务反馈，在个人微信页面单独控制。
        </p>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
