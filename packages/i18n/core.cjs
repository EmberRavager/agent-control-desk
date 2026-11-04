module.exports = {
  "服务已重启，任务尚未启动。可补充消息后继续。":
    "The service restarted before this task started. Send a follow-up to continue.",
  "服务已重启，需要核对原会话；未自动重跑。":
    "The service restarted. Check the original session; execution was not retried automatically.",
  " 本轮任务": " current task",
  "所选 Agent 不存在、不可启动或尚未完成适配":
    "The selected Agent is missing, cannot start, or has no supported adapter",
  "正在检查所选程序…": "Checking the selected program…",
  "启动检查失败，请确认安装。": "Startup check failed. Check the installation.",
  "切换模型服务地址时，请明确填写用于该服务的 Key":
    "Enter the API Key for the new model service when changing its URL",
  请填写模型名: "Enter a model name",
  "请配置总控 API Key": "Configure the controller API Key",
  "请先配置总控模型，再分析当前任务。":
    "Configure the controller model before analyzing this task.",
  "总控模型凭证不可用，请重新配置。":
    "Controller model credentials are unavailable. Configure them again.",
  "任务分析超时，可稍后重新分析。": "Task analysis timed out. Try again later.",
  "配置总控模型后才能生成结果建议。":
    "Configure the controller model to generate result recommendations.",
  "请先在设置中配置总控模型，再翻译技能。":
    "Configure the controller model in Settings before translating skills.",
  "总控模型凭证不可用，请在设置中重新配置。":
    "Controller model credentials are unavailable. Configure them again in Settings.",
  "翻译请求超时，请稍后重试。": "Translation timed out. Try again later.",
  "请先填写此服务的 API Key，再获取模型列表":
    "Enter this service’s API Key before loading models",
  服务正在退出: "The service is shutting down",
  "优先级列表中的 Agent 不能重复":
    "An Agent can appear only once in a priority list",
  请选择项目的绝对路径: "Select an absolute project path",
  项目目录不存在: "Project directory does not exist",
  "新加入优先级列表的 Agent 必须已接入、可用且已适配":
    "Agents added to a priority list must be connected, available, and supported",
  工作目录不存在: "Working directory does not exist",
  任务不存在: "Task not found",
  "此消息编号已用于其他内容，请重新发送新消息":
    "This message ID belongs to different content. Send a new message",
  用户消息不存在: "User message not found",
  "这条消息不能安全重新判断，请先核对已有任务或作为新消息说明要求。":
    "This message cannot be rerouted safely. Check existing tasks or send your requirements in a new message.",
  "原工作目录已改变或不可访问，请重新选择目录后发送新消息。":
    "The original working directory changed or is inaccessible. Select a directory and send a new message.",
  "原目标任务已不存在，请重新选择目标。":
    "The original target task no longer exists. Select another target.",
  "总控处理失败，消息已保存。可在原消息上重新判断。":
    "Controller processing failed. Your message is saved; retry routing from the original message.",
  "部分操作可能已提交，请核对任务状态；没有自动重试操作。":
    "Some operations may have been submitted. Check task status; no operations were retried automatically.",
  "请先配置独立总控模型。消息已保存，尚未执行。":
    "Configure a separate controller model first. Your message is saved and has not been executed.",
  "总控凭证不可用，请重新配置。":
    "Controller credentials are unavailable. Configure them again.",
  "总控模型请求超时。消息已保存，尚未分配执行；请检查模型响应或重试。":
    "The controller model request timed out. Your message is saved and no execution was assigned. Check the model response or retry.",
  "总控模型暂不可用或返回格式不正确。消息已保存，未分配执行。":
    "The controller model is unavailable or returned an invalid response. Your message is saved and no execution was assigned.",
  新任务试图超出本条消息的工作目录:
    "The new task attempted to leave this message’s working directory",
  "已为 {v0} 排队，轮到它时会发送":
    "Queued for {v0}; it will be sent when the Agent is ready",
  "{v0} 暂时无法执行，{v1} 原指令是":
    "{v0} cannot execute right now. {v1} The original instruction was",
  "收到，我去问 {v0}": "Got it. I’ll ask {v0}",
  "收到，我让 {v0} 处理": "Got it. I’ll ask {v0} to handle it",
  "收到，我让 {name} 处理": "Got it. I’ll ask {name} to handle it",
  "本次执行者和能力选择用于立即创建的任务。定时计划请在“定时任务”页面选择执行者，或清除本次选择后重发；消息已保留。":
    "The selected Agent and capabilities apply to immediate tasks. Choose an Agent on the Schedules page, or clear these selections and resend. Your message is saved.",
  定时任务试图超出本条消息的工作目录:
    "The schedule attempted to leave this message’s working directory",
  "已创建定时任务「{v0}」。下次执行：{v1}。后台需保持运行，错过时间不补跑。":
    "Created schedule “{v0}”. Next run: {v1}. Keep the service running; missed runs will be skipped.",
  "已删除定时计划，已触发的任务继续保留。":
    "Schedule deleted. Previously triggered tasks are retained.",
  "已暂停后续触发，已有执行不受影响。":
    "Future runs are paused. Existing executions continue.",
  "已恢复后续定时触发。": "Future scheduled runs are enabled again.",
  "{v0}（{v1}）：{v2}，下次执行 {v3}": "{v0} ({v1}): {v2}, next run {v3}",
  "当前没有定时任务。": "No schedules.",
  "任务已被更新，请依据最新进展重新确认":
    "The task changed. Review its latest progress and confirm again",
  "执行状态待确认，不能直接重跑或追加":
    "Execution status is uncertain; rerunning or appending is unavailable",
  "正在停止，暂不能追加": "Stopping; appending is temporarily unavailable",
  "\n补充：": "\nFollow-up: ",
  "新要求已保存，正在停止旧轮次以取消过期授权。":
    "New requirements saved. Stopping the previous turn to invalidate outdated approvals.",
  "旧轮次停止结果待确认。":
    "The previous turn’s stop result needs verification.",
  "待旧轮次停止确认后，可按新要求继续。":
    "Continue with the new requirements after the previous turn is confirmed stopped.",
  "补充已保存，连接建立后再确认送达。":
    "Follow-up saved. Delivery will be checked after connection.",
  "补充已送达执行端；采用结果以执行反馈为准。":
    "Follow-up delivered to the Agent. Its execution feedback determines whether it was applied.",
  "补充已保存，未确认送达，请核对执行进展。":
    "Follow-up saved; delivery is unconfirmed. Check execution progress.",
  "补充已保存。此执行端不支持中途追加；停止当前轮次后可继续。":
    "Follow-up saved. This Agent cannot accept input during execution; stop the current turn before continuing.",
  "正在按更新后的要求继续。": "Continuing with the updated requirements.",
  "任务要求已更新，停止指令未应用":
    "Requirements changed; the stop instruction was not applied",
  查询目标不存在或已离开当前观测范围:
    "The requested target is missing or outside the current observation scope",
  "ACD 发起的任务：\n": "Tasks started by ACD:\n",
  "ACD 当前暂无任务。": "ACD currently has no tasks.",
  "原生会话（只读）：\n": "Native sessions (read-only):\n",
  "当前连接的原生实例没有已加载会话；不代表其他实例没有任务。":
    "This connected native instance has no loaded sessions. Other instances may have tasks.",
  "原生 Agent 的其他会话尚未接入观测。":
    "Other native Agent sessions are not connected to observation.",
  操作无法执行: "This operation cannot be performed",
  "定时任务「{v0}」未启动：{v1}": "Schedule “{v0}” did not start: {v1}",
  工作目录必须为绝对路径: "Working directory must be an absolute path",
  "执行 Agent 未接入": "The execution Agent is not connected",
  "消息已接收，正在分配执行。": "Message received. Assigning execution.",
  工作目录已改变: "Working directory changed",
  "工作目录已不可访问或真实位置已改变，尚未提交执行；请核对原目录后继续。":
    "The working directory is inaccessible or its resolved location changed. Execution was not submitted; check the original directory before continuing.",
  "「{v0}」未能启动。{v1}": "“{v0}” could not start. {v1}",
  "等待「": "Waiting for “",
  "」释放工作目录，消息已接收。":
    "” to release the working directory. Message received.",
  "原分配 Agent 当前不可用或不满足任务能力要求，尚未提交执行；未自动改派。":
    "The assigned Agent is unavailable or lacks required capabilities. Execution was not submitted or reassigned automatically.",
  "正在连接执行 Agent。": "Connecting to the execution Agent.",
  "连接建立，补充已送达；采用情况以执行反馈为准。":
    "Connected and follow-up delivered. Check execution feedback to confirm it was applied.",
  "补充已保存，当前执行端不支持中途追加。":
    "Follow-up saved. This Agent cannot accept input during execution.",
  "执行端未能启动或连接中断，请检查安装和登录状态。":
    "The Agent could not start or disconnected. Check its installation and login status.",
  "已返回答复。": "Response received.",
  "{v0} 回复：\n{v1}": "{v0} replied:\n{v1}",
  "{v0} 已结束「{v1}」的执行。{v2}\n交付结果待检查。":
    "{v0} finished executing “{v1}”. {v2}\nDelivery awaits review.",
  "执行端没有返回文字结果。": "The Agent returned no text result.",
  正在执行: "Running",
  "问题已结束，等待执行端反馈。":
    "The question has closed. Waiting for Agent feedback.",
  执行端请求授权: "The Agent requests approval",
  "本轮执行结束，等待检查结果。": "This turn finished. Results await review.",
  "执行已停止，已有修改保留。":
    "Execution stopped. Existing changes are retained.",
  "任务尚未提交，请检查执行端配置。":
    "Task not submitted. Check the Agent configuration.",
  "执行结果待确认，不自动重试。":
    "Execution result needs verification. No automatic retry.",
  "已取消等待。": "Waiting cancelled.",
  "任务已结束，已有结果保留。": "Task closed. Existing results are retained.",
  "正在连接执行端，连接建立后立即请求停止。":
    "Connecting to the Agent. A stop will be requested as soon as it connects.",
  "未持有原执行连接，停止结果待确认。":
    "The original execution connection is unavailable. Stop result needs verification.",
  "停止请求已发送，等待确认。": "Stop requested. Waiting for confirmation.",
  "停止结果待确认。": "Stop result needs verification.",
  问题已失效或选项无效: "The question expired or the choice is invalid",
  "针对此前消息「": "Regarding the earlier message “",
  "」，我的回答是：": "”, my answer is: ",
  "追问已失效，请查看最新进展":
    "This follow-up expired. Check the latest progress",
  "已收到答复，等待续接原会话。":
    "Answer received. Waiting to resume the original session.",
  "要求已更新，此授权已失效": "Requirements changed; this approval expired",
  "回复已提交，等待执行端反馈。":
    "Answer submitted. Waiting for Agent feedback.",
  "授权选择已提交，等待执行端反馈。":
    "Approval choice submitted. Waiting for Agent feedback.",
  "回复的送达结果待确认，不自动重试。":
    "Answer delivery is unconfirmed. No automatic retry.",
  "授权选择的送达结果待确认，不自动重试。":
    "Approval choice delivery is unconfirmed. No automatic retry.",
  "授权送达结果待确认，请核对执行端":
    "Approval delivery is unconfirmed. Check the Agent",
  仅状态待确认任务可人工解除:
    "Only tasks with uncertain status can be released manually",
  "用户已确认原执行停止，已解除目录占用；已有修改尚未验收。":
    "The user confirmed the original execution stopped. Directory reservation released; existing changes still await review.",
  当前任务没有待检查的结果: "This task has no result awaiting review",
  "用户已确认完成。": "The user confirmed completion.",
  "本地服务已退出，执行结果需要核对。":
    "The local service exited. Execution results need verification.",
  "技能不在当前扫描结果中，请重新扫描":
    "Skill missing from the current scan. Scan again",
  接口不存在: "Endpoint not found",
  "需要 JSON 请求": "A JSON request is required",
  消息过长: "Message too long",
  定时任务不存在: "Schedule not found",
  "当前测试后台未启用结果汇报。":
    "Result reporting is disabled in this test service.",
  "会话已离开当前观测范围，请刷新后重试。":
    "This session left the current observation scope. Refresh and try again.",
  请选择有效项目目录: "Select a valid project directory",
  请求参数无效: "Invalid request parameters",
  操作失败: "Action failed",
  服务地址不可用: "Service address unavailable",
  "ACD 服务启动失败，请检查端口、运行中的实例和数据目录权限。":
    "ACD could not start. Check the port, running instances, and data directory permissions.",
  "请选择已接入且可执行的 Agent":
    "Select a connected Agent that can execute tasks",
  单次执行时间必须在未来: "One-time execution must be scheduled in the future",
  请设置未来的单次执行时间: "Set a future time for one-time execution",
  "定时任务已更新，请依据最新计划重新确认":
    "The schedule changed. Review the latest schedule and confirm again",
  "此单次计划已结束，请编辑后重新启用":
    "This one-time schedule ended. Edit it before enabling again",
  "单次时间已过，请编辑后重新启用":
    "The one-time date has passed. Edit it before enabling again",
  "已交给任务队列；执行结果以关联任务为准。":
    "Added to the task queue. Check the linked task for execution results.",
  "后台离线或唤醒延迟，错过的时间不补跑；周期计划已移到下次。":
    "The service was offline or woke late. Missed runs are skipped; recurring schedules moved to the next run.",
  "此计划上一轮仍在运行、排队或待核对，本轮已跳过。":
    "The previous run is running, queued, or awaiting verification. This run was skipped.",
  "工作目录或执行 Agent 当前不可用，本轮未启动；请检查计划设置。":
    "The working directory or Agent is unavailable. This run did not start; check schedule settings.",
  计划已更新: "Schedule changed",
  "定时触发「{v0}」，结果将在此对话汇报。":
    "Scheduled run “{v0}” triggered. Results will be reported in this conversation.",
  "后台已重启，本轮需核对原任务；未自动重跑。":
    "The service restarted. Check the original task for this run; no automatic retry.",
  "无法计算下次执行时间，请修改时间规则":
    "Could not calculate the next run. Change the time rule",
  需要确认操作: "Operation needs approval",
  需要补充信息: "More information needed",
  任务等待人工检查: "Task awaits review",
  执行状态需要核对: "Execution status needs verification",
  任务已阻塞: "Task blocked",
  任务执行失败: "Task failed",
  任务需要你处理: "Task needs your attention",
  任务完成报告: "Task completion report",
  本轮执行结果: "Turn results",
  总控需要处理: "Controller needs attention",
  此服务只接受本机客户端: "This service only accepts local clients",
  客户端未认证: "Client not authenticated",
  这份报告不可用: "This report is unavailable",
  已启用: "Enabled",
  已暂停: "Paused",
  已结束: "Finished",
  无: "None",
  "总控模型已更改，请重新分析。":
    "The controller model changed. Analyze again.",
  "语言设置已更改，请重新分析。":
    "The language setting changed. Analyze again.",
  允许这次操作: "Allow this action",
  始终允许此操作: "Always allow",
  拒绝这次操作: "Reject once",
  始终拒绝此操作: "Always reject",
  选择: "Select",
  确认: "Confirm",
  拒绝: "Decline",
  取消: "Cancel",
  取消选择: "Cancel selection",
  工具: "tool",
  "请求网络访问：{v0}://{v1}": "Network access requested: {v0}://{v1}",
  "Codex 的此类请求暂不支持，已拒绝该请求。":
    "This Codex request type is unsupported and was rejected.",
  "Codex 的问题已结束，等待执行反馈。":
    "The Codex question closed. Waiting for execution feedback.",
  "Codex 请求修改文件。": "Codex requests a file change.",
  "Codex 正在准备文件修改。": "Codex is preparing file changes.",
  "Codex 正在执行命令。": "Codex is running a command.",
  "Codex 启动事件超过限制，执行状态待核对。":
    "Codex startup events exceeded the limit. Verify execution status.",
  "Codex 协议处理失败，执行状态待核对。":
    "Codex protocol processing failed. Verify execution status.",
  "Codex 未能确认任务开始，执行状态待核对。":
    "Codex did not confirm task startup. Verify execution status.",
  "Codex 未能建立任务会话，请检查原生登录和配置。":
    "Codex could not create the task session. Check native login and configuration.",
  "Claude 的工具权限被拒绝；此适配器暂不支持交互授权，请在原生端处理。":
    "Claude tool permission was denied. This adapter does not support interactive approval; handle it in the native app.",
  "Claude 未返回明确成功结果，请核对原生输出与模型配置。":
    "Claude returned no explicit success result. Check native output and model configuration.",
  "Claude 进程已停止，已有修改保留。":
    "The Claude process stopped. Existing changes are retained.",
  "Claude 已退出且未返回明确结果，请核对原生执行。":
    "Claude exited without an explicit result. Check native execution.",
  "Claude 没有可确认的活动执行。": "Claude has no verifiable active execution.",
  "Claude 进程停止未确认，请核对原生执行。":
    "Claude process termination is unconfirmed. Check native execution.",
  "Claude 未在时限内退出，请人工核对，已有修改保留。":
    "Claude did not exit before the deadline. Check manually; existing changes are retained.",
  "OpenCode 返回了无法处理的授权请求，请在原生端核对。":
    "OpenCode returned an unsupported approval request. Check it in the native app.",
  "OpenCode 授权请求已结束，等待执行反馈。":
    "The OpenCode approval request closed. Waiting for execution feedback.",
  "OpenCode 请求工具授权": "OpenCode requests tool approval",
  "OpenCode 正在调用工具": "OpenCode is using a tool",
  "OpenCode 工具调用结束，等待后续反馈。":
    "The OpenCode tool call ended. Waiting for further feedback.",
  "OpenCode 正在处理工具调用。": "OpenCode is processing a tool call.",
  "OpenCode ACP 不支持中途追加；请停止后显式续接。":
    "OpenCode ACP does not support input during execution. Stop and explicitly resume.",
  "OpenCode 授权请求已失效或选项无效。":
    "The OpenCode approval request expired or its choice is invalid.",
  "OpenCode 未正常结束本轮，可能有部分结果，请核对后再继续。":
    "OpenCode did not finish this turn normally. Partial results may exist; check before continuing.",
  "OpenCode 执行连接或模型请求失败，请在原生端核对。":
    "The OpenCode execution connection or model request failed. Check the native app.",
  "OpenCode 无法续接原会话，请检查原生版本、登录和会话状态。":
    "OpenCode could not resume the original session. Check the native version, login, and session status.",
  "OpenCode 未能建立任务会话，请检查原生登录与模型配置。":
    "OpenCode could not create the task session. Check native login and model configuration.",
  "Pi 的输入请求已过期或取消，等待后续反馈。":
    "The Pi input request expired or was cancelled. Waiting for further feedback.",
  "Pi 拒绝了协议输入，执行状态待核对。":
    "Pi rejected protocol input. Verify execution status.",
  "Pi 已结束本轮，但未返回正常完成结果，请核对原生输出。":
    "Pi ended this turn without a normal completion result. Check native output.",
  "Pi 正在使用工具：": "Pi is using tool: ",
  "Pi 正在重试原生模型请求。": "Pi is retrying the native model request.",
  "Pi 正在整理上下文。": "Pi is compacting context.",
  "Pi 返回了冲突或过多的输入请求。":
    "Pi returned conflicting or excessive input requests.",
  "Pi 的此类界面交互暂不支持，已取消该交互。":
    "This Pi UI interaction is unsupported and was cancelled.",
  "Pi 请求补充信息": "Pi requests more information",
  "Pi 已断开且没有明确结束事件，请核对执行结果。":
    "Pi disconnected without an explicit completion event. Check execution results.",
  "Pi 没有活动执行。": "Pi has no active execution.",
  "Pi 输入请求已失效。": "The Pi input request expired.",
  "Pi 选项无效。": "Invalid Pi choice.",
  "Pi 尚未配置可用模型，请先在 Pi 中选择模型。":
    "Pi has no available model configured. Select a model in Pi first.",
  "Pi 已由扩展处理该输入，但没有可核验的执行结果。":
    "A Pi extension handled this input, but no verifiable execution result is available.",
  "Pi 未能接收任务或协议连接失败，请检查原生模型与登录配置。":
    "Pi could not accept the task or its protocol connection failed. Check native model and login configuration.",
  "Codex 已确认停止，已有修改保留。":
    "Codex confirmed it stopped. Existing changes are retained.",
  "Codex 未正常结束本轮，请核对原生执行结果。":
    "Codex did not finish this turn normally. Check native execution results.",
  "Codex 返回了无法识别的协议记录。":
    "Codex returned an unrecognized protocol record.",
  "Codex 协议连接已结束或记录无效，执行状态待核对。":
    "Codex protocol connection ended or records were invalid. Verify execution status.",
  "Codex 程序无法启动，请检查安装与执行权限。":
    "Codex could not start. Check installation and execution permissions.",
  "Codex 输入连接中断，执行状态待核对。":
    "Codex input connection broke. Verify execution status.",
  "Codex 已断开且未返回明确结束事件，请核对执行结果。":
    "Codex disconnected without an explicit completion event. Check execution results.",
  "Codex 停止请求未确认，请核对原生执行。":
    "Codex did not confirm the stop request. Check native execution.",
  "Codex 未在时限内确认停止，请人工核对，已有修改保留。":
    "Codex did not confirm stopping before the deadline. Check manually; existing changes are retained.",
  "Codex 没有可确认的活动连接。": "Codex has no verifiable active connection.",
  "Codex 协议连接已关闭，执行状态待核对。":
    "Codex protocol connection closed. Verify execution status.",
  "Claude 已确认停止，已有修改保留。":
    "Claude confirmed it stopped. Existing changes are retained.",
  "Claude 未正常结束本轮，请核对原生执行结果。":
    "Claude did not finish this turn normally. Check native execution results.",
  "Claude 返回了无法识别的协议记录。":
    "Claude returned an unrecognized protocol record.",
  "Claude 协议连接已结束或记录无效，执行状态待核对。":
    "Claude protocol connection ended or records were invalid. Verify execution status.",
  "Claude 程序无法启动，请检查安装与执行权限。":
    "Claude could not start. Check installation and execution permissions.",
  "Claude 输入连接中断，执行状态待核对。":
    "Claude input connection broke. Verify execution status.",
  "Claude 已断开且未返回明确结束事件，请核对执行结果。":
    "Claude disconnected without an explicit completion event. Check execution results.",
  "Claude 停止请求未确认，请核对原生执行。":
    "Claude did not confirm the stop request. Check native execution.",
  "Claude 未在时限内确认停止，请人工核对，已有修改保留。":
    "Claude did not confirm stopping before the deadline. Check manually; existing changes are retained.",
  "Claude 没有可确认的活动连接。":
    "Claude has no verifiable active connection.",
  "Claude 协议连接已关闭，执行状态待核对。":
    "Claude protocol connection closed. Verify execution status.",
  "OpenCode 已确认停止，已有修改保留。":
    "OpenCode confirmed it stopped. Existing changes are retained.",
  "OpenCode 未正常结束本轮，请核对原生执行结果。":
    "OpenCode did not finish this turn normally. Check native execution results.",
  "OpenCode 返回了无法识别的协议记录。":
    "OpenCode returned an unrecognized protocol record.",
  "OpenCode 协议连接已结束或记录无效，执行状态待核对。":
    "OpenCode protocol connection ended or records were invalid. Verify execution status.",
  "OpenCode 程序无法启动，请检查安装与执行权限。":
    "OpenCode could not start. Check installation and execution permissions.",
  "OpenCode 输入连接中断，执行状态待核对。":
    "OpenCode input connection broke. Verify execution status.",
  "OpenCode 已断开且未返回明确结束事件，请核对执行结果。":
    "OpenCode disconnected without an explicit completion event. Check execution results.",
  "OpenCode 停止请求未确认，请核对原生执行。":
    "OpenCode did not confirm the stop request. Check native execution.",
  "OpenCode 未在时限内确认停止，请人工核对，已有修改保留。":
    "OpenCode did not confirm stopping before the deadline. Check manually; existing changes are retained.",
  "OpenCode 没有可确认的活动连接。":
    "OpenCode has no verifiable active connection.",
  "OpenCode 协议连接已关闭，执行状态待核对。":
    "OpenCode protocol connection closed. Verify execution status.",
  "Pi 已确认停止，已有修改保留。":
    "Pi confirmed it stopped. Existing changes are retained.",
  "Pi 未正常结束本轮，请核对原生执行结果。":
    "Pi did not finish this turn normally. Check native execution results.",
  "Pi 返回了无法识别的协议记录。":
    "Pi returned an unrecognized protocol record.",
  "Pi 协议连接已结束或记录无效，执行状态待核对。":
    "Pi protocol connection ended or records were invalid. Verify execution status.",
  "Pi 程序无法启动，请检查安装与执行权限。":
    "Pi could not start. Check installation and execution permissions.",
  "Pi 输入连接中断，执行状态待核对。":
    "Pi input connection broke. Verify execution status.",
  "Pi 已断开且未返回明确结束事件，请核对执行结果。":
    "Pi disconnected without an explicit completion event. Check execution results.",
  "Pi 停止请求未确认，请核对原生执行。":
    "Pi did not confirm the stop request. Check native execution.",
  "Pi 未在时限内确认停止，请人工核对，已有修改保留。":
    "Pi did not confirm stopping before the deadline. Check manually; existing changes are retained.",
  "Pi 没有可确认的活动连接。": "Pi has no verifiable active connection.",
  "Pi 协议连接已关闭，执行状态待核对。":
    "Pi protocol connection closed. Verify execution status.",
  "微信会话已失效，请重新扫码连接。":
    "The WeChat session expired. Scan again to reconnect.",
  "无法恢复微信连接，请重新扫码；没有重放未确认的操作。":
    "WeChat could not reconnect. Scan again; unconfirmed operations were not replayed.",
  "微信连接正在更新，请稍后重试":
    "The WeChat connection is being updated. Try again later",
  请选择有效的微信任务工作目录:
    "Select a valid working directory for WeChat tasks",
  请先扫码连接微信: "Scan to connect WeChat first",
  微信未返回可用二维码: "WeChat returned no usable QR code",
  "微信登录失败，请刷新二维码重试。":
    "WeChat login failed. Refresh the QR code and try again.",
  "无法获取微信二维码，请检查网络后重试。":
    "Could not load the WeChat QR code. Check your network and try again.",
  "请填写手机显示的 4 至 8 位验证码":
    "Enter the 4–8 digit verification code shown on your phone",
  微信登录结果不完整: "The WeChat login result is incomplete",
  "二维码已过期或验证被锁定，请重新扫码。":
    "The QR code expired or verification was locked. Scan again.",
  微信返回的跳转地址不完整: "WeChat returned an incomplete redirect URL",
  "该机器人已绑定，请在微信解除旧绑定后重新连接。":
    "This bot is already linked. Unlink it in WeChat before reconnecting.",
  "二维码已过期，请重新获取。": "The QR code expired. Request a new one.",
  "请先恢复微信连接，再测试回传消息":
    "Resume the WeChat connection before testing message delivery",
  "正在等待微信连接，请连接成功后再测试":
    "Waiting for WeChat to connect. Test after it connects",
  "请先在微信发送 /帮助，再测试回传消息":
    "Send /帮助 in WeChat before testing message delivery",
  "ACD 测试消息：微信回传链路已提交。请确认手机实际收到。":
    "ACD test message: the WeChat delivery request was submitted. Confirm receipt on your phone.",
  "测试消息提交结果待核对，请检查手机；未自动重发。":
    "The test message submission needs verification. Check your phone; it was not resent automatically.",
  "微信已接受测试请求，但未返回消息编号，手机送达待核对。":
    "WeChat accepted the test request without a message ID. Check delivery on your phone.",
  "微信登录凭证不可用，请重新扫码":
    "WeChat login credentials are unavailable. Scan again",
  "任务 {v0}\n{v1} · {v2}\n{v3}{v4}": "Task {v0}\n{v1} · {v2}\n{v3}{v4}",
  "需要补充信息\n{v0}\n/回答 {v1} 你的说明":
    "More information needed\n{v0}\n/回答 {v1} <your explanation>",
  "\n问题 {v0}：{v1}\n回答：/回答 {v2} {v3}":
    "\nQuestion {v0}: {v1}\nReply: /回答 {v2} {v3}",
  "\n…内容较长，请在桌面查看完整记录。":
    "\n…Content truncated. View the complete record in the desktop app.",
  "部分反馈未能确认是否提交，请在微信发送 /状态 核对；没有自动重发。":
    "Some feedback submissions are unconfirmed. Send /状态 in WeChat to check; nothing was resent automatically.",
  微信消息列表格式无效: "Invalid WeChat message list format",
  "单批微信消息超过 100 条，已暂停接入，本批未执行。请在桌面核对后重新连接。":
    "This WeChat batch exceeded 100 messages. Receiving is paused and this batch was not executed. Check the desktop app before reconnecting.",
  "微信连接中断，正在重连；已接收的任务继续在本机执行。":
    "WeChat disconnected and is reconnecting. Received tasks continue locally.",
  不是已完成的用户消息: "Not a complete user message",
  当前仅支持绑定者私聊:
    "Only direct messages from the linked user are supported",
  消息发送者与扫码绑定者不一致: "Message sender does not match the linked user",
  消息接收者与当前绑定不一致:
    "Message recipient does not match the current connection",
  消息没有可用编号: "Message has no usable ID",
  "目前只支持文字指令。发送 /帮助 查看用法。":
    "Only text instructions are supported. Send /帮助 for usage.",
  "消息过长，请拆成几条文字消息。":
    "Message too long. Split it into multiple text messages.",
  "直接发文字交代任务，或补充已有要求。\n/状态 查看任务和待处理问题\n/报告 查看最近完成报告与建议\n/停止 <完整任务编号>\n/完成 <完整任务编号>\n/回答 <完整问题编号> <选项或说明>\n新任务只使用本机设置的微信工作目录。":
    "Send text to assign a task or update requirements.\n/状态 View tasks and questions\n/报告 View the latest completion report and recommendations\n/停止 <full task ID>\n/完成 <full task ID>\n/回答 <full question ID> <choice or explanation>\nNew tasks use the WeChat working directory configured on this computer.",
  "暂时没有完成报告，发送 /状态 查看执行进展。":
    "No completion reports yet. Send /状态 for execution progress.",
  "停止请求已处理。\n": "Stop request processed.\n",
  "已确认交付完成。": "Delivery confirmed complete.",
  "格式：/回答 <问题编号> <选项或说明>":
    "Usage: /回答 <question ID> <choice or explanation>",
  "回答已提交。": "Answer submitted.",
  "未识别这个指令，请发送 /帮助 查看用法。":
    "Unknown command. Send /帮助 for usage.",
  "收到，我来处理。": "Got it. I’ll handle it.",
  "这次操作未能确认完成，请发送 /状态 核对，或在桌面总控查看原因。不要重复授权不确定的操作。":
    "This operation’s completion is unconfirmed. Send /状态 or check the desktop controller for details. Do not authorize uncertain operations again.",
  "有 {v0} 条此前操作的结果待核对，没有自动重放。请在桌面检查任务。\n\n":
    "There are {v0} earlier operations with unconfirmed results. Nothing was replayed automatically. Check tasks in the desktop app.\n\n",
  "暂无任务。": "No tasks.",
  "\n结果摘要：": "\nResult summary: ",
  你的说明: "your explanation",
  等待执行: "Queued",
  执行中: "Running",
  等你处理: "Needs your attention",
  已阻塞: "Blocked",
  待检查: "Awaiting review",
  已完成: "Completed",
  失败: "Failed",
  正在停止: "Stopping",
  已停止: "Stopped",
  状态待确认: "Status unconfirmed",
  "消息位置已失效，请刷新消息中心":
    "Message position expired. Refresh the notification center",
  "消息位置已失效，请刷新后重试":
    "Message position expired. Refresh and try again",
  未接入: "Not connected",
  当前不可用: "Currently unavailable",
  尚未适配: "Unsupported",
  "不支持{capabilities}": "Does not support {capabilities}",
  执行中追加: "Add instructions while running",
  会话续接: "Resume sessions",
  授权交互: "Interactive approval",
  文字输入: "Text input",
  任务要求包含未知的执行能力: "The task requires an unknown capability",
  "指定 Agent 编号不能为空": "The target Agent ID cannot be empty",
  未找到该执行者: "Agent not found",
  "指定 Agent 无法承接任务：{why}；未改派给其他 Agent。":
    "The selected Agent cannot accept this task: {why}. No other Agent was assigned.",
  "{reason}未采用（{why}）": "{reason} was skipped ({why})",
  "{reason}，交给 {name}。": "{reason}; assigned to {name}.",
  按本次指定: "Explicit selection",
  "项目优先级第 {index} 位（{id}）": "Project priority {index} ({id})",
  "全局优先级第 {index} 位（{id}）": "Global priority {index} ({id})",
  "没有满足本次要求的已接入 Agent，任务尚未启动。":
    "No connected Agent meets these requirements. The task has not started.",
  "只有一个符合要求的 Agent": "Only one eligible Agent",
  采用总控的执行者建议: "Using the controller’s Agent recommendation",
  "总控未给出符合要求的执行者，请明确选择 Agent 后重试；任务尚未启动。":
    "The controller did not suggest an eligible Agent. Select an Agent explicitly and retry; the task has not started.",
  "已发现 Windows 命令包装器，尚未支持安全执行，请选择原生可执行程序。":
    "A Windows command wrapper was found. Safe execution is unsupported; select a native executable.",
  "已发现安装；尚未验证程序启动、账号或模型权限。":
    "Installation found. Startup, account, and model permissions have not been verified.",
  "已发现安装；执行适配尚未接入。":
    "Installation found. Execution adapter is not connected.",
  请提供可执行程序的绝对路径: "Provide the absolute path to the executable",
  所选路径不是可执行文件: "The selected path is not an executable file",
  "已添加程序路径，选择后检查能否启动。":
    "Program path added. Select it to check startup.",
  "已记录程序路径；执行协议尚未适配，不会调用该程序。":
    "Program path recorded. Its execution protocol is unsupported; the program will not be called.",
  "执行适配尚未接入，不能确认可管理。":
    "Execution adapter is not connected. Manageability cannot be verified.",
  "程序无法启动。": "The program cannot start.",
  "程序启动检查超时；尚未验证账号和模型权限。":
    "Startup check timed out. Account and model permissions have not been verified.",
  "程序启动检查输出异常，已终止检查。":
    "Startup check output was invalid. The check was stopped.",
  "程序无法启动，请检查安装路径和执行权限。":
    "The program cannot start. Check its installation path and execution permissions.",
  "Pi 需要可验证的 0.84.3 或更新版本，以可靠识别执行结束。":
    "Pi requires a verifiable version 0.84.3 or later to detect execution completion reliably.",
  "程序可启动，账号和模型权限待真实执行验证。":
    "The program can start. Account and model permissions await verification during actual execution.",
  "程序启动检查失败；尚未验证账号和模型权限。":
    "Startup check failed. Account and model permissions have not been verified.",
  "{kind} 的执行适配尚未接入。":
    "The execution adapter for {kind} is not connected.",
  "共享技能目录 · 加载未验证": "Shared skills directory · loading unverified",
  "Codex 本地技能目录": "Codex local skills directory",
  "Claude 兼容技能目录": "Claude-compatible skills directory",
  "OpenCode 技能目录": "OpenCode skills directory",
  "Pi 技能候选目录": "Pi candidate skills directory",
  "Hermes 技能候选目录": "Hermes candidate skills directory",
  "OpenClaw 工作区技能候选目录":
    "OpenClaw workspace candidate skills directory",
  "DeepSeek Harness 技能候选目录":
    "DeepSeek Harness candidate skills directory",
  "项目共享技能目录 · 加载未验证":
    "Project shared skills directory · loading unverified",
  "项目 Codex 技能候选目录": "Project Codex candidate skills directory",
  "项目 Claude 兼容技能目录": "Project Claude-compatible skills directory",
  "项目 OpenCode 技能目录": "Project OpenCode skills directory",
  技能路径不是普通文件: "Skill path is not a regular file",
  "技能文件超过 2 MiB，未读取内容":
    "Skill file exceeds 2 MiB; content was not read",
  "缺少完整 YAML frontmatter，未识别为有效 Skill":
    "Missing complete YAML frontmatter; not recognized as a valid Skill",
  "YAML 元信息格式无效": "Invalid YAML metadata",
  "name 缺失或超过 64 字符": "name is missing or exceeds 64 characters",
  "description 缺失或超过 1024 字符":
    "description is missing or exceeds 1024 characters",
  名称不符合标准的小写连字符格式:
    "Name does not use the standard lowercase hyphenated format",
  "已跳过技能目录之外的链接：{path}":
    "Skipped a link outside the skills directory: {path}",
  "已跳过技能目录之外的文件链接：{path}":
    "Skipped a file link outside the skills directory: {path}",
  技能文件无法读取: "Skill file could not be read",
  "技能目录无法读取：{path}": "Could not read skills directory: {path}",
  "扫描已达到 10000 项上限，请缩小技能目录范围":
    "The scan reached its 10,000-item limit. Narrow the skills directory scope",
  "存在同名但不同路径的 Skill，请核对来源与版本":
    "Skills with the same name exist at different paths. Check their sources and versions",
  无效技能文件: "Invalid skill file",
  "技能路径已变更或超出扫描范围，请重新扫描":
    "Skill path changed or is outside the scan scope. Scan again",
  "技能目录包含越界链接，未修改文件":
    "The skills directory contains an out-of-scope link. No files were changed",
  只能修改当前技能目录中的文件:
    "Only files inside the current skills directory may be changed",
  不能将文件系统根目录用作技能目录:
    "The filesystem root cannot be used as a skills directory",
  技能根路径不是目录: "The skills root path is not a directory",
  "技能回收区路径无效，未修改文件":
    "Invalid skill trash path. No files were changed",
  "名称须为 1–64 位小写字母、数字和单连字符":
    "Name must contain 1–64 lowercase letters, digits, and single hyphens",
  "用途说明须为 1–1024 个字符": "Description must contain 1–1,024 characters",
  "技能内容不能为空，且不能超过 48 KiB":
    "Skill content must not be empty or exceed 48 KiB",
  "同名目录已存在，不会覆盖原文件":
    "A directory with this name exists. Existing files will not be overwritten",
  "技能目录已变更，请重新扫描": "Skills directory changed. Scan again",
  不能删除技能根目录或回收区:
    "The skills root directory or trash cannot be deleted",
  "该目录包含其他技能，请分别处理":
    "This directory contains other skills. Handle them separately",
  无效回收记录: "Invalid trash entry",
  回收记录不存在或已恢复: "Trash entry is missing or was already restored",
  回收记录已变更: "Trash entry changed",
  "原目录超出技能范围，未恢复":
    "The original directory is outside the skill scope. Nothing was restored",
  "原位置已存在文件或目录，不能覆盖恢复":
    "A file or directory exists at the original location. Restore cannot overwrite it",
  "模型列表为空，可手动填写模型 ID":
    "The model list is empty. Enter a model ID manually",
  "模型列表过大，请手动填写模型 ID":
    "The model list is too large. Enter a model ID manually",
  "服务未返回有效模型列表，可继续手动填写模型 ID":
    "The service returned no valid model list. Enter a model ID manually",
  "获取模型列表超时，可重试或手动填写":
    "Loading models timed out. Retry or enter a model ID manually",
  "无法连接模型列表接口，请检查地址和网络；也可手动填写模型 ID":
    "Could not connect to the model list endpoint. Check the URL and network, or enter a model ID manually",
  "模型列表认证失败，请检查此服务的 API Key 与访问权限":
    "Model list authentication failed. Check this service’s API Key and access permissions",
  "此地址未提供模型列表接口，请手动填写模型 ID":
    "This URL has no model list endpoint. Enter a model ID manually",
  "模型列表请求过于频繁，请稍后重试":
    "Too many model list requests. Try again later",
  "获取模型列表失败（HTTP {status}），可手动填写模型 ID":
    "Loading models failed (HTTP {status}). Enter a model ID manually",
  "此接口没有返回标准模型列表，请手动填写模型 ID":
    "The endpoint returned no standard model list. Enter a model ID manually",
  "模型列表分页信息无效，请手动填写模型 ID":
    "Invalid model list pagination. Enter a model ID manually",
  原生会话同步已取消: "Native session sync cancelled",
  "Codex 原生会话同步超时": "Codex native session sync timed out",
  "无法启动 Codex 只读连接代理":
    "Could not start the Codex read-only connection proxy",
  "Codex 未提供可连接的控制端点，原生会话尚未同步":
    "Codex provided no connectable control endpoint. Native sessions have not synced",
  "Codex 原生会话连接已断开": "Codex native session connection closed",
  "Codex 会话响应超过读取上限":
    "Codex session response exceeded the read limit",
  "Codex 只读会话接口不可用": "Codex read-only session API unavailable",
  "Codex 会话协议响应不完整": "Incomplete Codex session protocol response",
  "Codex 已加载会话过多或分页异常，本轮未完成同步":
    "Too many loaded Codex sessions or invalid pagination. This sync did not complete",
  "Codex 返回的会话标识不一致": "Codex returned a mismatched session ID",
  "Codex 会话 ": "Codex session ",
  "Codex 正在执行": "Codex is running",
  "等待输入或授权，请在 Codex 中处理":
    "Waiting for input or approval. Handle it in Codex",
  "会话当前空闲，不代表任务已验收完成":
    "The session is idle. Task acceptance is still unconfirmed",
  "原生会话发生错误，请在 Codex 中查看":
    "The native session encountered an error. Check Codex",
  "原生会话未加载，当前状态未知":
    "Native session not loaded. Current status is unknown",
  "已同步原生会话，仅供查看": "Native sessions synced for viewing only",
  "Codex 会话接口版本不兼容，未完成同步":
    "Incompatible Codex session API version. Sync did not complete",
  只读会话连接已结束: "Read-only session connection ended",
  "此 Agent 的原生会话观测尚未接入":
    "Native session observation is not connected for this Agent",
  原生会话未同步: "Native sessions not synced",
  "连接已断开，当前状态未知": "Disconnected. Current status is unknown",
  会话记录与指定会话编号不一致:
    "Session record does not match the requested session ID",
  尚未读取到执行状态事件: "No execution status event has been read",
  派生会话的执行归属待核验:
    "Derived session execution ownership needs verification",
  本轮已中止: "This turn was aborted",
  本轮执行已结束: "This turn ended",
  "Codex 正在分析": "Codex is analyzing",
  "Codex 正在生成回复": "Codex is generating a response",
  "Codex 正在执行命令": "Codex is running a command",
  "命令执行结束，Codex 继续处理中":
    "Command finished. Codex continues processing",
  "Codex 正在调用工具": "Codex is using a tool",
  "工具调用结束，Codex 继续处理中":
    "Tool call finished. Codex continues processing",
  "当前 Windows 版本尚未接入执行记录的进程核验":
    "Process verification for execution records is unavailable on this Windows version",
  无法核验执行记录所属用户: "Could not verify the execution record owner",
  "无法核验 Codex 执行记录的写入进程":
    "Could not verify the process writing Codex execution records",
  会话标识不一致: "Session ID mismatch",
  执行记录不是普通文件: "Execution record is not a regular file",
  "执行事件不完整，状态待核验":
    "Incomplete execution events. Status needs verification",
  "执行事件超过读取上限，状态待核验":
    "Execution events exceeded the read limit. Status needs verification",
  执行记录缺少可核验的会话标识: "Execution record has no verifiable session ID",
  "会话已进入新一轮执行，请刷新后重试。":
    "The session started a new turn. Refresh and try again.",
  "会话记录已变化，请刷新后重试。":
    "Session records changed. Refresh and try again.",
  "本机未找到可核验的 Codex 执行记录目录":
    "No verifiable Codex execution record directory was found on this computer",
  "执行记录暂时不可读，状态待核验":
    "Execution records are temporarily unreadable. Status needs verification",
  本机会话: "Local session",
  "缺少近期执行事件，当前状态待核验":
    "No recent execution events. Current status needs verification",
  "未检测到写入进程，当前状态待核验":
    "No writer process detected. Current status needs verification",
  "部分执行记录未核验，已确认执行 {count} 个会话":
    "Some execution records are unverified. {count} sessions are confirmed running",
  "已核验 Codex 执行记录，正在执行 {count} 个会话":
    "Codex execution records verified. {count} sessions are running",
  "未取得可核验的 Codex 当前执行记录":
    "No verifiable current Codex execution records available",
  "微信返回的服务地址不受支持，请重新连接":
    "WeChat returned an unsupported service URL. Reconnect",
  "微信接口暂不可用，请检查连接或重新扫码":
    "The WeChat API is unavailable. Check the connection or scan again",
  微信返回了空响应: "WeChat returned an empty response",
  微信响应超出处理上限: "WeChat response exceeded the processing limit",
  消息编号无法安全解析: "Message ID could not be parsed safely",
  微信响应格式无法识别: "Unrecognized WeChat response format",
  微信返回码格式无法识别: "Unrecognized WeChat response code format",
  "微信会话失效或请求被拒绝，请重新扫码连接":
    "The WeChat session expired or the request was rejected. Scan again to connect",
  "请先在微信给 ACD 发一条消息，再接收反馈":
    "Send ACD a message in WeChat before receiving feedback",
  "已记住。你可以在设置的「个人记忆」中查看或修改。":
    "Remembered. View or edit it under Personal memory in Settings.",
  "没有新增记忆。你可以到设置的「个人记忆」中查看或手动维护。":
    "No new memory was added. View or maintain personal memory in Settings.",
  "记忆中不能包含凭证。": "Memory cannot contain credentials.",
  "个人记忆数量已达上限。": "The personal memory limit has been reached.",
  "这条记忆不存在。": "This memory entry does not exist.",
  "这条记忆已更新，请刷新后重试。":
    "This memory entry changed. Refresh and try again.",
  "已记住 {count} 条偏好，可以在设置的「个人记忆」中查看或修改。":
    "Remembered {count} preferences. View or edit them under Personal memory in Settings.",
  "请先明确要核实的原任务，本次查询未执行其他操作。":
    "Identify the original task to verify. This inquiry did not perform other operations.",
  "历史记录未定位到可询问的执行来源，请指定原任务。":
    "History did not identify an execution source to ask. Specify the original task.",
  "本次仅核实原任务结果，请明确仍需确认的信息。":
    "This inquiry only verifies the original result. Specify what still needs confirmation.",
  "当前 Codex 协议或工具配置不支持安全核实，未开始追问。":
    "The current Codex protocol or tool configuration does not support a safely isolated inquiry. No inquiry was started.",
  "已查询历史记录，仍缺少足够的结果证据。请明确要核实的任务。":
    "History was checked, but result evidence is still insufficient. Specify the task to verify.",
  "请先查询并明确关联任务，再向执行 Agent 核实。":
    "Search history and identify the associated task before asking its agent.",
  "历史记录中有多个相关任务，请指定要向哪项任务的执行 Agent 核实。":
    "History contains several related tasks. Specify which task's agent to ask.",
  "原执行会话或 Agent 当前不可用，请明确要核实的任务。":
    "The original session or agent is unavailable. Specify the task to verify.",
  "原执行 Agent 暂不支持安全的历史核实，已保留历史查询结果。":
    "The original agent does not support an isolated historical inquiry. The history results remain available.",
  "核实 · {v0}": "Verify \u00b7 {v0}",
  "已查阅历史，正在向 {v0} 核实这项任务的结果。":
    "History has been checked. Asking {v0} to verify this task's result.",
  "本次历史查询已结束，请明确要核实的任务。":
    "This history lookup has finished. Specify the task to verify.",
  "本次只核实先前执行结果，依据会话历史回答。不要重新执行原任务或发起写入、提交、推送等操作。":
    "Verify the previous execution result using the conversation history. Do not repeat the original task or write files, commit, or push.",
  原任务标题: "Original task title",
  用户本轮问题: "Current user question",
  待核实内容: "Information to verify",
  "请明确区分已有执行证据、计划和仍不能确认的事项。":
    "Distinguish execution evidence from plans and matters that remain unconfirmed.",
  "核实仍在进行，请等待结果后再补充问题。":
    "The inquiry is still running. Wait for its result before adding another question.",
};
