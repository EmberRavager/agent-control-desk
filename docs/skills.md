# 本地 Skill 管理

本页介绍桌面端和 CLI 的技能目录管理。返回 [中文 README](../README.zh-CN.md) 或 [English README](../README.md)。

## 桌面端

桌面端的“技能（skill）”入口用于管理本机 Skill。可以扫描全局目录，或明确选择一个项目加入扫描；按名称、说明、作用范围查找，查看 `SKILL.md` 预览和来源路径，也可在本地文件夹中定位原文件。新建时选择目标目录并填写名称、用途和正文；删除前显示涉及的目录及共享来源，确认后移入可恢复的回收区。

右侧详情的“翻译”使用已配置的总控模型，将用途说明和 SKILL.md 预览翻译为中文；可切回原文，不修改技能文件，也不写入总控对话。只在点击时将所选内容发送到配置的模型服务。长文件最多翻译前 12,000 字，界面会标明范围；译文只保留在当前详情视图中。

## CLI

CLI 提供相同的管理能力：

```sh
acd skills scan
acd skills scan --project /absolute/path/to/project
acd skills list
acd skills list --json
acd skills show <技能编号>
acd skills create --root /absolute/path/to/skills --name my-workflow --description "用途说明" --content "技能正文"
acd skills delete <技能编号>
acd skills trash
acd skills restore <回收编号>
```

## 扫描范围与行为边界

`scan` 默认只扫描已知全局技能目录，不自动把当前终端目录或整个用户目录当作项目扫描。`--project` 必须提供项目绝对路径，只在该项目的已知技能子目录中查找。`list` 返回最近的扫描目录，`show` 通过目录中的技能编号读取预览；不会接受任意文件路径。人类可读输出包含名称、范围、路径关联和检查提示，`--json` 保留结构化数据。

发现规则覆盖 `~/.agents/skills`、`~/.codex/skills`、`~/.claude/skills`、`~/.config/opencode/skills` 等全局目录，以及项目内 `.agents/skills`、`.codex/skills`、`.claude/skills`、`.opencode/skills`。Pi、Hermes、OpenClaw、DeepSeek Harness 的候选目录也按各自命名规则展示；这类路径关联仍需在原生 Agent 中验证实际加载行为。

新建只写入已知技能根目录，不覆盖同名文件夹。删除通过原子移动保留整个技能目录及附带资源，回收区位于技能根目录之外的同级 `.acd-skill-trash` 中，避免被原生 Agent 再次发现。恢复回到原位置；原位置已存在时明确拒绝覆盖。当前不提供永久删除、远程安装、更新、编辑或跨 Agent 的统一启用开关。解析失败、同名不同来源等情况会显示提示；“已发现”不等于“可加载”，更不等于“已用于任务”。技能全文只在用户查看时读取，不加入总控上下文或写入 SQLite。不会运行技能脚本、加载工具或修改原生 Agent 配置。

实现与协议边界见 [架构说明](architecture.md#本地技能目录)，当前验证范围见 [功能状态](product-status.md)。
