import React, { useEffect, useRef, useState } from "react";
import type { ModelCatalog } from "../../packages/contracts/providers.js";
import type {
  ModelConfig,
  AgentConnection,
  AllocationSettings as AllocationPreferences,
} from "../../packages/contracts/index.js";
import NotificationSettings from "./NotificationSettings.js";
import AllocationSettings from "./AllocationSettings.js";
import type {
  NoticePreferences,
  DesktopNoticeStatus,
} from "../../packages/contracts/notifications.js";
import WeChatSettings from "./WeChatSettings.js";
import ModelSettings, {
  type SettingsInput,
  type CatalogInput,
} from "./ModelSettings.js";
export interface LocalInfo {
  dataDirectory: string;
}
interface Props {
  agents: AgentConnection[];
  allocationSettings?: AllocationPreferences;
  active: boolean;
  noticePreferences?: NoticePreferences;
  saveNotices: (input: NoticePreferences) => Promise<void>;
  getNoticeStatus: () => Promise<DesktopNoticeStatus>;
  testNotice: () => Promise<DesktopNoticeStatus>;
  openNoticeSettings: () => Promise<void>;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  pickDirectory: () => Promise<string | null>;
  config: ModelConfig | null;
  ready: boolean;
  connected: boolean;
  theme: "light" | "dark";
  onTheme: (value: "light" | "dark") => void;
  save: (input: SettingsInput) => Promise<void>;
  loadModels: (input: CatalogInput) => Promise<ModelCatalog>;
  getLocalInfo: () => Promise<LocalInfo>;
  openDataDirectory: () => Promise<void>;
  onBack: () => void;
  returnLabel: string;
  onOpenSidebar: () => void;
}
type Section =
  "allocation" | "model" | "wechat" | "notifications" | "appearance" | "local";
const sections: { id: Section; label: string }[] = [
  { id: "model", label: "模型接入" },
  { id: "allocation", label: "任务分配" },
  { id: "wechat", label: "个人微信" },
  { id: "notifications", label: "消息提醒" },
  { id: "appearance", label: "外观" },
  { id: "local", label: "本地服务与数据" },
];
export default function Settings(props: Props) {
  const [section, setSection] = useState<Section>("model");
  const [local, setLocal] = useState<LocalInfo | null>(null);
  const [localError, setLocalError] = useState("");
  const [opening, setOpening] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    if (props.active) title.current?.focus();
  }, [props.active]);
  useEffect(() => {
    if (section !== "local") return;
    let live = true;
    current.current
      .getLocalInfo()
      .then((info) => {
        if (live) {
          setLocal(info);
          setLocalError("");
        }
      })
      .catch(() => {
        if (live) setLocalError("无法获取数据目录，请重新打开客户端后重试。");
      });
    return () => {
      live = false;
    };
  }, [section]);
  async function openDirectory() {
    setOpening(true);
    setLocalError("");
    try {
      await props.openDataDirectory();
    } catch {
      setLocalError("无法打开数据目录，请检查本地文件夹是否存在。");
    } finally {
      setOpening(false);
    }
  }
  return (
    <>
      <header className="topbar settings-topbar">
        <div className="row">
          <button
            className="icon mobile-toggle"
            aria-label="打开任务侧栏"
            onClick={props.onOpenSidebar}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 tabIndex={-1} ref={title}>
            设置
          </h1>
        </div>
        <button className="button ghost settings-back" onClick={props.onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m10 6-6 6 6 6M4 12h16" />
          </svg>
          返回{props.returnLabel}
        </button>
      </header>
      <div className="settings-scroll">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            <span className="settings-nav-label">偏好与连接</span>
            {sections.map((item) => (
              <button
                key={item.id}
                aria-current={section === item.id ? "page" : undefined}
                aria-controls={"settings-" + item.id}
                onClick={() => setSection(item.id)}
              >
                {item.label}
                {item.id === "model" && !props.config && (
                  <span className="settings-nav-dot" aria-label="待配置" />
                )}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            <section
              className="settings-panel"
              id="settings-model"
              hidden={section !== "model"}
              aria-labelledby="settings-model-title"
            >
              <div className="settings-section-heading">
                <div>
                  <h2 id="settings-model-title">总控模型</h2>
                  <p>理解你的消息，判断任务归属，再分配给 Agent。</p>
                </div>
                <span
                  className={
                    "settings-config-state " +
                    (props.config ? "configured" : "")
                  }
                >
                  {props.config ? "配置已保存" : "待配置"}
                </span>
              </div>
              {props.ready ? (
                <ModelSettings
                  config={props.config}
                  save={props.save}
                  loadModels={props.loadModels}
                />
              ) : (
                <p className="field-help" role="status">
                  正在读取本地配置…
                </p>
              )}
            </section>
            <section
              className="settings-panel"
              id="settings-allocation"
              hidden={section !== "allocation"}
              aria-labelledby="settings-allocation-title"
            >
              <AllocationSettings
                active={props.active && section === "allocation"}
                agents={props.agents}
                preferences={props.allocationSettings}
                request={props.request}
                pickDirectory={props.pickDirectory}
              />
            </section>
            <section
              className="settings-panel"
              id="settings-wechat"
              hidden={section !== "wechat"}
              aria-labelledby="settings-wechat-title"
            >
              <WeChatSettings
                active={props.active && section === "wechat"}
                request={props.request}
                pickDirectory={props.pickDirectory}
              />
            </section>
            <section
              className="settings-panel"
              id="settings-notifications"
              hidden={section !== "notifications"}
              aria-labelledby="settings-notifications-title"
            >
              <NotificationSettings
                active={props.active && section === "notifications"}
                preferences={props.noticePreferences}
                save={props.saveNotices}
                getStatus={props.getNoticeStatus}
                test={props.testNotice}
                openSystem={props.openNoticeSettings}
                onWechat={() => setSection("wechat")}
              />
            </section>
            <section
              className="settings-panel"
              id="settings-appearance"
              hidden={section !== "appearance"}
              aria-labelledby="settings-appearance-title"
            >
              <div className="settings-section-heading">
                <div>
                  <h2 id="settings-appearance-title">外观</h2>
                  <p>选择你习惯的工作界面。</p>
                </div>
              </div>
              <div className="theme-options" role="group" aria-label="界面主题">
                {(["light", "dark"] as const).map((value) => (
                  <button
                    key={value}
                    className={
                      "theme-option " + (props.theme === value ? "chosen" : "")
                    }
                    aria-pressed={props.theme === value}
                    onClick={() => props.onTheme(value)}
                  >
                    <span
                      className={"theme-sample theme-sample-" + value}
                      aria-hidden="true"
                    >
                      <span className="theme-sample-rail">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="theme-sample-body">
                        <i />
                        <i />
                        <i />
                      </span>
                    </span>
                    <span className="theme-option-label">
                      <strong>{value === "light" ? "浅色" : "深色"}</strong>
                      <span>{props.theme === value ? "已选择" : "选择"}</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="field-help theme-help">
                立即生效，下次打开仍会保留。深色使用接近黑色的中性背景。
              </p>
            </section>
            <section
              className="settings-panel"
              id="settings-local"
              hidden={section !== "local"}
              aria-labelledby="settings-local-title"
            >
              <div className="settings-section-heading">
                <div>
                  <h2 id="settings-local-title">本地服务与数据</h2>
                  <p>了解后台如何运行，以及记录保存在哪里。</p>
                </div>
              </div>
              <div className="settings-info-block">
                <h3>后台运行</h3>
                <dl className="settings-facts">
                  <div>
                    <dt>进展连接</dt>
                    <dd className={props.connected ? "settings-connected" : ""}>
                      <span
                        className={"dot " + (!props.connected ? "amber" : "")}
                      />
                      {props.connected ? "已连接" : "未连接，正在重试"}
                    </dd>
                  </div>
                </dl>
                <p>
                  后台会跟进任务。启用“关闭窗口后继续接收提醒”时，桌面端保留在托盘或菜单栏；电脑休眠或关机期间，任务无法持续运行。
                </p>
                <p className="field-help">
                  需要停止后台时，可在终端运行 <code>acd service stop</code>
                  。停止后，未完成的执行需要核对状态。
                </p>
              </div>
              <div className="settings-info-block">
                <div className="settings-info-heading">
                  <h3>数据目录</h3>
                  <button
                    className="button"
                    disabled={!local || opening}
                    onClick={() => void openDirectory()}
                  >
                    {opening ? "正在打开…" : "打开文件夹"}
                  </button>
                </div>
                <code className="settings-directory">
                  {local?.dataDirectory ||
                    (localError ? "数据目录暂不可用" : "正在读取目录…")}
                </code>
                {localError && (
                  <p className="form-error" role="alert">
                    {localError}
                  </p>
                )}
                <dl className="settings-storage-list">
                  <div>
                    <dt>
                      对话记录 <code>JSONL</code>
                    </dt>
                    <dd>保存总控对话，便于保留与查阅历史。</dd>
                  </div>
                  <div>
                    <dt>
                      任务与配置 <code>SQLite</code>
                    </dt>
                    <dd>保存任务状态、Agent 接入选择和非敏感配置。</dd>
                  </div>
                  <div>
                    <dt>API Key 与微信登录</dt>
                    <dd>分别保存在操作系统凭证存储中，不写入对话日志。</dd>
                  </div>
                </dl>
                <details className="settings-explanation">
                  <summary>如何备份</summary>
                  <p>
                    先停止后台，再整体复制数据目录。正在运行的 SQLite
                    可能有额外日志文件，不应只复制单个数据库文件。这些凭证不包含在备份中，换电脑后需要重新配置或扫码。
                  </p>
                </details>
              </div>
              <div className="settings-info-block">
                <h3>模型会收到哪些内容</h3>
                <p>
                  总控理解消息时，会将相关对话与任务信息发送给你配置的模型服务。执行
                  Agent
                  按各自的配置处理任务。开启个人微信同步后，相应回复与任务反馈也会发送给微信绑定者。
                </p>
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
