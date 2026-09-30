# ZHarness 用户说明书（干货版）

ZHarness 是事件驱动的编码 Agent。CLI、TUI、桌面 GUI 三种形态共享**同一个运行时与事件流**——形态不同，底层始终是同一个 Agent。下表按"终端级命令 → 会话内斜杠命令 → 桌面端能力 → 模型可用工具"分层罗列，并标注适用场景。

---

## 一、终端级 CLI 命令

入口命令为 `zharness`（见 [package.json](./package.json) 的 `bin`，指向 [dist/src/cli.js](./src/cli.js)）。命令派发逻辑见 [src/cli.ts](./src/cli.ts) 与 [src/main.ts](./src/main.ts)。

### 1. 主入口与界面切换

| 命令 | 作用 | 适用场景 |
|---|---|---|
| `zharness` | 启动交互式 TUI | 日常编码、长会话、需要分支/回放 |
| `zharness gui` | 打开本地 GUI 工作台 | 偏好图形界面、多工作区并行管理 |
| `zharness -p "..."` / `--print` | 非交互：处理完即退出 | 脚本化、CI、一次性问答 |
| `zharness "msg1" "msg2"` | 带初始消息进入交互 | 提前注入任务说明 |
| `zharness @a.md @b.png "..."` | 把文件/图片并入首条消息 | 代码评审、看图问答 |

### 2. 子命令（独立管理类）

| 命令 | 作用 | 适用场景 |
|---|---|---|
| `zharness plugin install <src> [-l]` | 安装扩展源并写入设置 | 安装第三方扩展（npm/git/本地路径） |
| `zharness plugin remove <src> [-l]` | 移除扩展（`uninstall` 为别名） | 清理不再使用的扩展 |
| `zharness plugin update [source]` | 更新已装扩展（跳过 pinned） | 升级扩展版本 |
| `zharness plugin list` | 列出已装扩展（用户级/项目级） | 排查环境、确认装载 |
| `zharness plugin --help` | 显示 plugin 组帮助 | 忘记语法 |
| `zharness config` | 打开 TUI 勾选包资源（启用/禁用 skills/themes 等） | 想关掉某些自带资源 |
| `zharness builtin list` | 列出**内置扩展**及开关状态 | 排查内置扩展是否启用 |
| `zharness builtin enable <id>` | 启用某内置扩展 | 会话内误关后无法恢复时的恢复路径 |
| `zharness builtin disable <id>` | 禁用某内置扩展 | 不需要时关闭以省 token/上下文 |
| `zharness --help` / `-h` | 完整帮助（含扩展注册的 flag） | 查全部选项 |
| `zharness --version` / `-v` | 版本号 | 排查版本 |

> 注意：`zharness builtin read/write/edit` 是**模型通过 cli 工具调用的内置命令**（见 [src/core/tools/builtin-commands.ts](./src/core/tools/builtin-commands.ts)），普通用户一般不直接敲；`zharness builtin list/enable/disable` 才是面向你的内置扩展管理。

### 3. 常用选项（按场景归类）

| 选项 | 场景 |
|---|---|
| `--provider <name>`（默认 google） | 切换厂商，如 `openai`、`anthropic` |
| `--model <pattern>` | 指定模型，支持 `provider/id` 与 `:thinking` 简写，如 `sonnet:high` |
| `--models <patterns>` | 限定 Ctrl+P 循环范围，支持 glob，如 `"github-copilot/*"` |
| `--thinking <level>` | off/minimal/low/medium/high/xhigh/max |
| `--api-key <key>` | 临时覆盖 key（默认读环境变量） |
| `--system-prompt` / `--append-system-prompt` | 自定义/追加系统提示 |
| `--continue` | 继续上次会话（无 `--no-session` 时默认即继续） |
| `--rewind [id]` | 恢复永恒会话；带 id 跳到某分支 |
| `--no-session` | 临时会话不落盘 |
| `--session-dir <dir>` | 指定会话存储目录 |
| `--export <id> [out.html]` | 导出会话为 HTML 报告 |
| `--list-models [search]` | 列出/模糊搜索可用模型 |
| `--tools <a,b,c>` / `--no-tools` | 工具白名单；`--no-tools` 全关 |
| `--tools read,grep,find,ls` | 只读审查模式（无法改文件） |
| `-e <path>` / `--no-extensions` / `--no-builtin-extensions` | 临时加载/关闭扩展 |
| `--skill <path>` / `--no-skills` | 加载/关闭 skills |
| `--prompt-template` / `--theme` / `--no-context-files` | 资源开关 |
| `--main` | 启动持久化"main" agent（带 soul + 长期记忆） |
| `--main-dir` / `--memory-dir` | 覆盖 main agent 工作目录与记忆目录 |
| `--offline` / `--verbose` | 禁用启动期联网；强制详细启动日志 |

环境变量见 `zharness --help` 末尾（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`ZHARNESS_OFFLINE` 等）。

---

## 二、TUI 会话内斜杠命令

在交互式 TUI 中输入 `/` 触发。内置命令定义见 [src/core/slash-commands.ts](./src/core/slash-commands.ts)。

| 命令 | 作用 |
|---|---|
| `/settings` | 打开设置菜单 |
| `/model` | 选择模型（弹出选择器） |
| `/export` | 导出会话为 HTML |
| `/share` | 把会话作为私密 GitHub gist 分享 |
| `/copy` | 复制最近一条 agent 消息到剪贴板 |
| `/stats` | 显示会话统计 |
| `/hotkeys` | 显示全部快捷键 |
| `/rewind` | 从某条历史用户消息分叉新会话 |
| `/history` | 在会话树中切换分支 |
| `/login` / `/logout` | OAuth 登录/登出 |
| `/compact` | 手动压缩会话上下文 |
| `/reload` | 重新加载快捷键、扩展、skills、prompts、themes |
| `/debug` | 显示调试信息 |
| `/quit` | 退出 ZHarness |

### 内置扩展提供的会话内命令

| 命令 | 来源 | 子命令/作用 |
|---|---|---|
| `/browser` | agent-browser 扩展 | `install` / `uninstall` / `status` / `disable` / `enable` / `help`——管理浏览器自动化 CLI（Chrome/Chromium via CDP） |
| `/codegen` | codegen-sma 扩展 | MEA 编排流水线（fresh-context 分阶段 episodes + 确定性闸门 + 合规检查点） |

> 用户扩展、prompt、skill 也可注册斜杠命令（source 为 extension/prompt/skill），列表随 `/` 自动补全。

---

## 三、桌面 GUI（Tauri 应用）

启动方式：`zharness gui`，或直接运行桌面端二进制（构建见 [package.json](./package.json) 的 `build:desktop` / `dev:desktop`）。后端桥接命令定义在 [apps/desktop/src/bridge.rs](./apps/desktop/src/bridge.rs) 与 [apps/desktop/src/main.rs](./apps/desktop/src/main.rs)。

### 路由视图（[apps/web/src/App.tsx](./apps/web/src/App.tsx)）

| 视图 | 路由 | 用途 |
|---|---|---|
| 聊天 | `/` | 主对话区，含工具调用审批 |
| 设置 | `/settings` | 厂商/API key/自定义 provider 配置 |
| 插件 | `/plugins` | 扩展管理 |

侧边栏与面板：工作区列表（[WorkspacePane](./apps/web/src/components/WorkspacePane.tsx)）、文件浏览器（[FileExplorer](./apps/web/src/views/FileExplorer.tsx)）、分支树（[BranchTreeExplorer](./apps/web/src/views/BranchTreeExplorer.tsx)）、事件时间线（[EventTimeline](./apps/web/src/views/EventTimeline.tsx)）。

### 桌面端原生能力（Tauri invoke 命令）

| 能力 | 说明 |
|---|---|
| `init_sidecar` / `stop_sidecar` / `restart_sidecar` | 启停与每个窗口绑定的 Node sidecar（即底层 Agent 进程） |
| `new_workspace` / `list_workspaces` / `delete_workspace` / `reveal_workspace` | 多工作区增删改查与在文件管理器中打开 |
| `list_providers` / `set_provider_api_key` / `remove_provider_api_key` | 厂商与密钥管理（密钥存 `~/.zharness/agent/auth.json`） |
| `add_custom_provider` / `remove_custom_provider` | 自定义 provider |
| `fetch_openai_models` | 拉取兼容 OpenAI 的模型列表 |
| `transcribe_audio` | 音频转写 |
| `list_dir` / `read_file` / `open_in_editor` / `reveal_path` | 文件浏览/打开/定位 |
| `set_window_background` | 设置窗口背景 |
| `fetch_skills_sh` | 拉取 skills 脚本 |

> GUI 通过 RPC 模式（`--mode rpc`）与 sidecar 通信，事件流与 CLI/TUI 同源，会话可在三种形态间互通。

---

## 四、模型可用的内置工具

ZHarness 只给模型一个 `cli` 工具，模型经它调用下列命令（grep/find/ls 默认关闭，需 `--tools` 显式开启）。定义见 `zharness --help` 的 "Built-in Tool Names" 与 [src/core/tools/](./src/core/tools)。

| 工具 | 能力 | 备注 |
|---|---|---|
| `read` | 读文件内容（带 2-hex 行锚点） | 内置命令，非系统 shell |
| `write` | 写文件（创建/覆盖） | 内置命令 |
| `edit` | 基于锚点整行编辑 | 内置命令 |
| `cli` | 执行 CLI 命令 | grep/find/ls/git/npm 等透传系统 shell |
| `grep` | 搜内容 | 只读，默认关 |
| `find` | 按 glob 找文件 | 只读，默认关 |
| `ls` | 列目录 | 只读，默认关 |

> 当 PATH 中缺 grep/find/ls 时，ZHarness 会为缺失项注入临时 shim（仅缺哪个补哪个）。

---

## 五、选型速查

| 需求 | 推荐 |
|---|---|
| 日常交互编码、要分支/回放/上下文压缩 | TUI（`zharness`） |
| 偏图形界面、多工作区、看事件时间线 | GUI（`zharness gui`） |
| 脚本/CI/一次性问答 | `zharness -p "..."` |
| 只读代码审查、禁止改文件 | `zharness --tools read,grep,find,ls -p "..."` |
| 持久 agent + 长期记忆 | `zharness --main` |
| 导出会话报告 | `zharness --export <id> out.html` 或 TUI `/export` |
| 管理第三方扩展 | `zharness plugin install/list/update/remove` |
| 管理内置扩展 | `zharness builtin list/enable/disable` 或 TUI `/browser` |
| 切模型/思考档 | `--model`、`--thinking` 或 TUI `/model`、Ctrl+P |
