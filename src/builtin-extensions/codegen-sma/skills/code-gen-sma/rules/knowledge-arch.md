## 知识体系架构

知识按以下优先级从高到低逐层检索（每层不完整时换关键词重试，最多2次）：

| 优先级 | 来源 | 查询方式 |
|--------|------|---------|
| 1 | Dify 知识库 | 调用 dify-knowledge 工具查询（每个关键词调用一次） |
| 2 | 项目 KnowledgeBase/ | Read / Glob |
| 3 | 项目 graphify-out/ | Read / Glob |
| 4 | Skill 本地 knowledge/ + examples/ | Read |
| 5 | 用户输入 | 直接提供 |

> 优先级 1（Dify）由本 Agent 自行调用 dify-knowledge 工具查询。
> 优先级 2-5 由本 Agent 自行检索。
> 全部查不到再 AskUserQuestion。
