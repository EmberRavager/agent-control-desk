import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { listPackage, extractFile } from "@electron/asar";

const app = process.argv[2];
if (!app)
  throw Error("用法：npm run verify:desktop -- <.app 或 win-unpacked 目录>");
const bundle = resolve(app),
  mac = process.platform === "darwin";
if (!mac && process.platform !== "win32")
  throw Error("请在目标 macOS 或 Windows 上验证桌面安装包。");
const contents = mac ? join(bundle, "Contents") : bundle;
const resources = join(contents, mac ? "Resources" : "resources");
const archive = join(resources, "app.asar"),
  unpacked = archive + ".unpacked";
const executable = mac
  ? join(contents, "MacOS", basename(bundle, ".app"))
  : join(bundle, "Agent Control Desk.exe");
const repository = fileURLToPath(new URL("..", import.meta.url));
const entries = listPackage(archive).map((name) => name.replaceAll("\\", "/"));
const metadata = JSON.parse(extractFile(archive, "package.json").toString());
if (
  metadata.name !== "agent-control-desk" ||
  metadata.main !== "apps/desktop/main.cjs"
)
  throw Error("不是预期的 ACD 安装包。");
for (const entry of entries) {
  if (/\/(?:tests|\.env|tsx)(?:\/|\.|$)/.test(entry))
    throw Error("安装包包含不应分发的测试或开发文件：" + entry);
  if (
    /^\/(?:dist\/runtime|dist\/renderer)\/.+\.(?:mjs|js|css|html)$/.test(entry)
  ) {
    const relative = entry.slice(1),
      source = join(repository, relative);
    if (!existsSync(source)) throw Error("构建来源缺失：" + relative);
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    if (digest(readFileSync(source)) !== digest(extractFile(archive, relative)))
      throw Error("安装包与当前构建不一致：" + relative);
  }
}
for (const file of [
  "apps/desktop/main.cjs",
  "apps/desktop/preload.cjs",
  "apps/desktop/notifications.cjs",
  "packages/core/service-launch.cjs",
]) {
  if (!readFileSync(join(repository, file)).equals(extractFile(archive, file)))
    throw Error("安装包入口与当前源码不一致：" + file);
}
const cli = join(unpacked, "dist/runtime/cli.mjs");
const data = mkdtempSync(join(tmpdir(), "acd-package-verify-"));
const options = {
  cwd: dirname(data),
  encoding: "utf8",
  timeout: 20000,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    ACD_DATA_DIR: data,
    ACD_PORT: "0",
  },
};
const run = (args) => execFileSync(executable, args, options);
const command = (args) => run([cli, ...args]);
const native = JSON.parse(
  run([
    "-e",
    `const {Entry}=require(${JSON.stringify(join(unpacked, "node_modules/@napi-rs/keyring"))});console.log(JSON.stringify({node:process.versions.node,sqlite:!!require('node:sqlite').DatabaseSync,nativeVaultLoaded:typeof Entry==='function'}))`,
  ]),
);
if (
  !native.sqlite ||
  !native.nativeVaultLoaded ||
  !command(["--help"]).includes("acd send")
)
  throw Error("编译运行时或原生模块不可用。");
let pid;
try {
  command(["service", "start"]);
  const status = JSON.parse(command(["service", "status", "--json"]));
  pid = status.pid;
  if (!status.running) throw Error("打包后台未启动。");
  const doctor = JSON.parse(command(["doctor"]));
  if (
    doctor.service !== "running" ||
    doctor.agentsSelected !== 0 ||
    doctor.modelConfigured
  )
    throw Error("隔离配置或后台状态不正确。");
  const agents = JSON.parse(command(["agents", "scan", "--json"]));
  if (agents.some((agent) => agent.selected))
    throw Error("扫描不应自动勾选 Agent。");
  console.log(
    JSON.stringify({
      packageFilesVerified: true,
      native,
      compiledCLI: true,
      daemon: doctor.service,
      agentsFound: agents.length,
      isolatedData: data,
    }),
  );
} finally {
  let status;
  try {
    status = JSON.parse(command(["service", "status", "--json"]));
  } catch {}
  if (status?.running) {
    pid ??= status.pid;
    command(["service", "stop"]);
  }
  if (pid) {
    let exited = false;
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          exited = true;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!exited) throw Error("打包后台进程尚未退出。");
    console.log(JSON.stringify({ backendExited: true }));
  }
}
