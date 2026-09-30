# ZHarness

[中文](#中文) | [English](README.md)

---

## 中文

ZHarness 是一个**事件驱动**的编码 Agent：每一次对话、每一次工具调用、每一次文件修改，都被记录为不可变日志中的一条事件。LLM 上下文、会话树、时间线与各个 UI，都是这条日志的实时投影——如同数据库视图之于底层表，不持有独立状态，可随时重建、审计与回放。

## 核心设计

- **Reactor 驱动的 turn 循环** — 每个 turn 是一张「事件—处理器」表驱动的状态机：事件到来，查表，分发至对应处理器，状态流转。区别于常见的 `while True` 主循环，每一步的输入输出都能被可靠处理与追踪。
- **日志是唯一事实来源** — 每条消息、模型调用、工具结果和文件变更都写入不可变 EventStore（每工作区一个 SQLite 库），状态可重建、可审计、可回放。
- **CLI 工具注册中心** — 只向模型暴露一个 `cli` 工具，读写编辑等命令经它路由执行，符合渐进式披露的思想。
- **同一运行时，多种形态** — CLI、交互式 TUI、桌面 GUI 共享同一个事件流，底层始终是同一个 Agent。
- **Git Log 式的分支树记忆** — 会话可以从任意一条历史消息分叉，支持只读查看与时间线回退。

## 功能一览

- 终端级 CLI（`zharness --help`）+ 交互式 TUI
- 桌面端（Tauri 2）：工作区管理、文件浏览、事件时间线、回放视图、SOP 市场、技能/扩展/模型配置
- 会话分支树与回放摘要（replay-summary 内置扩展）
- SOP 市场与动态工作流引擎（builtin-sops：code-review、deep-research、dynamic-task、weekly-report）
- 内置技能（builtin-skills：api-map、自优化）与内置扩展（codegen 流水线、主动助手、持久化主 Agent）
- RPC 集成面（`--mode rpc`，stdin/stdout JSONL），供第三方嵌入
- 计划任务（调度器）与跨工作区会话派发

## 安装与快速开始

> 依赖：Node.js ≥ 22.5。桌面端构建另需 Rust（Tauri 2）与 Bun。

```bash
# 从源码安装 CLI
git clone https://github.com/wuzhuangzhishengji2026/zharness.git
cd zharness
npm install
npm run build
npm link            # 或 node dist/src/cli.js

# 启动交互式 TUI
zharness

# 启动桌面端（开发模式）
npm run dev:desktop

# 运行测试（离线）
npm test
```

首次使用在 TUI/桌面端「设置 → 服务商」中配置模型 API 即可；配置存储于 `~/.zharness/`。

## 文档

| 文档 | 内容 |
|---|---|
| [用户说明书](USER-GUIDE.zh-CN.md) | CLI / 斜杠命令 / 桌面端 / 模型工具 全景速查 |
| [万字深度解析](docs/DEEP_DIVE.zh-CN.md) | 从零讲解架构、事件溯源、工具系统与记忆机制 |
| [架构 Wiki](wiki/) | 架构总览、Reactor 循环、会话树与时间线、RPC 与桌面端、SOP 市场、知识库规范 |
| [设计理念随笔](docs/DESIGN-RATIONALE.zh-CN.md) | 为什么做事件驱动 Harness：与 Pi / DSH 的对比与取舍 |
| [持久化 Agent 设计](docs/PERSISTENT-AGENT.zh-CN.md) | `~/.zharness/main` 常驻人格 Agent 的设计文档 |

## 贡献

欢迎 Issue 与 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交信息请遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

## 许可证

[MIT](LICENSE)

## 致谢

ZHarness 的前身是事件驱动 Agent 的开源探索：上游 [Pizza / Rango](https://github.com/tomsun28/pizza) 与 Mario Zechner 的 [Pizza](https://github.com/badlogic/pizza)；交互外壳与模型接入层基于 Pi 生态的 `@earendil-works/pi-tui`、`@earendil-works/pi-ai` 等包。感谢这些项目的作者与社区。
