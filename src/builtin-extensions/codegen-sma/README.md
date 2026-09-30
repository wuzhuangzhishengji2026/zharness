# codegen-sma（内置扩展）

企业级代码生成流程技能包，随 ZHarness 平台分发，同一技能族另备 OpenCode 平台部署形态。

## 组成

```
codegen-sma/
├── index.ts                  # 扩展本体：引导注入 + /codegen 命令
└── skills/                   # 技能文件（构建时随包分发）
    ├── code-gen-sma/         # 主技能：复杂度路由 → checkpoint / 子智能体并行 / 7 阶段流水线
    │   ├── SKILL.md          # 引导正文（每次 turn 注入系统提示词）
    │   ├── guidance/         # workflow-router / checkpoints / subagent-parallel / pipeline-guide
    │   ├── rules/            # quality-gates(G0~G8) / audit-trail(EventStore 审计) / knowledge-arch
    │   ├── knowledge/        # C++/Java 安全审计知识库
    │   ├── config/           # build-env / project-env / retrieval / decomposer 约束（YAML）
    │   ├── scripts/          # parallel_delegate / compile_log / resolve_paths / sync_to_remote / sync.ps1
    │   └── sub-agents/       # stage1~7 阶段 prompt + interface-test-automation 编排工作流
    ├── interface-test-outline-generator/
    ├── intf-test-case-generation-from-outline/
    ├── intf-test-program-generation/
    └── intf-testcase-progm-fix/
```

## 工作方式

1. **常驻注入**：扩展订阅 `before_agent_start` 事件，把 `code-gen-sma/SKILL.md` 正文（去 frontmatter）追加到系统提示词。收到任何代码任务时，模型按引导先做复杂度路由、给出执行方式推荐并等用户确认。
2. **技能发现**：`/codegen install` 把技能族拷贝到 `<agentDir>/skills/`，平台原生技能加载器（`src/core/skills.ts`）即可发现并列入 `<available_skills>` 清单。
3. **子智能体**：流水线各阶段经 `_delegate_agent` 派发独立进程执行；并行路径用 `scripts/parallel_delegate.py`（支持 `--platform zharness|opencode` 双平台）。

## 技能目录解析优先级

1. 环境变量 `ZHARNESS_CODEGEN_SKILL_DIR`
2. `<agentDir>/skills/code-gen-sma`（`/codegen install` 后的标准位置）
3. `<项目>/.zharness/skills/code-gen-sma`
4. 随包分发的内置副本（仓库/npm 为本模块同级 `skills/`；Bun 二进制为可执行文件旁 `codegen-sma/skills/`）

## 命令

| 命令 | 说明 |
|------|------|
| `/codegen status` | 查看注入状态与技能目录解析结果 |
| `/codegen install` | 把内置技能族安装到 `<agentDir>/skills/` 并重载 |
| `/codegen help` | 帮助 |

停用整个扩展：settings.json 的 `disabledBuiltinExtensions` 加 `"codegen-sma"`，或 `zharness builtin disable codegen-sma`。

## 使用注意

- **远程编译凭据**：`config/build-env.yaml` 入库为脱敏模板（占位符）。真实主机/口令配置在项目级覆盖文件 `<项目根>/KnowledgeBase/config/build-env.yaml`（勿提交仓库）。
- **接口测试**：stage6 加载 `sub-agents/interface-test-automation.md` 编排工作流内联执行（大纲→用例→程序→sync 上传编译→失败修复重试 ≤5 次）；sync 脚本位于技能 `scripts/sync.ps1`。
- **审计**：所有 `_delegate_agent` 调用自动进入 EventStore（`<agentDir>/workspaces/<workspace_id>/events.sqlite`），回放方式见 `rules/audit-trail.md`。
