# 总控模型配置与本地数据

ACD 总控负责理解消息、分发任务和汇总结果。执行 Agent 仍使用自己的模型、账号、工具和项目设置；修改总控模型不会替换这些配置。

## 配置总控模型

桌面端通过“设置 → 模型接入”配置；CLI 使用：

```sh
acd model configure
```

CLI 依次询问服务商、接口地址、模型名和 Key，Key 输入不回显。仅在接口来源相同的情况下，才可留空保留现有凭证。保存模型配置不会发起生成请求或证明账号有调用权限。

当前提供 14 个云端、本地和自定义入口：DeepSeek、阿里云百炼（Qwen）、Kimi、智谱 GLM、MiniMax、火山方舟（豆包）、OpenAI、Anthropic、Gemini、硅基流动、OpenRouter、Ollama、LM Studio、自定义兼容服务。支持 OpenAI 兼容 Chat Completions 与 Anthropic Messages；模型 ID 可自行填写，不限于界面中的参考型号。

桌面端可搜索选择模型，也可以手动输入完整 ID，接口地址位于高级设置。填写 Key 后主动点击“获取模型列表”，后台请求对应接口的 `GET /models`；列表不会自动加载，不保存草稿 Key，也不改变已保存的模型配置。获取失败时仍可手动填写。服务返回某个模型，不等于账号有权限调用或已验证它能稳定完成路由。

已保存的 Key 仅用于同一接口来源的模型列表查询。Anthropic 使用原生认证和游标分页，硅基流动只查询对话模型；不把一个来源的 Key 隐式发给另一个来源。

Ollama 和 LM Studio 在本机回环地址上可以不填 Key；服务启用认证时仍需填写。接口需要返回合法结构化 JSON，Anthropic 需支持 Messages 结构化输出；MiniMax 使用提示词请求 JSON 并分离思考内容，再进行本地完整校验。协议与校验过程见 [架构说明](architecture.md) 和 [路由说明](routing.md)。

## 任务默认与操作范围

“设置 → 任务分配”可设置全局或项目默认 Agent。本条消息的明确选择优先；默认不可用或不满足必要能力时，可继续选择其他合格候选，并记录原因。已有任务保留原执行者，不因默认设置变化而改派。

```sh
acd agents default
acd agents default <Agent编号>
acd agents default <Agent编号> --project /absolute/path/to/project
acd agents default none --project /absolute/path/to/project
```

每条消息选择的工作目录决定新任务的操作范围。切换新任务目录不会改变已有任务的目录。原生 Agent 可能继续按自身配置加载项目约定、工具、插件或技能，ACD 不接管其全局配置。详细分配规则见 [执行者分配](routing.md#执行者分配)。

## 本地数据目录

| 平台    | 默认目录                                           |
| ------- | -------------------------------------------------- |
| macOS   | `~/Library/Application Support/agent-control-desk` |
| Windows | `%LOCALAPPDATA%/agent-control-desk`                |
| Linux   | `~/.local/share/agent-control-desk`                |

桌面“设置 → 本地服务与数据”可查看数据位置并打开文件夹。开发或隔离测试可通过 `ACD_DATA_DIR` 使用独立目录；`ACD_PORT` 可覆盖默认本机端口 `4317`。

目录包含任务与配置数据库 `state.sqlite`、SQLite WAL 文件、总控对话 `conversation.jsonl`，以及服务描述和锁文件。总控 Key 不写入 SQLite 或对话日志，而通过 `@napi-rs/keyring` 使用系统凭证存储。模型 Key 按接口来源（origin）区分条目，切换数据目录不会自动创建新的模型凭证账户；微信登录使用独立的凭证管理。

运行时描述含本地客户端认证 token，不应分享或上传。备份时整体保存数据目录，不要只复制一个数据库文件；系统凭证和桌面客户端草稿不包含在该目录备份中。迁移与升级说明见 [安装与分发](distribution.md)，草稿恢复见 [消息恢复](message-recovery.md)。

## 模型服务会接收哪些内容

本机运行不代表所有模型处理都在本机。总控消息、任务元信息和近期上下文会发送到你配置的总控服务；自动生成原生任务标题、查看或更新 AI 摘要、生成完成报告时，还会使用有限的公开执行片段。

- 原生任务分析使用经过范围限制的用户要求和公开进展，不发送内部推理、工具参数或完整聊天历史。详见 [原生会话观察](native-observation.md)。
- 结果汇报对照有限的用户要求、公开结果和先前判定，必要时包含引用文件的有限核对元数据。只有判定有新交付时才发布摘要和建议，保存所需片段以支持去重、有限重试与重启恢复。详见 [结果汇报](completion-reports.md)。
- Skill 翻译只在点击时发送所选说明和受限预览，不修改技能原文件。详见 [Skill 管理](skills.md)。

选择本机模型或远端服务时，应根据内容和使用场景决定。总控配置不改变执行 Agent 自身的数据传输行为。
