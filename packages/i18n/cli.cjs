module.exports = {
  "本地服务描述无效或协议不兼容。请重启 ACD 服务。":
    "Invalid or incompatible local service descriptor. Restart the ACD service.",
  "本地服务地址无效。": "Invalid local service address.",
  "无法读取本地服务描述，请重启 ACD 服务。":
    "Cannot read the local service descriptor. Restart the ACD service.",
  "无效 API 路径": "Invalid API path",
  "本地后台尚不支持任务分配规则，请先处理任务后重启 ACD。":
    "The local service does not support allocation rules. Finish active work and restart ACD.",
  "本地后台尚不支持执行者排序，请先处理任务后重启 ACD。":
    "The local service does not support agent priority. Finish active work and restart ACD.",
  "本地后台尚无定时任务能力，请先处理进行中的任务，再停止并重新启动 ACD。":
    "The local service does not support schedules. Finish active work and restart ACD.",
  "本地后台尚无消息提醒能力，请先处理任务后重启 ACD。":
    "The local service does not support notifications. Finish active work and restart ACD.",
  "本地后台尚不支持完成报告推送，请先处理任务后重启 ACD。":
    "The local service does not support completion report delivery. Finish active work and restart ACD.",
  "本地后台尚不支持微信测试消息，请先处理任务后重启 ACD。":
    "The local service does not support WeChat test messages. Finish active work and restart ACD.",
  "本地后台尚无微信接入能力，请先处理进行中的任务，再停止并重新启动 ACD。":
    "The local service does not support WeChat. Finish active work and restart ACD.",
  "本地后台版本较旧，请先处理进行中的任务，再停止并重新启动 ACD 后重试。":
    "The local service is outdated. Finish active work and restart ACD before retrying.",
  "本地后台尚不支持重新判断消息，请先处理任务后重启 ACD。":
    "The local service does not support reassessing messages. Finish active work and restart ACD.",
  "请求失败（{p0}）": "Request failed ({p0})",
  "服务协议不兼容，请重启服务。":
    "Incompatible service protocol. Restart the service.",
  协议不兼容: "Incompatible service protocol",
  "无法启动本地服务。请检查 Node.js 和项目依赖。":
    "Cannot start the local service. Check Node.js and project dependencies.",
  "本地服务未能启动。运行 npm run daemon 查看启动错误。":
    "The local service failed to start. Run npm run daemon to inspect the error.",
  "技能目录：{p0} 项": "Skills: {p0}",
  "尚未扫描技能。运行 acd skills scan。":
    "No skills scanned yet. Run acd skills scan.",
  全局: "Global",
  项目: "Project",
  未关联: "Unlinked",
  未知范围: "Unknown scope",
  " [需检查]": " [Needs attention]",
  "\n{p0}  [{p1}]{p2}  #{p3}": "\n{p0}  [{p1}]{p2}  #{p3}",
  "  路径：{p0}": "  Path: {p0}",
  "  路径关联：{p0}（加载未验证）": "  Linked path: {p0} (loading unverified)",
  "  提示：{p0}": "  Note: {p0}",
  "\n扫描提示：{p0}": "\nScan notes: {p0}",
  "\n已发现不等于已启用；本命令不安装、修改或执行技能。":
    "\nDiscovered does not mean enabled; this command does not install, modify or execute skills.",
  "提示：{p0}": "Note: {p0}",
  "\n[预览已截断，完整内容请查看原文件]":
    "\n[Preview truncated; see the original file for full content]",
  "定时任务 JSON 文件过大": "Schedule JSON file is too large",
  "定时任务文件必须是合法 JSON": "Schedule file must contain valid JSON",
  "定时任务文件必须是 JSON 对象": "Schedule file must contain a JSON object",
  "定时任务字段无效，请运行 acd schedules --help 查看用法":
    "Invalid schedule fields. Run acd schedules --help for usage",
  "定时任务 cwd 必须是绝对路径": "Schedule cwd must be an absolute path",
  "单次 {p0}": "Once at {p0}",
  "每 {p0} 分钟": "Every {p0} minutes",
  "每天 {p0}（{p1}）": "Daily at {p0} ({p1})",
  "每周 {p0} {p1}（{p2}）": "Weekly on {p0} at {p1} ({p2})",
  "暂无定时任务。运行 acd schedules create --file <JSON文件> 新建。":
    "No schedules. Run acd schedules create --file <JSON-file> to create one.",
  已启用: "Enabled",
  已暂停: "Paused",
  已结束: "Finished",
  "  时间：{p0}": "  Time: {p0}",
  无: "None",
  "  下次：{p0}": "  Next: {p0}",
  "  工作目录：{p0}": "  Working directory: {p0}",
  "  要求：{p0}": "  Requirements: {p0}",
  " · 任务 ": " · Task ",
  "  最近触发：{p0} · {p1}{p2}": "  Last trigger: {p0} · {p1}{p2}",
  "模型设置需要交互终端。":
    "Model configuration requires an interactive terminal.",
  "API Key 需要在交互终端中输入。":
    "API Key entry requires an interactive terminal.",
  "已取消模型设置。": "Model configuration cancelled.",
  "事件数据过大，连接已断开。": "Event data is too large; disconnected.",
  "ACD · 一个对话，所有 Agent。输入 /quit 退出，后台任务继续运行。\n":
    "ACD · One conversation, all your agents. Enter /quit to exit; background tasks continue.\n",
  "尚未接入 Agent。先运行 acd agents scan，再 acd agents select <编号>。\n":
    "No agents connected. Run acd agents scan, then acd agents select <id>.\n",
  "尚未配置总控模型。运行 acd model configure。\n":
    "No supervisor model configured. Run acd model configure.\n",
  "你 › ": "You › ",
  "无法连接进展事件流。": "Cannot connect to the progress event stream.",
  "需要处理 {p0}: {p1}\n{p2}\n使用 acd answer {p3} <选项>":
    "Action needed {p0}: {p1}\n{p2}\nUse acd answer {p3} <choice>",
  "\n进展连接已断开。任务可能仍在运行，使用 acd tasks 核对。\n":
    "\nProgress stream disconnected. Tasks may still be running; use acd tasks to check.\n",
  "\n进展连接不可用，使用 acd tasks 核对状态。\n":
    "\nProgress stream unavailable; use acd tasks to check status.\n",
  "发送失败：{p0}\n": "Send failed: {p0}\n",
  " 需要提供值": " requires a value",
  "每条消息只能指定一个执行 Agent":
    "Only one agent can be selected per message",
  "未知能力：": "Unknown capability: ",
  "；可选 steer、resume、approval、input":
    "; choose steer, resume, approval, input",
  "未知发送选项：": "Unknown send option: ",
  "用法：acd send <消息> [--agent <编号|auto>] [--require <能力>]":
    "Usage: acd send <message> [--agent <id|auto>] [--require <capability>]",
  "服务未运行。": "Service is not running.",
  "已请求停止本地服务。": "Local service shutdown requested.",
  "用法：acd service start|status|stop": "Usage: acd service start|status|stop",
  "未知命令。运行 acd --help 查看用法；发送任务请使用 acd send <消息>。":
    "Unknown command. Run acd --help for usage; use acd send <message> to send a task.",
  "用法：acd schedules [list] | show <计划编号>":
    "Usage: acd schedules [list] | show <schedule-id>",
  定时任务不存在: "Schedule not found",
  " <计划编号>": " <schedule-id>",
  "用法：acd schedules {p0}{p1} --file <JSON文件>":
    "Usage: acd schedules {p0}{p1} --file <JSON-file>",
  "用法：acd schedules {p0} <计划编号>":
    "Usage: acd schedules {p0} <schedule-id>",
  "\n  任务：": "\n  Task: ",
  "{p0}  [{p1}]\n  {p2}{p3}": "{p0}  [{p1}]\n  {p2}{p3}",
  "暂无触发记录。": "No trigger records.",
  "定时任务已删除，已触发的执行仍保留。":
    "Schedule deleted; triggered executions are retained.",
  "未知定时任务操作。运行 acd schedules --help 查看用法。":
    "Unknown schedule operation. Run acd schedules --help for usage.",
  "用法：acd inbox read <消息编号>": "Usage: acd inbox read <message-id>",
  "暂无消息。": "No messages.",
  "已标记已读。": "Marked as read.",
  "用法：acd inbox [read <消息编号>|read-all]":
    "Usage: acd inbox [read <message-id>|read-all]",
  "{p0} 条未读\n": "{p0} unread\n",
  "[已读]": "[Read]",
  "[未读]": "[Unread]",
  "{p0} {p1}\n{p2}\n消息编号：{p3}": "{p0} {p1}\n{p2}\nMessage ID: {p3}",
  不能同时开启和关闭同一选项: "Cannot enable and disable the same option",
  "用法：acd wechat login|status|pause|resume|disconnect|verify|test|configure":
    "Usage: acd wechat login|status|pause|resume|disconnect|verify|test|configure",
  "--project 需要工作目录": "--project requires a working directory",
  "请用个人微信扫码并确认。只允许扫码绑定者控制 ACD。\n新任务使用指定工作目录；默认同步总控回复与任务反馈，可用 --no-notify 关闭。\n用 acd wechat status 查看连接状态；需要手机验证码时运行 acd wechat verify <验证码>。\n":
    "Scan with your personal WeChat account and confirm. Only the account that scanned can control ACD.\nNew tasks use the selected working directory. Supervisor replies and task updates are synced by default; use --no-notify to disable.\nUse acd wechat status to check the connection; use acd wechat verify <code> when phone verification is required.\n",
  "用法：acd retry <消息编号>": "Usage: acd retry <message-id>",
  "用法：acd agents add <可执行程序的绝对路径>":
    "Usage: acd agents add <absolute-executable-path>",
  "请指定 Agent 编号，或使用 none 清空。":
    "Specify agent IDs, or use none to clear.",
  "用法：acd agents default [<编号…|none> [--project <目录>]]":
    "Usage: acd agents default [<id…|none> [--project <directory>]]",
  "全局优先级  ": "Global priority  ",
  未设置: "Not set",
  "用法：acd agents scan|add|list|select|default":
    "Usage: acd agents scan|add|list|select|default",
  "用法：acd skills scan [--project <项目绝对路径>]":
    "Usage: acd skills scan [--project <absolute-project-path>]",
  "用法：acd skills list [--json]": "Usage: acd skills list [--json]",
  "用法：acd skills show <技能编号>": "Usage: acd skills show <skill-id>",
  "用法：acd skills create --root <目录> --name <名称> --description <用途> --content <正文>":
    "Usage: acd skills create --root <directory> --name <name> --description <description> --content <content>",
  新建技能参数无效: "Invalid new skill arguments",
  "用法：acd skills ": "Usage: acd skills ",
  " <编号>": " <id>",
  "用法：acd skills trash": "Usage: acd skills trash",
  "用法：acd skills scan|list|show|create|delete|trash|restore":
    "Usage: acd skills scan|list|show|create|delete|trash|restore",
  "用法：acd sessions [--json]": "Usage: acd sessions [--json]",
  "本地后台尚不支持原生会话观测，请先处理进行中的任务再重启后台。":
    "The local service does not support native session observation. Finish active work and restart the service.",
  正在执行: "Running",
  等待处理: "Needs attention",
  当前空闲: "Idle",
  发生错误: "Error",
  状态未知: "Unknown status",
  "  [{p0}] {p1}\n  会话：{p2}\n  {p3}\n  工作目录：{p4}":
    "  [{p0}] {p1}\n  Session: {p2}\n  {p3}\n  Working directory: {p4}",
  "  当前观测范围没有会话，不代表其他实例没有任务。":
    "  No sessions in the observed scope; other instances may still have tasks.",
  "{p0} · {p1}\n{p2}": "{p0} · {p1}\n{p2}",
  "尚未同步原生会话。请先接入 Codex，并等待后台同步。":
    "No native sessions synced. Connect Codex and wait for synchronization.",
  "{p0}  {p1}\n  {p2}\n  工作目录：{p3}":
    "{p0}  {p1}\n  {p2}\n  Working directory: {p3}",
  "暂无任务。使用 acd send <消息> 开始。":
    "No tasks. Use acd send <message> to begin.",
  "用法：acd recover <任务编号> --stopped。只有你已核实原执行停止后才能确认；此命令不会自动核对或停止执行端。":
    "Usage: acd recover <task-id> --stopped. Confirm only after verifying the original execution has stopped; this command does not check or stop the executor.",
  "用法：acd {p0} <任务编号>": "Usage: acd {p0} <task-id>",
  操作已提交: "Operation submitted",
  "{p0}：{p1}": "{p0}: {p1}",
  "用法：acd answer <问题编号> <选项>":
    "Usage: acd answer <question-id> <choice>",
  "用法：acd model configure": "Usage: acd model configure",
  "选择模型服务商（编号或ID，默认1）：":
    "Select model provider (number or ID, default 1):",
  未知模型服务商: "Unknown model provider",
  "接口地址（留空使用 ": "API base URL (leave blank for ",
  自定义地址: "custom URL",
  "模型名称（默认 ": "Model name (default ",
  请填写: "required",
  "接口协议（openai-chat / anthropic-messages，默认openai-chat）：":
    "API protocol (openai-chat / anthropic-messages, default openai-chat):",
  "API Key（不回显；仅同一服务可留空保留）：":
    "API Key (hidden; leave blank to keep only for the same service):",
  "API Key（本机服务可留空；不回显）：":
    "API Key (optional for local services; hidden):",
  "总控模型已保存：{p0} / {p1}。保存未调用模型。":
    "Supervisor model saved: {p0} / {p1}. Saving did not call the model.",
  "发现安装不代表已认证；只有真实执行能验证 Agent 可用性。":
    "Finding an installation does not verify authentication; only an actual execution can verify agent availability.",
  'acd schedules [list]                 查看定时任务\nacd schedules show <计划编号>         查看计划详情\nacd schedules create --file <JSON文件> 新建计划\nacd schedules update <计划编号> --file <JSON文件> 替换计划要求与时间\nacd schedules pause|resume|delete <计划编号> 暂停、恢复或删除计划\nacd schedules runs <计划编号>         查看最近 30 次触发记录\n\nJSON 字段：name、prompt、agentId、rule，cwd 可省略（使用当前目录）。\nagentId 使用 acd agents list 返回的已接入 Agent 编号。\nrule 示例：\n  {"kind":"once","at":"2026-12-01T09:00:00+08:00"}\n  {"kind":"interval","minutes":60}\n  {"kind":"daily","time":"09:00","timeZone":"Asia/Shanghai"}\n  {"kind":"weekly","time":"09:00","timeZone":"Asia/Shanghai","days":[1,3,5]}\n星期使用 0（周日）至 6（周六）。单次时间必须包含时区偏移。\n后台需运行；错过不补跑。暂停或删除计划不会停止已触发的任务。\n--json                               机器可读输出':
    'acd schedules [list] | show <schedule-id>\nacd schedules create --file <JSON-file>\nacd schedules update <schedule-id> --file <JSON-file>\nacd schedules pause|resume|delete|runs <schedule-id>\n\nJSON: {"name":"Daily check","prompt":"Check project tests","cwd":"/absolute/project","agentId":"agent-id","rule":{"kind":"daily","time":"09:00","timeZone":"Asia/Shanghai"}}\nSupported rules: once {at: ISO date with timezone}, interval {minutes: 1..525600}, daily {time: HH:mm,timeZone: IANA}, weekly {time: HH:mm,timeZone: IANA,days: [0..6]}.\nThe computer and local service must be running. Missed triggers are skipped, and an active previous run prevents overlap. Pausing/deleting a schedule does not stop tasks already triggered.',
  "本地后台尚不支持语言设置，请先处理任务后重启 ACD。":
    "The local service does not support language settings. Finish active work and restart ACD.",
  "acd                         打开总控对话\nacd send <消息> [--agent <编号|auto>] [--require <steer|resume|approval|input>]  发送任务\nacd agents scan            扫描已支持的 Agent\nacd agents add <程序路径>   手动添加 Agent 候选程序\nacd agents list            查看已发现和已选择的 Agent\nacd agents select <编号…>   确认管理的 Agent（传 none 可清空）\nacd agents default [<编号…|none> [--project <目录>]]  查看或按从高到低的顺序设置执行者优先级\nacd skills scan [--project <绝对路径>]  扫描全局及指定项目的技能\nacd skills list            查看最近扫描的技能目录\nacd skills show <技能编号>  预览本地技能说明\nacd skills create --root <目录> --name <名称> --description <用途> --content <正文>\nacd skills delete <技能编号>  移入回收区\nacd skills trash           查看回收区\nacd skills restore <回收编号> 恢复技能\nacd schedules              查看定时任务（--help 查看创建与管理用法）\nacd inbox                  查看消息和未读\nacd inbox read <消息编号> | read-all  标记已读\nacd retry <消息编号>        重新判断未进入执行阶段的失败消息\nacd tasks                  查看 ACD 发起的任务\nacd sessions               查看已同步的原生会话（只读）\nacd stop <任务编号>         请求停止任务\nacd recover <任务编号> --stopped  确认原执行已停止后释放待确认任务\nacd accept <任务编号>       确认交付完成\nacd answer <问题编号> <选项> 回答待处理问题\nacd model configure        配置独立总控模型\nacd service start|status|stop\nacd wechat login [--project <目录>]  扫码连接个人微信\nacd wechat configure --reports|--no-reports [--notify|--no-notify]\nacd wechat status|pause|resume|disconnect|test\nacd wechat verify <验证码>  提交手机显示的验证码\nacd doctor                 检查本地服务及必要配置\nacd language [en|zh-CN]     查看或设置项目界面语言\n--lang en|zh-CN             本次 CLI 显示语言（置于命令前）\n--json                     机器可读输出":
    "acd                         Open the control conversation\nacd send <message> [--agent <id|auto>] [--require <steer|resume|approval|input>]  Send a task\nacd agents scan            Scan supported agents\nacd agents add <path>       Add an agent executable\nacd agents list            List discovered and selected agents\nacd agents select <id…>     Select agents (none to clear)\nacd agents default [<id…|none> [--project <directory>]]  View/set priority from highest to lowest\nacd skills scan [--project <absolute-path>]  Scan global and project skills\nacd skills list            List scanned skills\nacd skills show <skill-id>  Preview a skill\nacd skills create --root <directory> --name <name> --description <description> --content <content>\nacd skills delete <skill-id> | trash | restore <trash-id>\nacd schedules              View schedules (--help for management)\nacd inbox [read <message-id>|read-all]  View notifications or mark read\nacd retry <message-id>      Reassess a failed message before execution\nacd tasks                  View ACD tasks\nacd sessions               View native sessions (read only)\nacd stop <task-id>          Request a stop\nacd recover <task-id> --stopped  Release a task after verifying execution stopped\nacd accept <task-id>        Accept delivery\nacd answer <question-id> <choice>\nacd model configure        Configure the supervisor model\nacd language [en|zh-CN]     View/set the shared application language\nacd service start|status|stop\nacd wechat login [--project <directory>]\nacd wechat configure --reports|--no-reports [--notify|--no-notify]\nacd wechat status|pause|resume|disconnect|test\nacd wechat verify <code>    Submit phone verification code\nacd doctor                 Check local service and configuration\n--lang en|zh-CN             Override CLI display language for this invocation\n--json                     Machine-readable output",
};
