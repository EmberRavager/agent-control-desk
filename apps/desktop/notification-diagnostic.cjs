const { DesktopNotifier } = require("./notifications.cjs");
const { mkdtempSync, mkdirSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { serviceLaunch } = require("../../packages/core/service-launch.cjs");

// Explicit local diagnostic. External sessions and real WeChat are excluded.
async function diagnoseNotifications({ app, Notification }) {
  let runtimeApp, expectedMessageId, noticeId;
  const notifier = new DesktopNotifier({
    Notification,
    getWindow: () => null,
    request: async (method, path, body) => {
      const response = await fetch(new URL(path, runtimeApp.descriptor.url), {
        method,
        headers: {
          Authorization: "Bearer " + runtimeApp.descriptor.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Error("Diagnostic request failed");
      return response.json();
    },
    onOpen: (target) =>
      console.log(
        JSON.stringify({
          stage: "clicked",
          ...(expectedMessageId
            ? { targetVerified: target?.messageId === expectedMessageId }
            : {}),
        }),
      ),
  });
  console.log(
    JSON.stringify({
      stage: "ready",
      packaged: app.isPackaged,
      supported: Notification.isSupported(),
    }),
  );
  if (!Notification.isSupported()) throw Error("Unsupported notifications");
  try {
    if (process.argv.includes("--with-task")) {
      const launch = serviceLaunch({
        root: resolve(__dirname, "../.."),
        executable: process.execPath,
        compiled: true,
        packaged: app.isPackaged,
      });
      const { startServer } = await import(
        pathToFileURL(launch.args.at(-1)).href
      );
      const directory = mkdtempSync(join(tmpdir(), "acd-notice-real-task-")),
        cwd = join(directory, "sample-project");
      mkdirSync(cwd);
      runtimeApp = await startServer({
        directory,
        port: 0,
        nativeRead: async () => ({
          state: "connected",
          source: "runtime-api",
          message: "External observation excluded in diagnostic",
          sessions: [],
        }),
      });
      await runtimeApp.runtime.configure({
        providerId: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen3.5:4b-q4_K_M",
      });
      const agents = await runtimeApp.runtime.scan(),
        codex = agents.find(
          (a) => a.kind === "codex" && a.available && a.supported !== false,
        );
      if (!codex) throw Error("No available Codex");
      await runtimeApp.runtime.select([codex.id]);
      runtimeApp.runtime.receive(
        "请在当前目录创建 ACD_NOTICE_TEST.txt，内容严格为 ACD notification OK。只操作此文件，不读取其他目录，不联网。完成后简短报告。",
        cwd,
      );
      const deadline = Date.now() + 120000;
      let snapshot;
      while (Date.now() < deadline) {
        snapshot = runtimeApp.runtime.snapshot();
        const task = snapshot.tasks[0];
        if (snapshot.questions.some((q) => !q.resolved))
          throw Error("Native approval required; not automatically answered");
        if (task && ["failed", "unknown", "cancelled"].includes(task.status))
          throw Error("Task not completed");
        const message = snapshot.messages.find(
          (m) => m.completion?.status === "ready",
        );
        if (message) {
          expectedMessageId = message.id;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (
        !expectedMessageId ||
        readFileSync(join(cwd, "ACD_NOTICE_TEST.txt"), "utf8").trim() !==
          "ACD notification OK"
      )
        throw Error("Acceptance failed");
      const notice = snapshot.notifications.items.find(
        (n) => n.messageId === expectedMessageId,
      );
      if (!notice) throw Error("Missing completion notice");
      noticeId = "acd-" + notice.id;
      console.log(
        JSON.stringify({
          stage: "task-completed",
          realAgent: "codex",
          artifactVerified: true,
          reportReady: true,
          directory,
        }),
      );
      notifier.update(snapshot);
      await notifier.flush();
      console.log(
        JSON.stringify({
          stage: "persisted-outcome",
          outcome: runtimeApp.runtime
            .snapshot()
            .notifications.items.find((n) => n.id === notice.id)?.desktop,
        }),
      );
    } else {
      await notifier.test();
      noticeId = notifier.lastTestId;
    }
    const result = notifier.status();
    console.log(JSON.stringify({ stage: "native-result", ...result }));
    if (result.lastResult !== "submitted") process.exitCode = 1;
    if (process.platform === "darwin" && Notification.getHistory) {
      let delivered = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        const history = await Notification.getHistory();
        delivered = history.some((item) => item.id === noticeId);
        if (delivered) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      console.log(JSON.stringify({ stage: "delivery-check", delivered }));
      if (!delivered) process.exitCode = 1;
      if (delivered) await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  } finally {
    notifier.close();
    await runtimeApp?.close();
  }
}
module.exports = { diagnoseNotifications };
