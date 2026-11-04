# 本机 Agent 执行适配

ACD 分开记录发现安装、程序启动、原生会话建立和执行结束。勾选接入后检查程序能否启动；账号、模型和工具能力仍以真实任务反馈为准。升级后到“管理 Agent”重新扫描即可发现新增支持，不会自动勾选新的 Agent 或修改它们的账号配置。

## 能力范围

| Agent                              | 创建 / 续接                | 执行中追加 | 请求停止                      | 交互                   |
| ---------------------------------- | -------------------------- | ---------- | ----------------------------- | ---------------------- |
| Codex                              | App Server                 | 支持       | 等待原生回执                  | 部分原生授权请求       |
| Claude Code                        | headless stream-json       | 不支持     | 进程停止，已有结果保留        | 不支持交互授权         |
| OpenCode                           | ACP v1 new / load          | 不支持     | 等待 prompt 的 cancelled 回执 | 原生 permission 选项   |
| Pi                                 | RPC 新会话 / 指定完整 UUID | steer      | abort 后等待最终稳定事件      | confirm、select、input |
| OpenClaw、Hermes、DeepSeek Harness | 尚未实现                   | —          | —                             | —                      |

OpenCode 的首轮兼容验证为 2.1.2；Pi 为 0.84.3。Pi 启动检查暂要求 0.84.3 或更新版本，这是已验证的兼容下限，不代表 `agent_settled` 首次出现的版本。后续版本仍可能改变协议，不能仅凭版本数字宣称完全兼容。Windows 的 `.cmd` / `.bat` 包装器仍不支持。

## 执行与结束

Codex 的每个执行连接只处理已确认的 thread ID 与 turn ID。续接时的旧结束事件和其他会话事件不写入本轮结果；`turn/start` 回执前到达的事件暂存，取得真实 turn ID 后再匹配。停止和追加还需等待本轮 `turn/started`，因为返回轮次编号时，原生端可能尚未接受中断。连接建立期间的停止请求保留为停止中，连接就绪后发送，不误报为已停止。

Codex 普通文字问题和带 Other 的单题可在总控回复；固定授权和固定选项仍限制为原生给出的选择。`serverRequest/resolved` 会移除失效问题。多题输入、密文输入和其他未适配请求仍明确拒绝，不收集凭证或默许授权。

Claude 只采用主执行的文字与最终结果，忽略转发的子执行正文和完成消息；明确的 success 与无权限拒绝才进入待检查。输出使用同一个按字节读取的 JSONL 边界，结束时等待输出排空；停止必须等到本机进程退出，超过 5 秒仍未确认则保留结果待核对。它仍不支持执行中追加和交互授权。

OpenCode 使用官方 TypeScript SDK 2.4.0 的稳定 ACP v1 入口，按需加载，启动自己的 `opencode acp` 子进程。初始化不提供客户端文件读写、终端或表单能力，不额外注入 MCP；原生端继续使用自身的项目和模型配置。续接只使用此 ACD 任务保存的原生 session ID，加载期间的旧消息不重新写入任务结果。`end_turn` 才进入待检查；`cancelled` 才确认为停止，长度限制和连接错误仍需核对。

Pi 启动 `--mode rpc`，新任务不使用 `--continue`；续接只传入该任务的完整原生 UUID。任务要求通过 JSON 输入，不拼接为 shell 参数。`prompt` 返回只表示接收，`agent_end` 可能后接自动重试或整理；必须等到 `agent_settled`，结合最后一条 assistant 的结束原因再更新终态。启动事件不作为尚未提交任务的完成回执。

适配器只转发公开文字和简短工具进展，忽略内部推理、工具参数和工具结果正文。Codex、Claude、Pi 共用按字节读取的 JSONL 边界，保留 UTF-8 和 U+2028；每条协议记录最多 4 MiB。输出 EOF、协议损坏或丢失终态都不能当作完成。

停止最多等待 5 秒的明确终态；未确认则进入结果待核对并关闭自己持有的连接，不把杀进程等同于原生取消成功。已经产生的文件修改保留。任务未提交前明确失败可以释放目录占用；执行后状态未知继续保留占用，需用户核对后解除。

## 授权与输入

OpenCode 的原生 option ID 映射为稳定的本轮按钮 ID，显示允许一次、始终允许、拒绝等语义；提交时只转回原生提供的选项。Pi 的确认、选择和普通文字输入分别映射，不把自由文字当作任意授权。选择项可保留原生文案。

Pi 不支持的 editor/custom 界面交互会明确取消该交互。原生请求过期、任务结束或连接失效后，旧问题会关闭，不保留可点击的失效授权。多条问题并存时，回答一条不会隐藏另一条待处理状态。Pi 自身的工具权限与扩展仍由其原生配置管理，ACD 不是额外的工具沙箱。

## 验证证据

2026-11-03，使用本机已安装 OpenCode 2.1.2、Pi 0.84.3，各自独立的临时应用配置、工作目录与本机 Ollama `qwen3.5:4b-q4_K_M`：

- 两者均通过原生协议创建会话，调用写工具产出指定文件，直接读取文件校验内容，并取得明确正常结束。
- 两者均在新进程中按同一原生 session ID 续接，调用读工具读取刚才的文件并返回指定内容。
- 未改动用户已有原生配置、账号或所选 Agent；没有把 Fake 模型结果当作真实执行。
- 权限映射、输入、追加、停止、重试后结束、断连和迟到错误另有隔离子进程与 Runtime 回归测试。真实停止、授权、更多模型及 Windows 仍需分别验收。

同日另以已接入的真实 Codex 验证创建文件、自动结果建议和单条消息中心提醒；续接保留原 session ID、使用新的 turn ID 并读回产物。立即追加在同一 turn 中接收并采用指定补充要求；立即停止先复现 `no active turn to interrupt`，修复等待开始事件后取得明确 `interrupted` 回执。交互授权仍仅完成隔离协议验证，Claude 真实账号仍待验收。

这些适配只管理 ACD 发起的执行。当前独立运行会话的自动观察仍只覆盖已有的 Codex 观察链路，不表示已经同步 OpenCode/Pi 的全部外部任务和历史。

协议依据：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)、本机 Codex 生成的版本匹配 Schema、[Claude headless](https://code.claude.com/docs/en/headless)、[Claude 消息类型](https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage)、[OpenCode ACP](https://opencode.ai/v2/docs/cli/acp)、[ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)、Pi 已安装 0.84.3 包内 `docs/rpc.md` 与 `docs/models.md`。OpenCode 本机模型配置按 [v2 Providers](https://opencode.ai/v2/docs/providers) 使用，避免混用 v1 字段。
