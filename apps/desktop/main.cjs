const { translate, normalizeLocale } = require("../../packages/i18n/index.cjs");
let locale = "zh-CN";
const t = (source, values) => translate(locale, source, values);
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Notification,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const { DesktopNotifier } = require("./notifications.cjs");
const { spawn } = require("node:child_process");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { serviceLaunch } = require("../../packages/core/service-launch.cjs");
const root = path.resolve(__dirname, "../..");
const rendererFile = path.join(root, "dist/renderer/index.html");
const rendererUrl = pathToFileURL(rendererFile).href;
const dataDir =
  process.env.ACD_DATA_DIR ||
  (process.platform === "darwin"
    ? path.join(os.homedir(), "Library/Application Support/agent-control-desk")
    : process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"),
          "agent-control-desk",
        )
      : path.join(os.homedir(), ".local/share/agent-control-desk"));
let window, descriptor, streamController, connecting;
let notifier,
  tray,
  quitting = false,
  pendingNotice = null;
let backgroundEnabled = true;
let mayStartDaemon = true;
const memoryId = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const allowed = [
  ["GET", /^\/api\/preferences$/],
  ["PUT", /^\/api\/preferences$/],
  ["GET", /^\/api\/memories$/],
  ["POST", /^\/api\/memories$/],
  ["PUT", new RegExp("^/api/memories/" + memoryId + "$")],
  ["POST", new RegExp("^/api/memories/" + memoryId + "/delete$")],
  ["GET", /^\/api\/schedules(?:\/[a-f0-9-]{36}\/runs)?$/],
  ["POST", /^\/api\/schedules(?:\/[a-f0-9-]{36}\/(pause|resume|delete))?$/],
  ["PUT", /^\/api\/schedules\/[a-f0-9-]{36}$/],
  ["GET", /^\/api\/notifications(?:\?before=[a-f0-9]{64})?$/],
  ["GET", /^\/api\/notifications\/[a-f0-9]{64}\/report$/],
  ["PUT", /^\/api\/notifications\/preferences$/],
  ["POST", /^\/api\/notifications\/(read|claim|settle)$/],
  ["GET", /^\/api\/wechat$/],
  [
    "POST",
    /^\/api\/wechat\/(login|verify|pause|resume|disconnect|configure|test)$/,
  ],
  ["GET", /^\/api\/state$/],
  ["GET", /^\/api\/allocation$/],
  ["PUT", /^\/api\/allocation$/],
  ["POST", /^\/api\/reports\/[a-f0-9]{64}\/retry$/],
  ["POST", /^\/api\/observations\/refresh$/],
  ["POST", /^\/api\/observations\/native-[a-f0-9]{24}\/analyze$/],
  ["GET", /^\/api\/skills(?:\/[^/]+)?$/],
  [
    "POST",
    /^\/api\/skills(?:\/scan|\/[^/]+\/(?:trash|translate)|\/trash\/[^/]+\/restore)?$/,
  ],
  ["POST", /^\/api\/agents\/(scan|manual)$/],
  ["PUT", /^\/api\/(agents|model)$/],
  ["POST", /^\/api\/model\/models$/],
  ["POST", /^\/api\/messages$/],
  ["POST", /^\/api\/messages\/[a-f0-9-]{36}\/retry$/],
  ["POST", /^\/api\/tasks\/[A-Za-z0-9_-]+\/(stop|accept|reconcile)$/],
  ["POST", /^\/api\/questions\/[A-Za-z0-9_-]+\/answer$/],
];
async function readDescriptor() {
  const value = JSON.parse(
    await readFile(path.join(dataDir, "runtime.json"), "utf8"),
  );
  if (
    typeof value.url !== "string" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    value.protocol !== 1 ||
    typeof value.token !== "string" ||
    value.token.length < 32
  )
    throw new Error(t("本地服务描述无效"));
  const url = new URL(value.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(t("本地服务描述无效"));
  const response = await fetch(new URL("/api/health", url), {
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(t("本地服务不可用"));
  const health = await response.json();
  if (health.protocol !== 1) throw new Error(t("本地服务版本不兼容"));
  if (health.pid !== value.pid)
    throw new Error(t("本地服务描述已过期，进程身份不匹配"));
  value.capabilities = Array.isArray(health.capabilities)
    ? health.capabilities.filter((item) => typeof item === "string")
    : [];
  return value;
}
async function startDaemon() {
  try {
    descriptor = await readDescriptor();
    mayStartDaemon = false;
    return;
  } catch {}
  if (!mayStartDaemon)
    throw new Error(
      t(
        "本地后台未运行。请运行 acd service start，或退出并重新打开 ACD；已保存任务不会自动重跑。",
      ),
    );
  mayStartDaemon = false;
  // Run the daemon independently of the GUI lifecycle. Credentials stay in the daemon.
  const launch = serviceLaunch({
    root,
    executable: process.execPath,
    packaged: !!app.isPackaged,
  });
  const child = spawn(process.execPath, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  let spawnFailure = null,
    exitCode = null;
  child.on("error", (error) => {
    spawnFailure = error.code || "SPAWN_ERROR";
  });
  child.on("exit", (code) => {
    exitCode = code;
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      descriptor = await readDescriptor();
      return;
    } catch {}
    if (spawnFailure)
      throw new Error(
        t("无法启动本地服务进程（") +
          spawnFailure +
          t("）。请检查 Node 运行时和安装目录。"),
      );
    if (exitCode !== null)
      throw new Error(
        t("本地服务启动后退出（代码 ") +
          exitCode +
          (app.isPackaged
            ? t("）。请检查本地数据目录权限，并退出后重新打开 ACD。")
            : t("）。请运行 npm run daemon 查看诊断。")),
      );
  }
  throw new Error(
    app.isPackaged
      ? t(
          "等待本地服务启动超时。请检查本地数据目录权限，并退出后重新打开 ACD。",
        )
      : t("等待本地服务启动超时。请先运行 npm run daemon 查看启动诊断。"),
  );
}
async function connectDaemon() {
  if (!connecting)
    connecting = startDaemon().finally(() => {
      connecting = null;
    });
  return connecting;
}
function trusted(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== rendererUrl
  )
    throw new Error(t("拒绝非受信任主窗口请求"));
}
async function request(method, resource, body) {
  if (
    typeof method !== "string" ||
    typeof resource !== "string" ||
    !allowed.some(([verb, route]) => verb === method && route.test(resource))
  )
    throw new Error(t("不支持的客户端操作"));
  if (!descriptor) await connectDaemon();
  if (
    resource === "/api/allocation" &&
    (method === "GET" || body?.agentIds !== undefined) &&
    !descriptor.capabilities?.includes("allocation-priority")
  )
    throw new Error(
      t(
        "本地后台版本较旧，尚不支持 Agent 优先级排序。请在任务结束后停止后台并重新打开新版 ACD。",
      ),
    );
  if (
    resource.startsWith("/api/memories") &&
    !descriptor.capabilities?.includes("personal-memory")
  )
    throw new Error(
      t(
        "本地后台版本较旧，尚不支持个人记忆。请在任务结束后停止后台并重新打开新版 ACD。",
      ),
    );
  const requiredCapability =
    resource === "/api/preferences"
      ? "i18n"
      : resource.startsWith("/api/schedules")
        ? "schedules"
        : /^\/api\/messages\/[a-f0-9-]{36}\/retry$/.test(resource)
          ? "routing-retry"
          : resource.startsWith("/api/reports/")
            ? "completion-reports"
            : /^\/api\/observations\/native-[a-f0-9]{24}\/analyze$/.test(
                  resource,
                )
              ? "native-insight"
              : resource === "/api/observations/refresh"
                ? "native-observation"
                : resource.startsWith("/api/notifications")
                  ? resource.endsWith("/report")
                    ? "notification-report-detail"
                    : "notifications"
                  : resource.startsWith("/api/wechat")
                    ? resource === "/api/wechat/test"
                      ? "wechat-test"
                      : body?.completionReports !== undefined
                        ? "wechat-reports"
                        : "wechat"
                    : resource === "/api/model/models"
                      ? "model-catalog"
                      : /^\/api\/skills\/[^/]+\/translate$/.test(resource)
                        ? "skill-translation"
                        : resource === "/api/messages" && body?.clientMessageId
                          ? "message-idempotency"
                          : null;
  if (
    requiredCapability &&
    !descriptor.capabilities?.includes(requiredCapability)
  )
    throw new Error(
      t(
        "本地后台版本较旧，请先处理进行中的任务，再停止后台并重新打开 ACD 加载更新。",
      ),
    );
  if (
    (resource === "/api/allocation" ||
      (resource === "/api/messages" &&
        (body?.targetAgentId !== undefined ||
          body?.requiredCapabilities !== undefined))) &&
    !descriptor.capabilities?.includes("agent-allocation")
  )
    throw new Error(
      t(
        "本地后台版本较旧，尚不支持任务分配约束；请先处理进行中的任务，再停止后台并重新打开 ACD 加载更新。",
      ),
    );
  const response = await fetch(new URL(resource, descriptor.url), {
    method,
    headers: {
      Authorization: `Bearer ${descriptor.token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      typeof value.error === "string" ? value.error : t("本地服务请求失败"),
    );
  if (resource === "/api/preferences" || resource === "/api/state") {
    const next = normalizeLocale(
      resource === "/api/preferences"
        ? value.locale
        : value.preferences?.locale,
    );
    if (next !== locale) {
      locale = next;
      updateTrayMenu();
    }
  }
  return value;
}
async function stream() {
  streamController?.abort();
  streamController = new AbortController();
  const signal = streamController.signal;
  while (!signal.aborted && window && !window.isDestroyed()) {
    try {
      if (!descriptor) await connectDaemon();
      const response = await fetch(new URL("/api/events", descriptor.url), {
        headers: { Authorization: `Bearer ${descriptor.token}` },
        signal,
      });
      if (!response.ok || !response.body) throw new Error(t("进展连接不可用"));
      window.webContents.send("acd:connection", true);
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (
            data &&
            block.split("\n").some((line) => line.trim() === "event: state")
          ) {
            const state = JSON.parse(data);
            const nextLocale = normalizeLocale(state.preferences?.locale);
            if (nextLocale !== locale) {
              locale = nextLocale;
              updateTrayMenu();
            }
            backgroundEnabled =
              state.notifications?.preferences?.background ?? true;
            notifier?.update(state);
            if (window && !window.isDestroyed())
              window.webContents.send("acd:state", state);
          }
        }
      }
    } catch (error) {
      descriptor = null;
      if (!signal.aborted && window && !window.isDestroyed())
        window.webContents.send(
          "acd:error",
          error instanceof Error
            ? error.message
            : t("本地服务连接失败，正在重试。"),
        );
    }
    if (!signal.aborted && window && !window.isDestroyed())
      window.webContents.send("acd:connection", false);
    if (!signal.aborted)
      await new Promise((resolve) => setTimeout(resolve, 1800));
  }
}
function showDesk(target) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (target !== undefined) {
    pendingNotice = target || { inbox: true };
    window.webContents.send("acd:notice-open", pendingNotice);
  }
}
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("打开 ACD"), click: () => showDesk() },
      { label: t("消息中心"), click: () => showDesk(null) },
      { type: "separator" },
      {
        label: t("退出桌面端（后台任务继续）"),
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}
function makeTray() {
  try {
    const image = nativeImage.createFromPath(
      path.join(
        __dirname,
        "assets",
        process.platform === "darwin" ? "trayTemplate.png" : "tray.png",
      ),
    );
    if (process.platform === "darwin") image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip("Agent Control Desk");
    updateTrayMenu();
    tray.on("click", () => showDesk());
  } catch {
    tray = null;
  }
}
if (process.argv?.includes("--diagnose-notifications")) {
  app.whenReady().then(async () => {
    try {
      await require("./notification-diagnostic.cjs").diagnoseNotifications({
        app,
        Notification,
      });
    } catch {
      console.log(
        JSON.stringify({ stage: "error", message: t("无法完成通知诊断") }),
      );
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    showDesk();
  });
  app.on("before-quit", () => {
    quitting = true;
    notifier?.close();
  });
  app.on("activate", () => showDesk());
  app.whenReady().then(async () => {
    if (process.platform === "win32") {
      app.setAppUserModelId(
        app.isPackaged
          ? "io.github.emberravager.agentcontroldesk"
          : process.execPath,
      );
      app.setToastActivatorCLSID?.("{31B855E2-8114-4B4E-9E39-4F3F2073A61D}");
    }
    makeTray();
    notifier = new DesktopNotifier({
      Notification,
      request,
      getWindow: () => window,
      onOpen: (target) => showDesk(target),
      backgroundAvailable: () => Boolean(tray),
      badge: (count) => {
        app.setBadgeCount?.(count);
        tray?.setToolTip(
          count
            ? t("ACD · {count} 条未读消息", { count })
            : "Agent Control Desk",
        );
      },
    });
    window = new BrowserWindow({
      width: 1180,
      height: 840,
      minWidth: 760,
      minHeight: 580,
      title: "Agent Control Desk",
      backgroundColor: "#f7f8fb",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.setMenuBarVisibility(false);
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-frame-navigate", (event) =>
      event.preventDefault(),
    );
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    ipcMain.handle("acd:request", async (event, method, resource, body) => {
      trusted(event);
      return request(method, resource, body);
    });
    ipcMain.handle("acd:notice-status", (event) => {
      trusted(event);
      return notifier.status();
    });
    ipcMain.handle("acd:notice-test", (event) => {
      trusted(event);
      return notifier.test();
    });
    ipcMain.handle("acd:notice-target", (event) => {
      trusted(event);
      const target = pendingNotice;
      pendingNotice = null;
      return target;
    });
    ipcMain.handle("acd:notice-settings", async (event) => {
      trusted(event);
      const target =
        process.platform === "darwin"
          ? "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
          : process.platform === "win32"
            ? "ms-settings:notifications"
            : null;
      if (!target) throw Error(t("请在系统设置中打开通知选项"));
      await shell.openExternal(target);
    });
    ipcMain.handle("acd:local-info", (event) => {
      trusted(event);
      return {
        dataDirectory: dataDir,
        version: app.isPackaged
          ? app.getVersion()
          : require("../../package.json").version,
      };
    });
    ipcMain.handle("acd:data-folder", async (event) => {
      trusted(event);
      const error = await shell.openPath(dataDir);
      if (error) throw new Error(t("无法打开本地数据目录"));
    });
    ipcMain.handle("acd:directory", async (event) => {
      trusted(event);
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle("acd:executable", async (event) => {
      trusted(event);
      const result = await dialog.showOpenDialog(window, {
        properties: ["openFile"],
        title: t("选择 Agent 可执行程序"),
      });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle("acd:skill-folder", async (event, id) => {
      trusted(event);
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error(t("无效技能编号"));
      const detail = await request(
        "GET",
        "/api/skills/" + encodeURIComponent(id),
      );
      if (
        !detail?.skill?.path ||
        path.basename(detail.skill.path) !== "SKILL.md"
      )
        throw new Error(t("技能路径无效"));
      shell.showItemInFolder(detail.skill.path);
    });
    ipcMain.on("acd:subscribe", (event) => {
      try {
        trusted(event);
        void stream();
      } catch {
        /* Ignore untrusted senders without touching an active connection. */
      }
    });
    window.on("close", (event) => {
      if (!quitting && backgroundEnabled && tray) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on("closed", () => {
      streamController?.abort();
      window = null;
    });
    try {
      await window.loadFile(rendererFile);
    } catch {
      dialog.showErrorBox(
        t("无法打开 ACD 界面"),
        app.isPackaged
          ? t("应用界面文件不完整，请重新安装 ACD。")
          : t(
              "没有找到可加载的桌面界面。请先在项目目录运行 npm run build，再运行 npm run desktop。",
            ),
      );
      window?.close();
    }
  });
  app.on("window-all-closed", () => {
    tray?.destroy();
    app.quit();
  });
}
