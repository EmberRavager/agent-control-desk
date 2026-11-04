# ACD MVP 架构

本文描述当前 MVP 本地测试版，区分已经接入的机制和仍待验证的能力。

## 运行边界

```text
React renderer ── 受限 preload IPC ── Electron main ─┐
                                                   ├─ 本机 HTTP / SSE ── Node.js 后台服务
acd CLI ────────────────────────────────────────────┘                         │
                                                   总控模型 ← 路由与校验 → Agent 适配器
                                                                             │
                                                                  本机 Codex / Claude Code / OpenCode / Pi
```

后台独立于 GUI 存活，CLI 不依赖 Electron 窗口。Electron renderer 禁用 Node integration，开启 context isolation 与 sandbox；文件选择和 API 请求经受限 preload 操作，客户端认证 token 保留在 main 进程。窗口阻止跳转、弹出窗口和默认权限授予。

本机服务只监听 `127.0.0.1`，默认端口 `4317`。服务描述 `runtime.json` 含地址、随机 token、PID、协议版本 `1` 和可选能力列表 `capabilities`；health 返回同样的服务能力。新增模型目录和幂等消息操作在能力缺失时拒绝提交，并提示先处理任务再重启后台，避免客户端与旧后台不匹配。CLI 校验描述、进程存活、服务版本和认证接口。后台用锁文件约束单实例，API 使用 Bearer token，并拒绝浏览器 Origin 请求。配置 Key 从用户主动输入经本机服务交给系统凭证存储，状态快照只暴露 `hasKey`。

这套边界保护本机客户端通信，不是对同一操作系统账户下其他恶意程序的隔离沙箱。

桌面设置作为独立工作区页面呈现，复用现有模型配置接口；切换设置分类或暂时返回总控不会丢失本次窗口内的表单草稿。外观偏好由 renderer 的本地存储保存。数据目录信息与打开操作经受信任主窗口的专用 IPC 获取，renderer 不能提供任意路径；不向 renderer 返回本机服务 token 或 Key。

## 消息与总控

普通后台使用真实模型和原生执行适配，注入验收依赖的后台以 `environment: "test"` 标记并在 UI 顶部持续显示。完整规则和真实案例边界见 [路由说明](routing.md)。

`POST /api/messages` 校验并保存用户消息后立即返回 `202`，随后异步调用独立总控模型。多条消息可以同时处于理解和执行阶段。

客户端为每条新消息生成 UUID `clientMessageId`；桌面端重试复用该 ID。后台按完整日志索引检查用户消息、正文、规范化工作目录及目标任务：相同请求返回已有收据，不重复路由；同一 ID 改变内容则拒绝。检查覆盖最近 200 条之外的消息并跨服务重启保留。该机制避免重复接收，不会自动恢复重启前未完成的模型理解或执行；桌面草稿和未确认发送记录按本地数据目录隔离持久化，重开不自动发送；见 [消息恢复](message-recovery.md)。

总控模型由共享服务商目录解析，支持 OpenAI 兼容 `/chat/completions` 和 Anthropic 原生 `/messages` 协议。服务商提供接口与建议模型，模型 ID 和高级接口地址仍可编辑；自定义接入可以明确选择协议。Anthropic 使用 `x-api-key` 和结构化 JSON Schema 输出，OpenAI 兼容接口使用 Bearer Key 和 JSON 模式（本机 Ollama 使用严格 JSON Schema，关闭推理并固定温度以稳定结构），两者最终都通过完整本地 Zod 校验。接口请求拒绝重定向，防止 Key 随重定向流向其他来源。保存配置不会调用模型或验证账号权限。

服务商目录供 CLI、renderer 和后台共同使用。模型列表由 `POST /api/model/models` 发起，后台校验服务商、协议和地址后请求 `GET /models`。它是只读发现流程，不保存草稿 Key 或模型配置，也不调用生成接口。凭证只来自本次主动填写，或同来源的已保存配置；不能因填写另一来源而隐式复用系统中的其他 Key。请求拒绝重定向，设置超时、响应体和模型数量上限；原生 Anthropic 列表按游标读取，硅基流动增加对话模型过滤。UI 显示参考型号或远端结果的来源，支持搜索与任意模型 ID，过期的异步结果不会覆盖切换后的服务商。

本机 Ollama、LM Studio 的无 Key 模式不访问系统凭证存储，状态如实保存 `hasKey: false`；只有这两个明确的本机服务预设且接口在 loopback 时才允许免 Key。MiniMax 对话接口未使用未声明的 JSON 模式参数，启用 `reasoning_split` 后通过提示词请求 JSON，仍须通过完整本地校验。

新增预设与目录接口参考：[Kimi](https://platform.kimi.com/docs/get-api-key)、[智谱 OpenAI 兼容](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)、[MiniMax](https://platform.minimax.cn/docs/api-reference/text-chat-openai)、[Gemini](https://ai.google.dev/gemini-api/docs/openai)、[硅基流动模型列表](https://api-docs.siliconflow.cn/docs/api/models-get)、[Ollama](https://docs.ollama.com/api/openai-compatibility)、[LM Studio](https://lmstudio.ai/docs/developer/openai-compat)。预设与参考型号需要随官方接口变化维护，远端列表仍需用户实际权限验证。上下文包括已选择 Agent、任务目标/状态/版本、待处理问题和近期总控对话。模型返回 JSON 决策，由 Zod 校验后交给运行时执行。新建动作中的 agentId 仅为模型建议，本地分配函数执行明确指定、项目内排序、全局排序、唯一候选、模型建议的优先级，并检查必要协议能力；记录本地分配原因。消息中的 targetAgentId/requiredCapabilities 贯穿幂等、重试和澄清，已有任务仍保留原执行者。设置接口及边界见 [执行者分配](routing.md#执行者分配)。当前动作集合：

| 动作               | 行为                                                           |
| ------------------ | -------------------------------------------------------------- |
| `create`           | 创建任务；执行者必须已选择且可用，工作目录必须等于当前输入目录 |
| `supplement`       | 校验任务版本，保存更正，向支持中途追加的执行端送达             |
| `stop`             | 校验任务版本，请求停止并等待执行端结果                         |
| `status`           | 从真实状态汇总当前进展                                         |
| `clarify`          | 保存澄清问题，等待用户回答后结合原消息再次理解                 |
| `schedule_create`  | 按明确规则创建定时计划，目录绑定当前输入，不立即执行任务       |
| `schedule_control` | 按上下文版本暂停、恢复或删除指定计划                           |
| `schedule_status`  | 从持久化计划汇总时间与最近触发记录                             |

澄清问题支持自由文字纠正，并通过完整消息索引取回原输入；重新接收失败时保留问题供重试。原生授权只接受给定选项，提交期间阻止重复点击。

指定任务只确定消息目标，不能把“停止”“查询”等控制意图变成普通补充。模型故障或输出无效时，消息仍保留，但不会凭空降级为新建任务或自动重试。

同一任务使用 `revision` 防止旧的模型决策覆盖更新后的要求。补充要求会使旧问题失效。消息接受、向执行端送达和执行端实际采用是不同事实；适配器的送达成功不被宣传为业务结果已经实现。

当前总控仍是有限动作集的开发实现，尚未证明能理解所有自然语言指代、复杂改派或任意长期任务。应使用实际案例持续评估。

## 任务执行与资源

任务使用独立的 ACD ID，原生 `sessionId` 和 `turnId` 另行保存。任务生命周期包含等待执行、执行中、等待输入、待检查、完成、停止中、已停止、失败和结果待确认等状态；并非每个状态都能由每个适配器产生。

普通任务和定时任务共用启动检查。ACD 执行或已观测到的原生 Codex 正在执行、等待输入时，同一真实目录及其父子目录的新任务保持排队，互不包含的目录可以并行。原生占用释放后，运行时会重新检查队列和原工作目录。保护范围取决于观测覆盖的会话和最近一次轮询，原生客户端仍能独立启动执行。详见[原生会话观测](native-observation.md)。

请求停止不会撤销已经产生的修改。没有原连接或无法确认停止结果时，保留 `unknown`，不假装取消成功。服务退出或重启后，原运行任务也进入待确认状态；当前没有自动核对、自动接管或自动恢复执行机制。`unknown` 资源不会被简单释放后盲目重跑。用户在原执行端核实已经停止后，可以显式运行 `acd recover <任务编号> --stopped`，记录人工核对结果并释放资源；该操作不执行自动检测、停止或重跑。

执行端报告正常结束后进入 `review`，用户检查并确认后才进入 `completed`。结果文本是执行反馈，不是独立验证通过的证据。

OpenCode 通过固定版本 `@agentclientprotocol/sdk` 2.4.0 使用 ACP v1；依赖在启用该适配时加载。Pi 使用原生 JSONL RPC，按会话层 `agent_settled` 判断最终结束，不把底层 `agent_end` 当作完成。协议输入按字节缓冲，以 LF 分隔，每条最多 4 MiB；断连、超时或异常结束保留待核对。授权选项保存原生 ID 映射与显示文案，普通输入单独标为 `input`，过期和终止会解决旧问题；迟到的停止或回答错误不能覆盖已经确认的终态。Codex 通过真实 thread/turn 标识隔离事件，轮次开始确认后才发送追加或停止；连接中的停止请求保留至句柄就绪。Claude 只采用主执行结果。明确证明尚未提交任务的失败可以释放资源，执行后断连仍保留未知占用。详见 [执行适配器](agent-adapters.md)。

## 定时任务

`packages/contracts/schedules.ts` 定义单次、分钟间隔、每日和每周规则；每日与每周保存明确 IANA 时区。计划与触发记录复用 SQLite 实体存储，本机服务负责生命周期，CLI、桌面和总控动作共同访问同一计划，不依赖 renderer 存活。API 及客户端以 `schedules` capability 识别后台版本。

触发产生普通 ACD 任务，复用现有执行适配器、目录资源保护、授权问题与结果汇报。计划 ID、触发 ID 和 Task ID 分开保存；触发记录关联 Task，不把调度成功等同业务完成。编辑仅影响未来触发，暂停或删除不会停止已创建任务。

调度不批量补跑离线期间错过的时间；重启时推进至未来并保留记录。同计划前轮仍在排队、执行、等输入、阻塞、停止中或状态未知时跳过本轮。重启遗留未知执行仍需人工核对，不自动重跑。后台需运行且电脑唤醒，当前没有云端代跑和系统自启动保证。具体时区、夏令时、CLI、接口和验证边界见 [定时任务](schedules.md)。

## 结果汇报

执行正常结束后，通过现有 Store 的 `completion-jobs` 与稳定总控消息 ID 串行生成一次结果摘要及自动建议，失败有限重试，重启恢复未完成汇报。原生结束事件与 ACD 自己的执行按来源去重，不引入第二套任务执行器；建议不自动执行。完整数据范围和恢复语义见 [结果汇报](completion-reports.md)。

## 消息提醒

Runtime 在发布状态前，通过现有 Store 投影关键事件，独立保存通知序号、未读和桌面领取状态。快照提供最新消息、计数和设置，完整记录通过分页接口读取；不把提醒历史加入总控模型上下文。

Electron main 从同一 SSE 快照领取有效通知，前台抑制弹窗，后台合并短时间提醒。通知先领取再调用系统 API，结果记录为提交、失败或抑制，保留应用内消息。点击只唤回窗口并定位任务/问题，不直接执行授权。开启驻留时，关闭窗口后保留 Tray 和订阅；明确退出桌面端则停止本机系统提醒。主进程不会因为重连而重新启动用户已停止的后台。

接口与验证边界见 [消息提醒](notifications.md)。

## 个人微信通道

微信实现为 `packages/core/wechat/` 的薄通道，复用 `Runtime.receive`、问题回答、停止、交付确认和同一个 `Store`，不创建第二套任务或会话状态。按腾讯公开 [iLink 协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md) 获取二维码并轮询确认，当前使用文本收发。

扫码结果中的绑定者 ID 用于入站身份校验；其他用户、群消息、Bot 消息均不调度。新任务使用本机配置的固定目录。身份和发送上下文保存在独立的 `WeChatVault`，以数据目录哈希区分系统凭证账户，不复用总控模型 Key。状态接口仅返回绑定者摘要、目录、连接状态、二维码及诊断，不返回 token。

`wechat-inbox`、`wechat-cursor`、`wechat-outbox` 和 `wechat-observed` 使用既有 SQLite 实体存储。入站先记录处理状态，普通消息再使用稳定客户端 UUID 进入现有接收去重；游标在当前批次处理后推进。重启时处理中的控制标记为未知，不盲目重放。出站发送前持久记录 `sending`，成功仅记 `submitted`；失败或重启遗留为 `unknown`，不自动重试不确定的外部效果。

轮询采用有界响应、请求超时和退避，登录失效停止并提示重新扫码；单批超过 100 条会在执行前暂停。普通网络重连不会重建或重跑已有任务。同步反馈是用户可选配置，包含新总控回复、任务状态、确认问题和有限结果摘要。当前未提供媒体消息、群聊或真实手机送达证明。

桌面设置和 CLI 通过受认证 `/api/wechat` 接口管理通道；桌面 main 白名单和后台能力检查同步更新。后台关闭先取消并等待通道，随后关闭 Runtime 与 Store。用法与真实验证边界见 [微信接入](wechat.md)。

## Agent 发现与适配

扫描通过统一注册表发现 Codex、Claude Code、OpenCode、Pi、DeepSeek Harness、OpenClaw、Hermes，检查 PATH / 常见安装目录和可执行文件元信息，不运行发现的程序、不读原生历史或认证文件。用户手动指定的其他绝对路径也可记录为候选。未知程序及未适配工具只展示发现结果，不能调度。用户勾选并确认接入后，仅对已适配程序执行有超时和输出上限的 `--version` 检查，不调用模型；执行任务时才启动相应协议会话。安装发现或启动检查成功均不代表已登录。

### Codex

使用 [官方 App Server](https://learn.chatgpt.com/docs/app-server) 的换行 JSON 协议：连接后 `initialize` / `initialized`，创建或恢复 thread，启动 turn，消费结构化事件。保存原生 thread 与 turn 标识，通过 `turn/steer` 追加、`turn/interrupt` 请求停止。

当前转接命令执行/文件变更确认及部分用户输入请求；选项由待处理请求校验，未知请求类型拒绝。版本差异和完整原生协议兼容仍需真实执行验证，不解析原生内部 JSONL 文件。

### Claude Code

使用 [官方 headless 模式](https://code.claude.com/docs/en/headless)：`-p --output-format stream-json --verbose`，从标准输入传入任务，通过结构化消息和结果记录进展，必要时 `--resume` 继续原会话。

当前不支持中途追加和交互授权；相应能力在适配器中明确受限。不会通过 `--dangerously-skip-permissions` 绕过原生权限。原生登录与模型调用资格由用户和执行端维护，发现本地可执行文件不构成订阅或 API 访问授权。

Windows 原生 `.exe` 可作为候选；当前 `.cmd` / `.bat` 包装器标记为不可用，避免将用户文本拼入 shell。Windows 全链路尚未验收。

## 本地技能目录

技能管理复用现有本机 HTTP 认证与桌面 preload 边界，提供扫描目录、读取元信息和按技能编号查看正文。它与任务执行状态分开：发现一个 `SKILL.md` 不改变 Agent 接入或执行权限，不会自动选择或启用该技能。

扫描范围来自明确的全局规则和用户选择的项目目录。已知规则包括：

| 来源              | 全局目录                                          | 指定项目中的目录   | 关联说明                                     |
| ----------------- | ------------------------------------------------- | ------------------ | -------------------------------------------- |
| 通用 Agent Skills | `~/.agents/skills`                                | `.agents/skills`   | Codex、Claude、OpenCode 路径关联，加载未验证 |
| Codex 兼容目录    | `~/.codex/skills`                                 | `.codex/skills`    | 兼容旧安装布局，实际加载取决于原生版本       |
| Claude Code       | `~/.claude/skills`                                | `.claude/skills`   | Claude、OpenCode 兼容路径，加载未验证        |
| OpenCode          | `~/.config/opencode/skills`                       | `.opencode/skills` | OpenCode 路径关联，加载未验证                |
| 其他候选          | Pi、Hermes、OpenClaw、DeepSeek Harness 的命名目录 | 不推断任意项目目录 | 仅候选来源，不能据此宣称原生 Agent 支持加载  |

官方格式与目录参考：[Agent Skills 规范](https://agentskills.io/specification)、[Codex 自定义说明](https://learn.chatgpt.com/docs/customization/overview)、[Claude Skills](https://code.claude.com/docs/en/skills)、[OpenCode Skills](https://opencode.ai/docs/skills/)。

扫描只读取 `SKILL.md`，解析 YAML frontmatter 的名称和说明并保留检查提示。文件系统遍历和文件读取均有限额，遵循被允许的技能根目录，不遍历整个硬盘或读取认证配置。符号链接只能指向允许的根目录范围；预览时再次校验路径，不能通过任意路径或扫描后更换的链接读取范围外的文件。相同物理文件合并来源；同名不同文件作为多个记录保留并提示。

目录仅保存元信息，不持久化技能全文，不把所有技能内容塞进总控提示。正文按用户选择读取并以文本预览，不渲染可执行 HTML、不运行技能脚本。新建只能写入已知根目录，使用标准 frontmatter，不覆盖同名目录。删除根据已扫描的技能 ID 操作，经路径复核后把整个技能文件夹原子移动至根目录外的同级 `.acd-skill-trash/<root-hash>/<id>/skill`，保留脚本与资源；移动前先落盘恢复清单。原位置恢复必须为空缺，不覆盖已有目录。符号链接越界、根目录删除和包含其他技能的目录会被拒绝。当前不提供永久删除、远程安装、编辑或统一启用/禁用。

`POST /api/skills/scan` 可选 `{ projectPath }`；省略时只扫描全局目录。`GET /api/skills` 返回最近扫描的目录，`GET /api/skills/:id` 读取已知记录的受限预览。写操作完成后刷新相同范围的目录；回收区仅保存恢复元信息，不进入原生技能扫描。桌面端定位文件使用已知技能编号经过主进程调用，不给 renderer 任意文件打开能力。

## 本地持久化

后台通过一个 `Store` 管理 SQLite 与 JSONL。SQLite 使用 WAL、FULL synchronous、foreign keys 和有限 busy timeout，当前 schema 版本为 `1`。`entities` 保存任务、问题、Agent 选择和非敏感模型配置；`pending_log` 为对话写入保留待落盘事件。

对话写入先保存带稳定事件 ID 的 pending 记录，按序追加 `conversation.jsonl` 并 `fsync`，然后删除已落盘记录。启动时重建消息索引并处理 pending 记录，避免同一事件重复落盘。完整的消息 ID 更新可在日志中保留多次事件；对话快照按消息 ID 取最新值。可修复尾部不完整记录，正文损坏则需要人工恢复。当前快照只返回最近 200 条消息，总控使用其中较短的近期上下文。

桌面未发送草稿与待确认发送编号属于客户端本地存储，按后台数据目录隔离；它们不在 SQLite／JSONL 的备份中。

任务状态修改和对话记录是现有的独立写入步骤；当前还不是跨所有任务状态与日志事件的完整事务事件系统。备份应停服务后整体复制数据目录，不能把活动中的 `state.sqlite` 单文件当作完整备份。

`node:sqlite` 在 Node.js 22.13 的状态仍为 experimental，较新 Node.js 文档标为 release candidate。参见 [Node.js SQLite 文档](https://nodejs.org/api/sqlite.html)。升级运行时需要重新检查兼容性。

API Key 使用 [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) 访问系统凭证存储。SQLite、JSONL 和状态快照不保存 Key。使用固定服务名 `agent-control-desk`，账户按 API origin 的哈希区分；切换需要认证的 API 来源时必须重新明确填写 Key。切换 `ACD_DATA_DIR` 只隔离状态文件，不隔离同一来源的系统凭证条目。

## 本机接口

除了 health，其余接口要求 `Authorization: Bearer <本机token>`。写请求使用 JSON，正文上限 64 KiB。客户端不应把 token 输出到日志。

| 方法 | 路径                                          | 用途                                                                                                  |
| ---- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET  | `/api/health`                                 | 协议版本、服务 PID 与能力列表                                                                         |
| GET  | `/api/wechat`                                 | 微信连接状态、扫码状态及诊断，不含凭证                                                                |
| POST | `/api/wechat/login`                           | `{ cwd, notifications }` 本人扫码接入                                                                 |
| POST | `/api/wechat/verify`                          | `{ code }` 提交手机验证码                                                                             |
| POST | `/api/wechat/configure`                       | `{ cwd, notifications }` 修改本机目录和反馈设置                                                       |
| POST | `/api/wechat/pause`、`/resume`、`/disconnect` | 暂停、恢复、删除本机微信登录                                                                          |
| POST | `/api/messages/:messageId/retry`              | `{}` 重新判断未进入动作阶段的原消息，保留编号与请求范围                                               |
| POST | `/api/reports/:reportId/retry`                | `{}` 重试已存在的结果报告，不重跑任务                                                                 |
| GET  | `/api/state`                                  | 完整客户端快照                                                                                        |
| POST | `/api/observations/:nativeId/analyze`         | `{ force? }` 当前执行公开片段的只读 AI 摘要                                                           |
| POST | `/api/observations/refresh`                   | `{}` 只读同步原生会话，返回含 observations 的快照                                                     |
| GET  | `/api/skills`                                 | 最近扫描的本地技能目录                                                                                |
| POST | `/api/skills/scan`                            | `{ projectPath? }` 扫描全局及指定项目技能目录                                                         |
| GET  | `/api/skills/:id`                             | 按已发现记录读取技能说明预览                                                                          |
| POST | `/api/skills`                                 | `{ rootPath, name, description, content }` 新建技能                                                   |
| POST | `/api/skills/:id/translate`                   | `{}` 使用总控模型翻译所选技能的说明和预览，返回 `{ description, content, truncated }`，不写文件或会话 |
| POST | `/api/skills/:id/trash`                       | 移动已知技能到回收区                                                                                  |
| GET  | `/api/skills/trash`                           | 查看当前目录范围的回收记录                                                                            |
| POST | `/api/skills/trash/:id/restore`               | 恢复到原位置，拒绝覆盖                                                                                |
| GET  | `/api/events`                                 | SSE `state` 事件，数据为同一快照契约                                                                  |
| POST | `/api/agents/manual`                          | `{ executable }` 手动记录可执行程序绝对路径，不执行                                                   |
| POST | `/api/agents/scan`                            | 扫描受支持 Agent                                                                                      |
| PUT  | `/api/agents`                                 | `{ ids }` 更新接入选择                                                                                |
| POST | `/api/model/models`                           | `{ providerId?, protocol?, baseUrl?, apiKey? }` 只读获取模型目录，不保存配置                          |
| PUT  | `/api/model`                                  | `{ providerId?, protocol?, baseUrl?, model, apiKey? }` 配置独立总控                                   |
| POST | `/api/messages`                               | `{ text, cwd, targetTaskId?, clientMessageId? }` 接收消息                                             |
| POST | `/api/tasks/:id/stop`                         | 请求停止                                                                                              |
| POST | `/api/tasks/:id/accept`                       | 确认本轮交付                                                                                          |
| POST | `/api/tasks/:id/reconcile`                    | `{ outcome: "stopped" }`：用户已核实原执行停止后记录结果；不自动核对                                  |
| POST | `/api/questions/:id/answer`                   | `{ choice }` 回答当前有效问题                                                                         |
| POST | `/api/shutdown`                               | 退出本地服务                                                                                          |

SSE 当前发送完整快照，适合本地 MVP；不是高频全量历史传输或远程多人服务。服务有心跳和慢客户端断开处理，桌面端重新连接后读取当前快照。网络连接恢复不意味着任务已自动恢复。

## 验证边界

`npm run typecheck`、`npm test`、`npm run build` 分别检查类型、隔离逻辑和 renderer 构建。测试应使用临时数据目录、Fake vault、Fake router 和假执行端，不读取用户实际凭证或原生历史。

本轮没有宣称真实模型费用、真实业务任务、Windows 安装/执行、签名包、微信或自动恢复已经验收。后续以实际端到端记录逐项确认能力，避免把程序编译通过等同于真实任务成功。

接入窗口使用三列卡片网格，在较窄窗口自动变为两列；检查结果保留至用户关闭。`POST /api/agents/manual` 接受 `{ executable }`，只被动记录用户指定的绝对路径。接入状态包含 discovered、checking、verified、failed、unsupported；verified 只代表程序启动检查通过。

原生会话以 `Snapshot.observations` 临时提供，通过同一 SSE 更新。`NativeObserver` 优先连接已有 Codex 控制代理，Mac 控制端点不可用时回退到写入进程核验的执行事件。新活动会话自动复用只读分析生成 `NativeSession.taskTitle`，标题与执行轮次、总控模型绑定；晚到的旧轮次结果不会覆盖新任务。元数据和标题不会进入 `tasks` 或 JSONL。状态边界、端点限制与验证结果见 [原生会话观测](native-observation.md)。

## 编译与分发

`npm run build` 生成 `dist/runtime/cli.mjs`、`server.mjs` 及共享块，再构建 renderer。项目代码编译为 JavaScript，生产依赖保持标准 Node 模块，不将 TypeScript 加载器加入分发包。源码 CLI 保留原开发入口；安装 CLI 没有源码时使用编译入口。

桌面主进程与 CLI 共用 `serviceLaunch` 确定启动参数：开发模式从明确的项目路径解析 tsx；安装模式使用解包的编译入口和真实 cwd。Electron 自带 Node 运行后台，SQLite 继续使用同一 Node 内置模块。界面位于 ASAR，运行时及生产依赖解包到真实路径；renderer 的 IPC、sandbox 和认证边界维持原契约。

构建预检要求目标系统及架构匹配，核对原生凭证模块，不把跨平台配置等同于 Windows 验收。完整产物、验证脚本及签名边界见 [安装与分发](distribution.md)。

## 本轮架构边界修正

实际提交执行前会重新检查任务工作目录的真实位置与目录类型。排队期间目录失效或被替换时，任务进入 `blocked`，不静默改变保存的工作目录。父子目录判断按完整路径片段处理，包括 `..nested` 这样的合法子目录名称。

通知的报告替代关系基于完整消息日志重建的最新报告索引，不依赖最近 200 条对话展示窗口。状态发布只读取一次基础状态，投影通知后派生通知列表，避免进展流中的重复快照扫描。

问题、简化取舍与验证边界见 [2026-11-04 架构检查](architecture-review-2026-11-04.md)。
