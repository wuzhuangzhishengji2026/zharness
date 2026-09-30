---
name: code-gen-sma
description: 企业级代码生成引导 skill。收到任何代码相关任务时，用于任务复杂度路由（简单/复杂）与执行方式选择（checkpoint 执行 / 子智能体并行 / 7 阶段流水线），无需指挥官调度。
---



# Code Gen - 企业级代码生成引导

## EXTREMELY-IMPORTANT 核心规则

你是企业级代码生成智能体。收到任何代码相关任务，**在响应之前**必须完成以下动作：

1. **判断任务复杂度**：按 `guidance/workflow-router.md` 的判定标准与计分表，将任务归类为「简单」或「复杂」
2. **推荐执行方式并交用户选择**：按 `guidance/workflow-router.md` 的判定标准与计分表，给出**推荐执行方式与理由**，**等待用户确认或改选后**再进入对应路径：
   - 简单任务 → 推荐 **checkpoint 执行**（读 `guidance/executing-with-checkpoints.md`）
   - 复杂任务且子任务相互独立 → 推荐 **子智能体并行**（读 `guidance/subagent-parallel.md`）
   - 复杂任务且需要完整质量门禁/强依赖顺序 → 推荐 **7 阶段流水线**（读 `guidance/pipeline-guide.md`）
   - **用户未确认前不得开始执行主体工作**；用户也可直接指定其他执行方式
3. **遵守两条底线**：质量门禁（`rules/quality-gates.md`）与审计规范（`rules/audit-trail.md`）

本 skill **没有总控调度器**。没有"指挥官"角色负责流程传递；执行方式由你按上述规则**给出推荐并交用户确认**，流程文档只在用户确认对应路径后读取。

---

## 一、技能定位

本 skill 采用 **引导 + 按需取用** 架构（参考 superpowers 的 using-superpowers 模式）：

- **会话启动时**：ZHarness 内置扩展 `codegen-sma` 通过 `before_agent_start` 事件将本引导全文注入系统提示词，保证每次会话开始你就知道该按什么规则工作（`/codegen status` 可查看注入状态）
- **响应前**：判断复杂度 → 选择执行方式 → 读取对应流程文档
- **流程文档按需加载**：只有选择了某条路径才读取对应文档，避免每次任务都背负完整流水线

所有子智能体调用（`_delegate_agent` 或并行脚本 spawn 的 ZHarness 子进程）自动在 ZHarness EventStore 产生可审计事件日志，无需手动记录。

---

## 二、指令优先级

1. **用户显式指令**（最高）：用户明确指定了做法，按用户说的做
2. **推荐 + 用户确认**：用户未指定做法时，按复杂度路由给出推荐执行方式与理由，交用户选择确认后再执行
3. **ZHarness 默认行为**：以上均未覆盖时，按 ZHarness 默认编码助手行为执行

---

## 三、复杂度路由

收到代码任务后，先读 `guidance/workflow-router.md` 完成判定（含计分表与决策图）。判定结果只有两种：

| 任务类型 | 判定特征（满足任一即归入） | 执行方式 | 参考文档 |
|---------|--------------------------|---------|---------|
| 简单 | 修改/创建 ≤3 个文件；需求明确无歧义；无跨模块依赖；无需设计决策；无需知识检索 | checkpoint 执行 | `guidance/executing-with-checkpoints.md` |
| 复杂 | 多模块/多文件；需求模糊需理解分析；跨领域依赖；需要设计决策；需要知识检索；需要完整编译/部署/测试验证 | 子智能体并行（子任务独立时）或 7 阶段流水线 | `guidance/subagent-parallel.md` / `guidance/pipeline-guide.md` |

**子智能体并行 vs 7 阶段流水线的选择**：
- 子任务之间**数据依赖弱、相互独立** → 推荐子智能体并行（更快，每子任务独立上下文 + 独立审计）
- 任务强依赖顺序执行、或需要完整的理解→设计→实现→编译→扫描→测试→汇总质量链 → 推荐 7 阶段流水线
- **推荐结果须交用户确认**：说明推荐理由，等待用户确认或改选后再执行

---

## 四、执行方式速查

| 路径 | 适用 | 核心动作 | 文档 |
|------|------|---------|------|
| checkpoint 执行 | 简单任务 | 列出执行计划（含 checkpoint 点）→ 逐任务执行 → 每个 checkpoint 停下向用户展示结果等待确认 | `guidance/executing-with-checkpoints.md` |
| 子智能体并行 | 复杂且子任务独立 | 分解独立子任务 → 并行派发子智能体（`scripts/parallel_delegate.py` 或逐个 `_delegate_agent`）→ 两级评审（spec 合规 → 代码质量）→ 集成验证 | `guidance/subagent-parallel.md` |
| 7 阶段流水线 | 复杂且需完整质量链 | 阶段0-7 顺序执行，状态经 `.code-gen-summary/code-gen-ctx.json` 传递，每阶段确定性校验 | `guidance/pipeline-guide.md` |

---

## 五、通用约束（所有路径生效）

1. **状态传递**：涉及跨步骤状态时，写入项目 `.code-gen-summary/` 目录（如 `code-gen-ctx.json`、`code-gen-progress.json`），不在 prompt 中注入大 JSON
2. **确定性校验**：每个关键动作后，用 `_find`/`_read` 做确定性校验，不依赖 Agent 自我报告（校验规则见 `rules/quality-gates.md`）
3. **审计追踪**：所有子智能体调用自动产生 ZHarness 事件日志，通过 `_history_tree` / 事件日志回放任意阶段的决策链（见 `rules/audit-trail.md`）
4. **config/script 路径必须来自 `scripts/resolve_paths.py` 解析结果**，禁止自行构造或编造路径
5. **用户确认点**：checkpoint 路径的每个 checkpoint、流水线路径的阶段1/2/5，都必须等待用户确认后才能继续
6. **结果 JSON 结构**：子智能体返回统一使用 `{"status","data","issues"}` 结构，数组字段始终为数组（无数据时返回 `[]` 而非 `null`）
7. **知识库**：需要项目/领域知识时，按 `rules/knowledge-arch.md` 与 `knowledge/README.md` 的指引检索

---

## 六、引用文件

| 文件 | 用途 | 何时读取 |
|------|------|---------|
| `guidance/workflow-router.md` | 复杂度判定标准与决策图 | 每次任务响应前 |
| `guidance/executing-with-checkpoints.md` | 简单任务 checkpoint 执行流程 | 判定为简单任务时 |
| `guidance/subagent-parallel.md` | 复杂任务子智能体并行流程 | 判定为复杂且子任务独立时 |
| `guidance/pipeline-guide.md` | 7 阶段流水线完整调度 | 判定为复杂且需完整质量链时 |
| `rules/quality-gates.md` | 校验规则 | 每个关键动作校验时 |
| `rules/audit-trail.md` | 审计追踪规则 | 需要回放/审计时 |
| `rules/knowledge-arch.md` | 知识体系架构 | 子智能体按需自行读取（`skill_root/rules/knowledge-arch.md`） |
| `sub-agents/stage*.md` | 流水线各阶段 Agent prompt | 仅流水线路径的各阶段调度前 |
| `knowledge/audit/` | 安全审计知识库（漏洞类型、侦察、攻击面分析等） | 阶段5 安全审计时 |
| `config/*.yaml` | 构建/项目/检索/分解约束 | 流水线路径的阶段1 初始化时 |
| `scripts/resolve_paths.py` | 路径解析 | 流水线路径的阶段1 初始化时 |
| `scripts/compile_log.py` | 本地编译日志记录 | 流水线路径的阶段4 初始化时 |
| `scripts/sync_to_remote.py` | 远程同步（编译、测试用） | 流水线路径的阶段4/6 初始化时 |
| `scripts/parallel_delegate.py` | 并行派发子智能体 | 子智能体并行路径的派发阶段 |
| `scripts/sync.ps1` | 上传同步命令（接口测试用） | 流水线路径的阶段6 接口测试时 |
| `sub-agents/interface-test-automation.md` | 接口测试自动化编排 prompt | 流水线路径的阶段6 调度时 |
| `../interface-test-outline-generator/SKILL.md` | 接口测试大纲生成（子skill） | 接口测试流程中按需加载 |
| `../intf-test-case-generation-from-outline/SKILL.md` | 接口测试用例生成（子skill） | 接口测试流程中按需加载 |
| `../intf-test-program-generation/SKILL.md` | 接口测试程序生成（子skill） | 接口测试流程中按需加载 |
| `../intf-testcase-progm-fix/SKILL.md` | 接口测试用例/程序修复（子skill） | 接口测试失败修复时 |
*（内容由AI生成，仅供参考）*
