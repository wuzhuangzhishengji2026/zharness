# 7 阶段流水线（复杂任务·完整质量链）

> 本文件由原 code-gen-sma「总控调度」章节迁移而来。现在它**不是指挥官**，而是复杂任务且需要完整质量链时
> （判定见 `workflow-router.md`）选用的**一条执行路径**。选择本路径后，按本文档顺序执行阶段 0-7。

## 一、架构概览

```
当前上下文（执行者）                    各阶段 Agent（独立上下文）

  ① 更新 .code-gen-summary/code-gen-ctx.json（_write）
  ② _read("sub-agents/stageN-xxx.md")     →   prompt_base
  ③ 注入输出标准提醒                       →   最终 prompt
  ④ _delegate_agent cwd="<项目目录>"       →   Agent N 运行（自动产生事件日志）
     task="<prompt>"
  ⑤ 解析返回值中的 JSON result             ←   返回 {"status","data","issues"}
  ⑥ 确定性校验（rules/quality-gates.md）
  ⑦ 更新状态 → 下一阶段
```

状态传递：执行者将当前 context 写入 `.code-gen-summary/code-gen-ctx.json`，Agent 用 `_read` 读取；
Agent 在回复末尾输出 JSON 结果，执行者提取解析；写文件类 Agent 直接用 `_write` 写入项目路径。

## 二、流程总览

| 阶段 | Agent prompt | 状态文件中的 stage | 输出到 prerequisites | 校验门禁 |
|------|-------------|-------------------|---------------------|---------|
| 0 会话初始化 | -（无 Agent） | `stage0` | - | G0 |
| 1 需求分析 | `sub-agents/stage1-requirement.md` | `stage1` | `parsed_intent` + `requirement_doc_path` + `requirement_type` | G0.5+G1 |
| 2 方案设计 | `sub-agents/stage2-design.md` | `stage2` | `design_doc_path` + `subtask_list` + `dependency_graph` | G2 |
| 3 编码实现 | `sub-agents/stage3-implement.md` | `stage3` | `file_list` | G4-G4.5 |
| 4 编译验证 | `sub-agents/stage4-compile.md` | `stage4` | `compile_result` | G6 |
| 5 安全审计 | `sub-agents/stage5-audit.md` | `stage5` | `audit_result` | G5 |
| 6 接口测试 | `sub-agents/stage6-test.md` | `stage6` | `test_result` | G7 |
| 7 文件汇总 | `sub-agents/stage7-summary.md` | `stage7` | `summary_path` | G8 |

## 三、调度流程

### 通用步骤（每个阶段）

```
① 更新状态文件：
   _write ".code-gen-summary/code-gen-ctx.json" '{
     "stage": "stageN",
     "context": { ...当前context }
   }'

② 读取 Agent prompt：
   prompt_base = _read "sub-agents/stageN-xxx.md"

③ 注入输出标准提醒：
   提醒段 = 各阶段统一内容（见下方模板）
   prompt = 提醒段 + "\n\n---\n\n" + prompt_base

   [提醒段：各阶段统一内容]
   """
   ## 本阶段输出校验标准
   你的输出将按 rules/quality-gates.md 中的门禁规则校验。
   请严格遵循本 prompt 中「输出格式」章节定义的 JSON 结构输出，
   确保必填字段非空、数组字段始终为数组（无数据时返回 [] 而非 null）。
   """

④ 派发 Agent：
   _delegate_agent cwd="<当前项目目录>" task="<prompt内容>"
   （ZHarness 会 spawn 独立进程的子 agent，独立 EventStore；完成后自动记录 TOOL_EXECUTION_END 事件）

⑤ 从返回值中提取 JSON result 块：
   - 搜索第一个 ```json 代码块，提取 JSON 字符串
   - 找不到代码块则搜索整个返回值中符合 {"status":...} 模式的 JSON
   - 仍找不到则提示用户手动检查 Agent 输出

⑥ 确定性校验（参考 rules/quality-gates.md）

⑦ 执行字段映射（result.data → context 对应位置），
   更新进度文件 .code-gen-summary/code-gen-progress.json，进入下一阶段
```

### 进度追踪

```
_write ".code-gen-summary/code-gen-progress.json" '{
  "current_stage": "stage3",
  "completed": ["stage1", "stage2"],
  "pending": ["stage4", "stage5", "stage6", "stage7"],
  "updated_at": "<时间戳>"
}'
```

### 阶段 0：会话初始化

1. 用 cli 命令检查 `.code-gen-summary/code-gen-ctx.json` 是否存在
   - Windows: `Test-Path ".code-gen-summary/code-gen-ctx.json"`
   - Linux/Mac: `test -f .code-gen-summary/code-gen-ctx.json`
2. 不存在 → 进入阶段 1
3. 存在 → `_read` 读取 stage 字段，询问用户："检测到上次未完成的会话（阶段 {stage}），是否继续？"
   - 确认继续 → 跳到对应阶段；重新开始 → 删除状态文件，进入阶段 1
4. 校验门禁 G0：stage 在 1-7 范围内或为 restart 确认

### 阶段 1：需求分析

1. 获取项目根目录（`(Get-Location).Path` / `pwd`），确定技能根目录
   - Windows: `$skillRoot = "$env:USERPROFILE\.zharness\agent\skills\code-gen-sma"`
   - Linux/Mac: `skillRoot="$HOME/.zharness/agent/skills/code-gen-sma"`
   （注意：若使用 --skill 显式加载，以实际加载路径为准）
2. 生成会话元数据（request_id / timestamp），调用 resolve_paths.py 解析所有路径：
   - Windows: `python "$skillRoot\scripts\resolve_paths.py" "$projectRoot" "$skillRoot" -o ".code-gen-summary/paths.json"`
   - Linux/Mac: `python3 "$skillRoot/scripts/resolve_paths.py" "$projectRoot" "$skillRoot" -o ".code-gen-summary/paths.json"`
   **必须 `_read` 解析结果，禁止自行构造路径**；含 error 字段 → 报告缺失路径并中止进入 stage1
3. 创建 `.code-gen-summary/` 目录，初始化 context 并写入（含 requirement/config/script/prerequisites/meta）
4. 校验门禁 G0.5：config/script 指向的文件均存在；任一缺失 → 报告并中止
5. 删除 paths.json，初始化进度文件
6. 按通用步骤调度 `stage1-requirement` Agent；校验门禁 G1（`parsed_intent.objective` 非空）
7. 字段映射：`parsed_intent` → `context.requirement.parsed_intent`，`requirement_doc_path` → `context.requirement.requirement_doc_path`，`requirement_type` → `context.requirement.requirement_type`
8. **等待用户确认后**进入阶段2；更新进度文件

### 阶段 2：方案设计

1. context 增加 `prerequisites.design_doc_path`（空占位）、`prerequisites.subtask_list`（空数组占位）、`prerequisites.dependency_graph`（空占位）
2. 按通用步骤调度 `stage2-design` Agent
3. 校验门禁 G2：design_doc_path 非空且 subtask_list 格式正确
4. 字段映射：`design_doc_path` → `context.prerequisites.design_doc_path`，`subtask_list` → `context.prerequisites.subtask_list`，`dependency_graph` → `context.prerequisites.dependency_graph`
5. **等待用户确认后**进入阶段3；更新进度文件

### 阶段 3：编码实现

1. context 增加 `prerequisites.file_list`（空数组占位）
2. 按通用步骤调度 `stage3-implement` Agent
3. **校验门禁 G4-G4.5**：`_find` 检查 file_list 中所有文件存在，`_read` 抽样非空
4. 字段映射：`file_list` → `context.prerequisites.file_list`
5. 校验失败则重新派发 Agent（遵循 quality-gates.md 重试规则）
6. 更新进度文件 → 阶段4

### 阶段 4：编译验证

1. 按通用步骤调度 `stage4-compile` Agent
2. 校验门禁 G6：检查 `compile_result.success` 布尔值
3. 字段映射：`compile_result` → `context.prerequisites.compile_result`
4. `success = false`（已达最大重试次数）→ **直接进入阶段7**
5. 更新进度文件：成功则进入阶段5

### 阶段 5：安全审计

1. context 增加 `prerequisites.audit_result`（空对象占位）
2. 按通用步骤调度 `stage5-audit` Agent
3. **校验门禁 G5**：检查 `data.audit_result.coverage_report.checked_count / total_vuln_types >= 80%`（审计覆盖率达标）、`audit_result.has_confirmed_findings` 及 confirmed 的漏洞数量
4. 字段映射：`audit_result` → `context.prerequisites.audit_result`
5. 门禁失败处理：
   - 覆盖率不足（checked_count / total_vuln_types < 80%）→ 重新派发阶段5 Agent，prompt 中注入「上一轮只覆盖了 X/Y 种漏洞类型，请覆盖全部类型」
   - 存在任何漏洞 → 向用户展示漏洞列表，等待用户决策：
     - 用户选择"忽略继续" → 标记为已知风险，进入阶段6
     - 用户选择"修复后重审" → 重新派发阶段3 Agent 修复所有漏洞；修复完成后，**必须重新调度阶段4编译**；编译成功后，再重新调度阶段5审计
6. 更新进度文件 → 阶段6

### 阶段 6：接口测试

1. 按通用步骤调度 `stage6-test` Agent
2. 校验门禁 G7：检查 `test_result.success` 布尔值
3. 字段映射：`test_result` → `context.prerequisites.test_result`
4. 无论成功或失败 → **进入阶段7**
5. 更新进度文件

### 阶段 7：修改文件汇总

> **阶段 7 在以下情况均会执行**：阶段4编译失败、阶段6测试失败、全流程成功完成。

1. 按通用步骤调度 `stage7-summary` Agent
2. 字段映射：`summary_path` → `context.prerequisites.summary_path`
3. **校验门禁 G8**：从 `result.data.summary_path` 提取绝对路径，`_find` 精确检查文件存在；不存在则重新派发 stage7（最多 3 次）
4. 告知用户文档位置
5. **审计归档**：告知用户可通过 ZHarness 事件日志回放本次完整流程（`_history_tree` / 事件日志 / caused_by 因果链）
6. 清理状态文件（删除 code-gen-ctx.json），更新进度文件：流程结束

## 四、路径约束

1. **必须按顺序执行 7 个阶段**，不得跳过或调换
2. **每个阶段必须派发独立 Agent**（`_delegate_agent`），执行者不得自行执行具体实现操作
3. **状态通过 `.code-gen-summary/code-gen-ctx.json` 传递**，不在 prompt 中注入大 JSON
4. **每个阶段返回后执行确定性校验**（`_find`/`_read`），不依赖 Agent 自我报告
5. **阶段1、阶段2和阶段5必须用户确认后**才能进入下一阶段
6. **阶段7在所有终止点之前执行**：编译失败、测试失败、全流程完成
7. **流程正向不可逆**：阶段4编译失败由 Agent 内部重试修复，无效则终止；阶段5审计失败由用户决策
8. **各阶段结果逐级累积**：parsed_intent → requirement_doc → design_doc + subtask_list → file_list → compile_result → audit_result → test_result
9. **config/script 路径必须来自 paths.json 读取结果**，禁止自行构造或编造路径
10. **不得直接读取或修改子智能体定义文件**（`sub-agents/*.md`）
11. **每次 `_delegate_agent` 调用自动产生 ZHarness 事件日志**，无需手动记录审计信息

## 五、ZHarness 审计能力

本路径运行在 ZHarness 事件溯源架构之上，每次 `_delegate_agent` 调用自动在 EventStore 记录：

| 事件类型 | 记录内容 | 审计价值 |
|---------|---------|---------|
| `INTENT_TOOL_CALL` | 决定委派子 agent，含 cwd 和 task 摘要 | 证明"谁在什么时候决定做什么" |
| `TOOL_EXECUTION_START` | 子 agent 启动，含完整 prompt | 证明"子 agent 收到了什么指令" |
| `TOOL_EXECUTION_END` | 子 agent 完成，含返回结果 | 证明"子 agent 做了什么" |
| `caused_by` 链 | 每个事件指向父事件 | 可从结果倒查到用户原始输入 |

回放方式：`_history_tree` 查看会话分支树；从 SQLite EventStore 导出事件日志；从任意阶段返回结果通过 `caused_by` 回溯到用户原始输入。每个子 agent 有独立 EventStore，可单独审计。
*（内容由AI生成，仅供参考）*
