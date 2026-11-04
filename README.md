# Agent Control Desk

**English** | [简体中文](README.zh-CN.md)

**One conversation. All your agents.**

Agent Control Desk (ACD) is a local control center for **task routing and multi-session management**. Give instructions in one conversation, distribute work to Codex, Claude Code, OpenCode, or Pi, and follow each task's progress, pending questions, and deliverables in one place.

Each task has its own execution session. Keep sending new work, add requirements to an existing task, answer questions, request a stop, or continue a revision. The desktop app, CLI, and personal WeChat channel share the same local service and task state.

ACD is currently a local test release, with a desktop package available for macOS ARM64.

## Why I built ACD

ACD was inspired by the idea of a personal agent. At work, I often open several agent sessions at once and give each one a different task. As those conversations accumulate, it becomes easy to lose track of what I originally asked each session to do, which requirements I added later, where the work stands, and what should happen next.

Each session works independently, but there is no central place to coordinate the work and collect reports. I have to switch between windows and reread their context to reconnect each task with its progress.

I want one conversation where I can assign work, follow the sessions, and receive their results. ACD starts with task routing and multi-session management to keep these separate executions organized around their goals.

## Core features

### Task routing and assignment

The supervisor uses your message, working directory, recent conversation, and existing tasks to distinguish discussion from requests to create, update, query, or stop work. It asks for clarification when the target is unclear. One instruction can produce several tasks; ordinary discussion does not automatically start execution.

Choose an agent for a new task, or let ACD assign one. Automatic assignment checks project and global defaults before considering eligible candidates and the supervisor's suggestion. Every candidate must be connected, available, supported, and meet the required protocol capabilities. If your explicitly selected agent cannot take the task, ACD explains why and keeps the message for you to adjust. Task details show the actual assignment reason.

Configure the supervisor model separately. Execution agents retain their own models, accounts, tools, and project settings. See [routing and assignment](docs/routing.md) for the full policy.

### Multi-session and task management

- **One entry point, separate execution sessions.** New tasks keep their own goals, progress, and results. Continuing a task preserves its original agent and session.
- **Work across projects in parallel.** Non-overlapping directories can run concurrently. Tasks in the same directory or a parent/child directory wait for access while you keep sending messages. Observed native Codex executions also participate in directory occupancy checks.
- **Handle questions centrally.** Answer task questions and supported native approval requests from the control conversation, and see what needs your attention.
- **Follow through to delivery.** The supervisor compares task goals with public results and publishes a summary and next-step suggestions when it identifies a new delivery. Managed tasks enter review before you accept them as complete or request another revision. Suggestions do not start new work automatically.
- **Observe native sessions.** View current sessions from connected Codex installations, with task titles, goals, current steps, blockers, and next steps. This is read-only observation, without importing full chat histories.
- **Keep conversations and drafts.** Task state and the control conversation persist locally. Drafts and unconfirmed sends survive reopening the window. Search and locate tasks, or retry understanding a failed message that has not entered the action-application stage.

### Everyday tools

| Feature                        | What you can do                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent connections              | Discover supported local programs or select an executable manually, then check whether the selected program starts                                             |
| Supervisor models              | Connect cloud, local, or custom compatible services; fetch model lists, search, or enter a model ID                                                            |
| Scheduled tasks                | Create one-time, interval, daily, or weekly plans; edit, pause, resume, delete, and inspect trigger records                                                    |
| Skill management               | Scan global or selected-project skills, search, preview sources, create, move to trash, and restore; translate previews into Chinese                           |
| Notification center            | Review unread items, locate tasks or questions, and configure desktop alerts, sound, and message content                                                       |
| Personal WeChat (experimental) | Pair an account so the bound user can send text requests, check progress, and answer questions; configure feedback and completion-report forwarding separately |
| Background operation           | Keep the desktop app in the menu bar or tray when its window closes; the local task service can continue after the desktop app exits                           |
| Appearance                     | Light and dark themes                                                                                                                                          |

### Supported agents

| Agent         | Create and resume tasks | Add requirements during execution | Interaction                                      |
| ------------- | ----------------------- | --------------------------------- | ------------------------------------------------ |
| Codex         | Supported               | Supported                         | Selected native approval and text-input requests |
| Claude Code   | Supported               | Not supported                     | No interactive approvals currently               |
| OpenCode      | Supported               | Not supported                     | Native permission options                        |
| Pi (≥ 0.84.3) | Supported               | Supported                         | Confirmation, selection, and text input          |

All four adapters expose a stop operation; confirmation depends on the native protocol. OpenClaw, Hermes, and DeepSeek Harness can currently be discovered, but do not have execution adapters. See [agent adapters](docs/agent-adapters.md) for details.

## Install and get started

### 1. Install ACD

On macOS ARM64, copy `Agent Control Desk.app` from the DMG or ZIP into Applications and open it. The desktop package includes its runtime; Node.js is not required. Locally built packages are written to `release/`. See [installation and distribution](docs/distribution.md) for versions, builds, and upgrades.

Current packages are for local testing, use ad-hoc signing, and are not Apple-notarized. Native Windows builds and operation still need validation.

### 2. Connect an execution agent

Install, sign in to, and configure an agent in its native tool first. Then choose it under Connections (连接) in ACD. If discovery misses the program, select its executable manually.

The connection check confirms that the program starts. Account access and actual readiness are determined by execution feedback.

### 3. Configure the supervisor model

Open Settings → Model Connection (设置 → 模型接入), choose a provider, and enter the model and required credentials. Local Ollama and LM Studio are also supported. The supervisor handles understanding, assignment, and summaries; this setting does not change the execution agent's model. See [configuration and local data](docs/configuration.md).

### 4. Send your first task

Select a working directory and enter:

> Check this project's README and tell me how to start it. Analyze only; do not modify files.

Keep automatic assignment enabled or choose an agent for this new task. Set project or global defaults under Settings → Task Assignment (设置 → 任务分配) when you want a persistent preference.

### 5. Follow progress and review the result

Use the control conversation and sidebar to follow progress, add requirements to the relevant task, and answer questions. Review the deliverable before accepting completion or requesting another revision. Changing the directory for a new task does not change existing tasks' directories.

## Common operations

### Give instructions in the control conversation

| Intent                | Example                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Split work into tasks | “Check startup instructions and test coverage separately. Analyze both without changing files.”    |
| Choose an agent       | “Give this check to Codex.” You can also use the agent selector in the composer                    |
| Update a task         | Select the task, then send: “Include edge cases; keep the other requirements.”                     |
| Check progress        | “Where does each task stand?”                                                                      |
| Stop a task           | Explicitly target the task, then send: “Stop this task and keep existing changes.”                 |
| Schedule work         | “Every day at 9 AM Asia/Shanghai, review this project's changes from the previous day and report.” |

You can also create and manage plans directly on the Scheduled Tasks (定时任务) page without a supervisor-model call. Plans use a fixed agent; the composer's per-message agent and capability options apply to immediate new tasks. See [scheduled tasks](docs/schedules.md).

### Use the CLI

Install the CLI package, or run `npm link` after building from source, to use `acd`:

```sh
acd                                      # Open the control conversation
acd send "Read-only check: explain how to start this project"
acd tasks                                # Tasks started by ACD
acd sessions                             # Observed native sessions
acd inbox                                # Notifications and unread items
acd schedules                            # Saved schedules
```

Get agent IDs from `acd agents list` before selecting an executor or setting a default:

```sh
acd send "Check the project; I need to add instructions during execution" --agent <agent-id> --require steer
acd agents default <agent-id> --project /absolute/path/to/project
```

Run `acd --help` for stop, answer, accept, and other commands. Common queries support `--json`. See [installation](docs/distribution.md) for the CLI package and the [development and CLI guide](docs/development.md) for more commands.

## Run from source

Requires Node.js ≥ 22.13.0 and npm. From the project directory:

```sh
npm ci
npm run build
npm run desktop
```

The desktop app starts or reuses the local service. Closing its window keeps it resident by default; explicitly quitting the desktop app still leaves the task service running. To stop the service, use `acd service stop`, or `node apps/cli/acd.mjs service stop` from the repository.

See the [development guide](docs/development.md) for commands, project structure, and packaging.

## Current boundaries

- Execution and state storage run locally. Keep the computer awake and the service running. Missed schedule occurrences are not replayed; an unfinished prior occurrence prevents another run of the same plan.
- ACD sends relevant conversation, summary, and report content to your configured model service. Model credentials and WeChat login are kept in the operating system credential store. See [configuration](docs/configuration.md) for data scope.
- Directory queues reduce known execution conflicts. ACD does not create Git worktrees, merge changes, or roll back edits. Requesting a stop does not undo changes already made.
- Some executions need manual reconciliation after a service restart or connection loss. ACD does not automatically take over or rerun tasks with uncertain results. See [message and task recovery](docs/message-recovery.md).
- External native-session observation currently covers Codex only, without support for steering or stopping those sessions from ACD. Personal WeChat remains experimental: phone-side message delivery and completion-report forwarding still need confirmation. Some system-notification behaviors also await real-device validation; see [feature status](docs/product-status.md).

## What's next

The current version routes tasks to agents and manages their execution sessions. The next goals are:

- **Assess task difficulty.** Understand how complex a task is to inform execution choices.
- **Route to a model.** Use task difficulty to select a suitable model from those available within the execution agent.
- **Improve decisions.** Gradually improve task understanding, decomposition, assignment, progress tracking, and delivery assessment so the supervisor keeps a clearer view of each task's goal and state.

These are future directions. Automatic execution-model selection based on task difficulty is not implemented yet.

## Documentation

Detailed guides are currently written in Chinese.

| Guide                                                    | Contents                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Installation and distribution](docs/distribution.md)    | Desktop and CLI installation, upgrades, and package builds                 |
| [Routing and assignment](docs/routing.md)                | Intent handling, defaults, capability checks, and assignment reasons       |
| [Native-session observation](docs/native-observation.md) | Codex synchronization, AI task summaries, and data scope                   |
| [Completion reports](docs/completion-reports.md)         | Delivery assessment, summaries, suggestions, and duplicate-report handling |
| [Scheduled tasks](docs/schedules.md)                     | Rules, trigger records, editing, and recovery boundaries                   |
| [Skill management](docs/skills.md)                       | Scanning, previews, translation, creation, trash, and restore              |
| [Notifications](docs/notifications.md)                   | Notification center, desktop alerts, and background residence              |
| [Personal WeChat](docs/wechat.md)                        | Pairing, text control, forwarding settings, and experimental limitations   |
| [Message and draft recovery](docs/message-recovery.md)   | Resending, retrying understanding, and reopening drafts                    |
| [Configuration and local data](docs/configuration.md)    | Supervisor models, credential storage, and local data directories          |
| [Development guide](docs/development.md)                 | Development commands, CLI operations, project structure, and packaging     |
| [Architecture](docs/architecture.md)                     | Service, persistence, adapters, and APIs                                   |
| [Feature status and validation](docs/product-status.md)  | Implementation scope, verification records, and open work                  |

## Discussion and learning

For discussion and shared learning about agent routing, session management, and local agent tools, reach me at:

Email for discussion and shared learning: **[emberravager@gmail.com](mailto:emberravager@gmail.com)**
