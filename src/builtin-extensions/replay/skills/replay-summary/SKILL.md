---
name: "replay-summary"
description: "为 ZHarness 会话生成研发任务回放摘要 replay-summary.json（schema 2.0，含 phases/timeline 与可选 artifacts/ 产物目录），供 GUI「回放」页动态播放。Invoke when the user asks to generate / refresh a conversation replay summary, 生成或刷新回放摘要, 从会话生成 replay-summary.json, 根据对话/轨迹生成回放摘要, or after a finished task conversation the user wants to replay."
---

# ZHarness 研发任务回放摘要生成（replay-summary · v2）

把一次研发任务会话提炼成 schema 2.0 的 `replay-summary.json`
（+ `artifacts/` 产物副本），供 ZHarness GUI「回放」页把
「业务阶段（含真实累计耗时）→ 真实执行轮次（Timeline，含返工
rollback/reentry）→ 每轮步骤/产出/数据结果」还原为可播放的动态过程。
摘要只做展示；本技能**只读会话事件库**，不改写任何会话数据，也不重执行任务。

> v2 变更说明：老版本（schema 1.x，只有 task/phases[].steps/artifacts）已废弃。
> 新模型为两层：`phases[]`（业务阶段 + actualDuration）与 `timeline[]`
> （真实执行顺序，每轮自带 steps/artifacts/metrics，支持返工回退与重入）。

## 1. 目标输出（位置与结构）

回放目录（GUI「回放」页读取处）：
`<agentDir>/workspaces/<workspace_id>/replay/<sessionId>/`

- `<agentDir>`：默认 `~/.zharness/agent`（若设了 `ZHARNESS_CODING_AGENT_DIR` 环境变量则用它）；
- `<workspace_id>`：`ws_<sha256(工作区绝对路径) 前 12 位>`（脚本会自动算好，不用手算）；
- `<sessionId>`：会话 id（脚本默认选最新会话并打印出来）。

```
replay/<sessionId>/
├─ replay-summary.json       ← 本技能产出（schemaVersion "2.0"，唯一权威源）
└─ artifacts/                ← 每轮产物的文件副本（可选但强烈建议）
```

数据结构（核心关系，数组顺序即回放顺序）：

```text
Task
 ├─ Phase[]                    id/name/actualDuration(ms，业务阶段累计真实耗时)
 └─ Timeline[]                 id/phaseId/type/transitionMessage
      ├─ Step[]                id/name/description/tags[]/inputs[]/calls[]/outputs[]/
      │                        status(success|failed|confirmed)/artifactIds[]/replayDuration
      ├─ Artifact[]            id/name/type/path/description（≤3 个，本轮的阶段产出）
      └─ Metric[]              name/value（≤4 个，本轮数据结果）
```

- `schemaVersion`: 固定 `"2.0"`；`conversationId` 填 sessionId（即回放目录名）。
- 完整字段契约见同目录 `references/replay-summary.schema.json`，
  成品示例（含一次 测试→开发→测试 返工）见 `references/example-replay-summary.json`。

## 2. 何时使用

1. 用户在某任务会话中/结束时说“生成回放摘要 / 出个 replay-summary.json”；
2. 用户给出**历史会话**（sessionId 或会话标题）要求为其生成；
3. 用户要求刷新/覆盖已有摘要（覆盖前确认：同一会话摘要唯一）。

## 2.5 重要边界：生成动作本身绝不进入摘要（无自我引用）

回放的内容 = **用户委托执行的任务本身**。“生成这份摘要”这个动作
（读取事件库、运行 `extract-log.mjs`/`verify.mjs`、组织 phases/timeline、
写 `replay-summary.json`、复制 `artifacts/`、向用户汇报）**不是任务内容**，
禁止把它写进摘要。硬性规则：

1. **不加自指步骤**：不得出现“生成回放摘要 / 校验摘要 / 整理产物副本”之类的步骤；
2. **产物不含生成产物**：不要把本摘要/本技能脚本/本次复制的 artifacts 列为回放产物
   （只有当某个文件确实是任务自身产出、且恰好同名时，才作为任务产物保留）；
3. **task.summary 不自指**：只总结任务成果，不写“已生成回放摘要 / 可在回放中查看”这类话；
4. **时间边界**：若对话最后一段就是“生成摘要”请求（当前会话模式很常见），
   把摘要边界取在**生成动作开始之前**，其后所有轮次一律忽略；
5. 判断口诀：**回放里若出现“生成回放摘要”的字样即违规**，重写。

## 3. 第一步：提取会话轨迹（extract-log.mjs）

ZHarness 的会话存储在**每个工作区一个**的 SQLite 事件库
（`<agentDir>/workspaces/<workspace_id>/events.sqlite`，表 `events` + `sessions`），
**不是** JSONL 文件。不要直接读库——运行辅助脚本拿到紧凑轨迹草稿：

### 当前会话（推荐）
```bash
node <技能目录>/scripts/extract-log.mjs --cwd "$(pwd)"
```
- `--cwd` 传当前工作区路径，脚本自动推导 workspace_id、定位事件库、
  默认选 **sessions 表里最新** 的会话；
- 输出里 `replaydir:` 一行就是 §1 的回放目录（summary 与 artifacts 写到这里）；
- 若它选的会话不是用户要的那个，用 `--session <sessionId>` 重跑
  （脚本会列出全部会话 id 供挑选）。

### 历史会话 / 其他工作区
```bash
node <技能目录>/scripts/extract-log.mjs --db "<agentDir>/workspaces/<workspace_id>/events.sqlite" --session <sessionId>
```
- 事件库位置不知道时：`ls ~/.zharness/agent/workspaces/` 逐个看
  （目录名即 workspace_id），或用 `--cwd <那个工作区的路径>` 让脚本推导。

### 脚本输出内容
用户诉求列表、按 turn 排列的「工具调用(含成败/耗时) + 助手小结」轨迹、
事件/轮次/错误统计、候选产物文件路径。
- 要求 Node.js ≥ 22.5（用到了 `node:sqlite`）；版本不够就如实告知用户。
- 重点事件类型：`USER_MESSAGE`、`AGENT_MESSAGE_END`（含 `content` 文本块）、
  `TOOL_EXECUTION_START/END`（`tool_name`/`arguments`/`is_error`）、
  `BASH_EXECUTION`、`FILE_MUTATION_APPLIED`、`AGENT_TURN_COMPLETED`。
- 无需逐字重放：抓住“用户要什么 → 分几大步 → 每步做了什么、成败 → 有没有返工 → 产生了哪些文件”。

> 当前会话的内容本来就在你的上下文里：能直接从上下文梳理就不用跑脚本；
> 脚本主要用于补全细节（精确耗时、工具成败）和历史会话。

## 4. 第二步：梳理 task 与业务阶段（phases）

- `task.name`：任务一句话标题；`task.description`：目标；`task.result`：`completed`/`failed` 等；
  `task.summary`：一句话总结成果。
- `phases`：按业务阶段组织（默认 需求分析→方案设计→开发实现→测试验证，
  见 `references/phase-templates.md`），**允许增删/改名/调序/换语义结构**
  （如“问题接收→问题分析→修复验证”），以本次会话真实发生为准；没有内容的阶段不要放。
- `phases[].actualDuration`：该业务阶段的**真实累计耗时**（毫秒）。
  一个业务阶段被执行多轮时（如开发被返工执行两次），此值 = 所有轮次真实耗时之和
  （例如 开发实现 4小时12分 = 首轮 3小时12分 + 返工 1小时）。只用于顶部耗时展示。

## 5. 第三步：梳理真实执行顺序（timeline）

这是回放真正播放的顺序，**记录什么就播放什么**。按会话实际发生次序把各阶段切成一轮轮：

1. 普通流程：每个业务阶段正常进入一次 → `type: "normal"`。
2. 返工（从后续阶段返回此前阶段）：如 测试① 发现问题后回到 开发 修代码 →
   新增一轮 `phaseId: "development", type: "rollback", fromPhaseId: "test"`，
   `transitionMessage` 如“测试发现3个问题，返回开发修改”。
3. 修复后重新进入：修改完成再次进入 测试 → 新增一轮
   `phaseId: "test", type: "reentry"`，`transitionMessage` 如“代码修复完成，重新进入测试验证”。

示例执行顺序：`需求 → 设计 → 开发① → 测试① → 开发②(rollback) → 测试②(reentry)`。
**每个 Timeline 轮次只写本轮实际发生的步骤**（返工轮的开发只写“接收测试问题→分析→
修改→重新编译”，不要重放首轮开发全过程）。顶部阶段条依然只显示业务阶段本身
（开发只显示一次，耗时累计），**不要**造“开发①、开发②”之类的额外阶段。

## 6. 第四步：逐条列出每轮步骤（steps）

对每个 Timeline 轮次按实际发生顺序列步骤：

- `name`：动词短语（如 编写布局算法）；`description`：一句话说明（主卡片一行）；
- `tags[]`：输入/调用标签，卡片 chips（如 用户需求/项目知识/设计规则/工程源码/
  源码检索/代码开发Skill/远程编译Skill/测试环境/测试日志/人工确认）；
- `inputs[]/calls[]/outputs[]`：点击步骤展开的详情分组（材料/能力调用/结果要点）；
- `status`：`success`（已完成）| `failed`（失败，红 ✕，失败后回放继续不停止）|
  `confirmed`（人工确认，独立状态「已确认」——用于“人工确认关键约束/方案”等步骤）；
- `artifactIds[]`：该步完成后产出的 artifact id（引用同一轮 `artifacts`，随播放逐个出现）；
- `replayDuration`：建议 2400–3200ms（仅动画时长；可省略，回放默认约 3000ms）。

## 7. 第五步：每轮产物与数据结果（artifacts / metrics）

### 阶段产出（artifacts，本轮 ≤3 个核心）
- 只列**本轮**形成的关键产出：源码、diff、报告、文档、日志等；
  进入下一轮/下一阶段时，旧产出会整体刷新隐藏（不跨轮累加）。
- 类型映射：`document`(md/txt) · `code`(源码/代码目录) · `diff`(diff/patch) ·
  `report`(html/测试报告) · `log`(构建/运行日志) · `image` · `other`(其余)。
- 落地规则：
  1. 产物文件**复制/写入到回放目录内** `<回放目录>/artifacts/`（GUI 只读回放目录，
     `path` 是相对 `replay-summary.json` 的相对路径，如 `artifacts/design.md`）；
     目录型代码放 `artifacts/source/`（路径以 `/` 结尾），只挑代表文件，不要整棵大目录；
  2. 文件名：小写 kebab-case，稳定可读；多个同类加序号；
  3. `artifacts[].id` 用 `artifact-<slug>`，与同轮 `steps[].artifactIds` 引用**一一对应**；
     未被任何步骤引用的 artifact 要删掉（孤儿），引用了却不存在的 id 必须补上；
  4. 内容保持 UTF-8；超大的 log/二进制不要整份放，取有代表性的片段并注明。

> 若产物在会话中没有实体文件、只有文本内容，可以在 `artifacts/` 中新建对应文本文件再引用。

### 数据结果（metrics，本轮 ≤4 项）
- `name` + `value`（大数字文本，如 `17个`/`3个`/`100%`/`82%`）。
- 无统计数据的轮次可不放 metrics（前端会隐藏该区域）。

## 8. 第六步：落盘并自校验

1. 写入 `<回放目录>/replay-summary.json`（UTF-8，缩进 2，`schemaVersion: "2.0"`）；
2. 运行校验脚本逐项检查并修正：
   `node <技能目录>/scripts/verify.mjs <回放目录>`
   （覆盖：JSON 可解析、schemaVersion、phases/timeline 引用闭合、每轮 artifact/metrics
   上限、path 均在回放目录内且文件存在、status 枚举）；
3. 通过后向用户汇报：摘要已生成的位置、共几个业务阶段/执行轮次/步骤/产物，
   以及查看方式：在 GUI 左侧「回放」页选择本会话播放。

## 9. 质量门禁（全部满足才算完成）

- [ ] `replay-summary.json` 可被 `JSON.parse`，中文无乱码；`schemaVersion === "2.0"`；
- [ ] `phases` 非空，每项含 `id`/`name`；`timeline` 非空，每轮含 `id`/`phaseId`/`type`/`steps`；
- [ ] `type ∈ normal|rollback|reentry`；rollback/reentry 有必要的 `transitionMessage`；
- [ ] 每个 `timeline[].phaseId` 都能在 `phases` 找到；无内容阶段未放入；
- [ ] 每个 `steps[].artifactIds[]` 都能在本轮 `artifacts` 找到对应 `id`，无孤儿 artifact；
- [ ] 每轮 `artifacts` ≤3、`metrics` ≤4；`status ∈ success|failed|confirmed`；
- [ ] 每个非空 `artifacts[].path` 以 `artifacts/` 开头，解析后仍在回放目录内且真实存在；
- [ ] `phases[].actualDuration` = 该阶段所有轮次真实耗时之和（尽力而为，>0）；
- [ ] **无自我引用**：全文不描述“生成/校验本摘要”动作（见 §2.5）；
- [ ] **未**修改 events.sqlite/messages/轨迹/上下文；未重执行原任务；
- [ ] 脚本与人工双重校验通过。

## 10. 权限与异常处理

- 回放目录在 `<agentDir>/workspaces/…` 下，属于工作区**之外**。若文件工具因 sandbox
  拒绝写入：不要反复重试；改为（a）明确告知需要把执行权限提升至更高等级或经用户
  批准后再写，或（b）先在工作区内暂存目录生成好全部文件，请用户授权后一次性放入回放目录。
- 找不到事件库/会话：请用户提供 sessionId 或确认所在工作区，再重试一次；仍无则如实汇报。
- `node:sqlite` 不可用（Node < 22.5）：提示换用更新版 Node 运行脚本，
  或改用当前会话上下文 + 用户口述起草。

## 11. 参考资料

- `references/replay-summary.schema.json` —— 字段契约（schema 2.0）
- `references/example-replay-summary.json` —— 成品示例（含一次 测试→开发→测试 返工闭环）
- `references/phase-templates.md` —— 默认业务阶段/步骤模板
- `scripts/extract-log.mjs` —— SQLite 事件库 → 轨迹草稿
- `scripts/verify.mjs` —— replay-summary.json 自校验
