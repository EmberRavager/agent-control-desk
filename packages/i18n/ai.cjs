module.exports = {
  "总控模型请求失败（HTTP {status}）":
    "Supervisor model request failed (HTTP {status})",
  "总控模型未返回完整合法 JSON":
    "Supervisor model did not return complete valid JSON",
  总控模型返回了不符合任务协议的结果:
    "Supervisor model returned an invalid task protocol result",
  "定时任务引用了本轮上下文中不可用的执行 Agent":
    "Schedule references an agent unavailable in the current context",
  总控引用了本轮上下文中不存在的定时任务:
    "Supervisor referenced a schedule absent from the current context",
  总控引用了本轮上下文中不存在的任务:
    "Supervisor referenced a task absent from the current context",
  "总控动作与用户选中的任务不一致，未执行操作":
    "Supervisor action does not match the selected task; no action was taken",
  "技能内容为空，无法翻译。":
    "Skill content is empty and cannot be translated.",
  "翻译结果格式不正确，请重试。": "Invalid translation format. Please retry.",
  "任务摘要格式不正确，请重试。": "Invalid task summary format. Please retry.",
  "完成判定格式不正确，请重试。":
    "Invalid completion assessment format. Please retry.",
  用户目标待同步: "User goal not synced",
  "尚未取得这项任务的用户要求，当前只同步了运行状态。":
    "User requirements for this task are unavailable; only runtime status has been synced.",
  "最终产物的完成证据不足。":
    "Insufficient evidence that the final deliverable is complete.",
  "同一目录已有“{title}”。这是补充已有任务，还是独立新建？":
    "“{title}” already exists in this directory. Is this a supplement or a separate new task?",
  结果报告不存在: "Result report not found",
  "尚无最终产物。": "No final deliverable yet.",
  报告服务正在退出: "Report service is shutting down",
  暂时无法整理结果: "Unable to summarize the result right now",
  "完成判定暂时失败，可重试。":
    "Completion assessment failed temporarily. You can retry.",
  "「{title}」已交付。\n\n{summary}\n\n建议：\n{suggestions}":
    "“{title}” delivered.\n\n{summary}\n\nSuggestions:\n{suggestions}",
  "{executor} 已返回「{title}」的结果，总控判定已交付。\n{summary}":
    "{executor} returned the result for “{title}”; the supervisor assessed it as delivered.\n{summary}",
};
