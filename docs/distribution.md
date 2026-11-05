# 安装与构建分发包

当前版本为 0.1.10 测试版，发布目标为 Mac ARM64 的 DMG、ZIP 和 CLI 包。支持 Agent 优先级、个人记忆和中英文界面；新增历史证据补查及 Codex 隔离核实，修复待检查任务无法结束的问题。安装包在隔离数据目录核验包内 Node、SQLite、原生模块与后台启动、退出流程。

## 安装方式

在 [GitHub Releases](https://github.com/EmberRavager/agent-control-desk/releases) 查看已发布版本。发布后可从对应版本下载 DMG、ZIP 或 CLI 包，并使用随包提供的 SHA256SUMS 核对文件；此前可[从源码构建](#从源码构建)。

Mac 的 DMG 中包含 `Agent Control Desk.app`，复制到 Applications 后打开；ZIP 也包含同一应用。桌面包自带 Electron/Node，不需要另外安装 Node、项目依赖或 TypeScript。当前本机产物仅作 ad-hoc 签名，没有 Developer ID 签名与 Apple 公证，作为测试版提供。

CLI 包为 `agent-control-desk-0.1.10.tgz`，需要 Node.js >=22.13.0 和 npm：

```sh
npm install --global ./agent-control-desk-0.1.10.tgz
acd --help
acd
```

CLI 安装只获取生产依赖，发布包不包含 TypeScript 源码或 `tsx`。执行 Agent 的安装、登录与模型配置仍由其原生工具管理；安装 ACD 不会自动安装或勾选这些 Agent。

普通启动使用同一个正式数据目录，CLI、桌面端与后台服务共用：macOS 为 `~/Library/Application Support/agent-control-desk`，Windows 为 `%LOCALAPPDATA%/agent-control-desk`。源码测试的 `ACD_DATA_DIR` 覆盖不会自动迁移到默认目录；各入口使用不同目录时，任务和对话也会分开。API Key 和微信登录保留在操作系统凭证存储中，其中微信凭证账户按数据目录隔离，迁移数据后需重新登录或单独迁移对应系统凭证。

## 从源码构建

```sh
npm ci
npm test
npm run build
npm run package:dir
npm run package:mac
npm run package:cli
```

Windows 在 Windows 的对应架构上运行 `npm ci`、`npm test` 和 `npm run package:win`，生成每用户 NSIS 安装包，可选择安装位置；卸载配置不删除数据目录。当前 Windows 只有构建配置，尚未执行 Windows 原生构建、安装和运行验收。

每个桌面包必须在对应系统及 CPU 架构上构建。预检会核对 `@napi-rs/keyring` 的目标平台预编译模块，拒绝直接复用另一平台的 `node_modules`。Mac Intel 与 ARM64 分别构建；当前未配置 universal 包。产物位于 `release/`，构建命令均明确禁止自动发布。

仅制作本机 Mac 测试包，可使用以下参数，不使用发布证书或公证服务：

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac -- -c.mac.identity=- -c.mac.notarize=false
```

上面的额外参数经过 npm 脚本转发给 electron-builder；如需直接调用：

```sh
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config electron-builder.cjs --mac --publish never -c.mac.identity=- -c.mac.notarize=false
```

测试安装包通过 GitHub Releases 发布。正式分发仍需完成 Developer ID 签名与 Apple 公证，以及 Windows 构建、签名和安装升级验收。当前没有配置自动更新，CLI 包通过 Release 附件分发。

## GitHub 自动发布

仓库包含分支与 PR 检查工作流，以及独立的 Mac ARM64 测试版发布工作流。发布前更新 `package.json` 与锁文件中的版本，并提交到 GitHub。推送对应 `vX.Y.Z` 标签后，发布工作流会在原生 ARM64 runner 上安装锁定依赖、运行测试、构建 DMG/ZIP 与 CLI 包，并使用隔离数据目录验收包内后台。

全部检查通过后才生成 SHA256SUMS，先上传到草稿 Release，再发布为预发行版。工作流使用本次 GitHub Actions 的仓库令牌，不依赖维护者本机的 `gh` 登录；需要仓库允许工作流写入 Releases。也可从 Actions 手动选择已有版本标签重试。已公开的同名 Release 会拒绝覆盖，需创建新版本。

当前工作流已加入源码，GitHub 托管 runner 的实际构建和附件下载仍需在首次发布时核验。发布完成前，README 仅链接 Releases 页面，不承诺某个附件已经存在。

## 可重复验收

在构建所在的同一 checkout 执行：

```sh
npm run verify:desktop -- "release/mac-arm64/Agent Control Desk.app"
```

Windows 可将参数换成生成的 `release/win-unpacked`。验证脚本核对 ASAR 中的主进程、preload、通知入口、运行时和界面资源是否与当前构建一致，检查无测试或 TypeScript 加载器；再用应用自带 Node，在新临时数据目录启动编译 CLI、后台，做只读扫描并停止服务，核验真实进程已退出。凭证模块只检查导出能否加载，不读取真实 Key 或登录。

该验收不替代窗口点击、系统通知显示、真实账号、Windows 或业务交付验收。CLI 包另用全新临时安装目录、仅生产依赖验证过 `acd --help`、启动后台、doctor 和停止。

## 数据与升级

升级或备份前，先处理正在运行及状态待核对的任务，再运行 `acd service stop`，确认服务结束并退出旧桌面端，然后替换应用。开发版目前仍依靠 CLI 停止后台，桌面内服务控制入口待补齐。停止不会撤销文件修改，未完成任务在下次启动时需核对，不自动重跑。

整体备份数据目录，包含 SQLite、WAL 和 JSONL；不要只复制单个数据库文件。凭证不包含在文件备份中。草稿目前保存于桌面本地存储，源码开发版与新安装包的 Electron 用户目录可能不同，不会自动搬运这些草稿。

## 实现依据

使用 [electron-builder v26 稳定版配置](https://www.electron.build/v26/docs/configuration/) 与 [Electron ASAR 约束](https://www.electronjs.org/docs/latest/tutorial/asar-archives)。UI 保留在 ASAR；独立 Node 后台、CLI 和生产依赖使用真实解包路径，避免将 ASAR 虚拟目录作为子进程 cwd。`@napi-rs/keyring` 使用目标平台 N-API 预编译模块，打包时不做 ABI 重编译。
