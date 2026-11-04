# 开发与 CLI 指南

本页收录开发环境、命令和工程结构。首次使用请从 [中文 README](../README.zh-CN.md) 或 [English README](../README.md) 开始；运行边界和协议见 [架构说明](architecture.md)。

## 环境与启动

需要 Node.js ≥ 22.13.0、npm，以及要接入的原生 Agent。先在原生工具中完成安装、登录与模型配置。

```sh
npm ci
npm run build
npm run desktop
```

后台使用 Node.js 内置的 `node:sqlite`。在最低支持版本中它仍属实验性，在较新版本中为 release candidate，可能输出相应提示。依赖状态见 [Node.js SQLite 文档](https://nodejs.org/api/sqlite.html)；这不代表已经完成跨版本验收。

常用命令：

```sh
npm run daemon       # 单独启动后台
npm run typecheck
npm test
npm run build
```

`npm run ui:dev` 只启动 Vite 界面开发服务器。原生目录选择、凭证提交和后台连接依赖 Electron preload，日常联调使用构建后的桌面端。

普通后台使用真实总控和原生执行适配。注入测试依赖的后台标记为 `environment: "test"`，界面持续显示测试标识。语义评测及其有限覆盖范围见 [路由说明](routing.md)；不要用 Fake 模型或执行端的结果替代真实账号与任务验收。

## 从仓库使用 CLI

不安装全局命令也可以从源码目录运行：

```sh
node apps/cli/acd.mjs --help
node apps/cli/acd.mjs agents scan
node apps/cli/acd.mjs agents add /absolute/path/to/agent
node apps/cli/acd.mjs agents select <扫描返回的Agent编号>
node apps/cli/acd.mjs model configure
node apps/cli/acd.mjs
```

也可在构建后运行 `npm link`，从任意项目目录使用 `acd`。任务默认使用发消息时的当前目录；原生命令和参数以 `acd --help` 为准。

```sh
acd send "梳理这个项目的启动方式，先不要修改文件"
acd agents list
acd send "检查项目，执行中需要追加要求" --agent <Agent编号> --require steer
acd agents default <Agent编号> --project /absolute/path/to/project
acd agents default none  # 清除全局默认；加 --project 清除项目默认
acd tasks
acd sessions
acd schedules
acd inbox
acd stop <任务编号>
acd answer <问题编号> <选项或回答>
acd accept <任务编号>
acd retry <消息编号>
acd service status
acd doctor
```

`send` 立即返回消息接收结果，后续进展继续更新。接收、送达和执行端实际采用要求是不同阶段；编号来自运行记录。常规查询支持 `--json`。

澄清问题可选择任务或自由输入；原生授权请求只接受对应选项。只有尚未进入动作应用阶段的失败消息可以“重新判断”，不能用它重跑可能已经执行的操作。规则见 [消息恢复](message-recovery.md)。

## 桌面联调行为

设置页沿用当前窗口内的模型表单草稿，保存后在页面显示结果；主题选择在下次启动保留。数据页提供真实目录查看与打开入口。模型列表只由用户主动获取，详情见 [配置说明](configuration.md)。

总控对话在处于底部时跟随消息与内容尺寸变化；主动上翻时保留阅读位置并提示回到最新，任务定位不会被自动跟随覆盖。发送失败保留原消息编号供重试，新草稿与旧发送记录分别处理；重开后的未确认记录不会自动发送。执行结束没有文字结果时，仍可检查目录产出后确认完成。

## 后台生命周期与恢复

桌面端会启动或复用本地后台。默认关闭窗口后保留菜单栏或托盘驻留；明确退出桌面端不停止后台任务。使用 `acd service stop` 主动停止后，桌面重连不会自动拉起后台。

源码更新不会热替换正在运行的后台。先处理正在执行及状态待核对的任务，再停止后台、退出旧桌面端并重新启动。关闭窗口或刷新界面不足以更新 Electron main 或后台。

后台重启后，先前运行中、停止中或等待执行端输入的任务进入 `unknown`，占用不会被直接释放，也不会自动接管或重跑。先在原执行端核对；只有人工确认执行已停止后，才可记录结果并解除占用：

```sh
acd recover <任务编号> --stopped
```

该命令本身不检测或停止执行端，也不重新执行任务。停止不会撤销已经发生的文件修改。

## 工程结构

```text
apps/cli/             acd 命令与终端对话
apps/desktop/         Electron main/preload、React 界面、Vite 构建
packages/contracts/   客户端与后台的共享契约
packages/core/        本地服务、路由、分配、状态、存储和执行适配器
tests/                隔离测试与假执行端
docs/                 使用说明、架构、运行边界和验收记录
```

后台独立于窗口运行，桌面通过受限 IPC 访问本机 HTTP/SSE；CLI 连接同一个服务。实现细节见 [架构说明](architecture.md)，模型与数据目录见 [配置说明](configuration.md)。

## 构建、打包与验证

桌面安装包与 CLI 包的命令、目标架构要求、本机测试签名及升级步骤统一见 [安装与分发](distribution.md)，避免在多处维护版本和文件名。

当前验证状态见 [功能状态与交付清单](product-status.md)，真实试用记录见 [试用记录](dogfood-2026-11-03.md)。单元测试、构建、安装包内后台验收和真实窗口/账号验收分别记录，不互相替代。开发与测试使用临时目录、Fake Repository 和脱敏样例，不将凭证或真实业务资料写入仓库。
