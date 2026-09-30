# 知识沉淀规范（Knowledge Library Spec）

本文把「知识沉淀」从当前的单 prompt 定时任务系统化为一套可实施的工程规范，覆盖：库存储 schema、沉淀工作流、标签体系、系统提示词注入、资料库界面、RPC 接口、测试验收。所有现状描述均来自源码核实（引用格式 `path:L行号`）。

## 0. 现状与边界

**现状（knowledge-forge 内置扩展）：**

- 启用后在 `session_start` 时建两个每日凌晨任务：知识沉淀 02:20、技能沉淀 03:50（`src/builtin-extensions/knowledge-forge/index.ts:L107-L110`、`config.ts:L32-L42`）。
- 任务触发后调度器把 `buildDigestPrompt()` 生成的分析 prompt 派发进新会话，由主模型依次调用两个工具闭环：`knowledge_scan`（扫描窗口内会话压缩成材料）→ `knowledge_save`（写库）（`tasks.ts:L109-L136`、`index.ts:L115-L201`）。
- 库是纯 markdown 文件库：`<root>/knowledge/<category>/<yyyymmdd>-<slug>.md` 与 `<root>/skills/...`，外加人类可读 `INDEX.md`；frontmatter 为 `kind/category/title/date/tags/source_sessions`（`library.ts:L4-L12`、`L118-L134`）。
- 去重按「同 kind+category 目录下同名 title」判定，重复返回 `duplicate` 不覆盖（`library.ts:L103-L116`）。
- 库根二选一：全局 `<mainDir>/knowledge-forge/library` 或项目 `<projectDir>/.zharness/knowledge-forge/library`（`library.ts:L48-L54`），配置分全局+项目两层覆盖（`config.ts:L44-L50`、`L93-L97`）。
- 扫描侧已防自反馈：跳过 `scheduled: ` 脚手架会话与本插件派发消息（`scan.ts:L66-L69`、`L152-L153`），并有单会话 4000 字符/总量 80000 字符双重预算（`scan.ts:L70-L73`、`L299-L313`）。

**当前的缺口（即本次重构要补的）：**

1. `knowledge_save` 的 `tags` 是可选、`category` 是自由字符串（`index.ts:L165-L168`）——没有标签规范，打不打、怎么打全凭模型自觉。
2. `buildDigestPrompt` 是一段 5 步散文 prompt（`tasks.ts:L114-L136`）——筛选标准、提炼质量、tag 归一、去重时机都没有明确契约。
3. 库的内容除了 `/knowledge library` 的统计输出（`index.ts:L281-L294`）外没有任何界面。
4. 库与会话完全脱节：系统提示词只注入主 agent 的 soul 与 Long-Term Memory 索引（`system-prompt.ts:L78-L106`），沉淀的知识永远不会被「用」到。

**边界（明确不做的）：**

- 不换存储引擎。沿用现有 markdown 文件库（`library.ts`），不引入数据库/向量索引。
- 不重构 proactive-assistant 的交互式沉淀（`src/builtin-extensions/proactive-assistant/knowledge.ts`）。它写 `<mainDir>/memory/knowledge-<date>-<slug>.md` 并追加 `_index.md`（`knowledge.ts:L4-L7`、`L122-L168`），属于**主 agent 个人长期记忆**体系，经 Long-Term Memory 段注入主 agent 提示词（`system-prompt.ts:L95-L103`），触发场景是「这一轮做得好」的即时建议。本规范的新库是**跨工作区的策展知识/技能库**。两者定位不同、并存：memory 记「我是谁、用户是谁、这轮干得怎样」，library 记「可复用的知识与技能」。不迁移 memory 旧条目；后续迭代可在资料库 UI 提供「收录」动作，把某条 memory 复制进库（走 `saveEntry` 正常去重）。
- 分工原则：**模型负责判断**（筛选、提炼、tag 提案），**代码负责确定性**（schema 校验、tag 归一、去重、索引更新、注入预算）。凡是能确定性执行的步骤，绝不写进 prompt 依赖模型自觉。

---

## 1. 库存储与 frontmatter schema

### 1.1 目录布局（不变）

```
<root>/knowledge/<category>/<yyyymmdd>-<slug>.md   知识条目
<root>/skills/<category>/<yyyymmdd>-<slug>.md     技能条目
<root>/INDEX.md                                   人类可读索引（按类目分组）
```

即 `library.ts:L4-L8` 的现有布局。root 解析逻辑不变（`library.ts:L48-L54`）：全局库 `<mainDir>/knowledge-forge/library`，项目库 `<projectDir>/.zharness/knowledge-forge/library`。文件名 slug 规则（`library.ts:L57-L75`）与类目目录安全化（`library.ts:L66-L70`）不变。

### 1.2 frontmatter schema（v2）

```yaml
---
kind: knowledge            # 必填，枚举 knowledge | skill（决定写入哪个顶层目录，沿用 library.ts:L82-L84）
category: 调试技巧          # 必填，枚举值见 §1.3；枚举外值允许写入、读取时归 misc
title: Windows 上 sqlite 句柄不释放导致目录删不掉   # 必填，一句话；同 kind+category 下去重键
date: 2026-09-30           # 必填，ISO 日期（库当前实现，library.ts:L123）
tags: [knowledge-forge, type:pitfall, stack:sqlite, domain:backend]  # 必填，写法见 §1.4、体系见 §3
summary: 每会话一库的 manager 用完必须 dispose，否则 Windows 上目录无法清理。  # 新增必填，≤80 字
source_sessions: [sess_0042]   # 可选，≤5 个（沿用 library.ts:L125-L127）
schema_version: 2          # 新增必填
---
```

字段说明：

| 字段 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- |
| `kind` | 是 | `knowledge`/`skill` | 不变 |
| `category` | 是 | §1.3 枚举 | 去重键的一部分（不变） |
| `title` | 是 | 非空 | 去重键的一部分（不变，`library.ts:L92-L93`） |
| `date` | 是 | `YYYY-MM-DD` | 不变 |
| `tags` | **是（v2 变更）** | 数组，写法见 §1.4；除 provenance 标签外至少 1 个维度标签；总数 ≤8 | v1 为可选（`index.ts:L168`），v2 改为必填，`knowledge_save` 工具参数同步改为必填 |
| `summary` | **是（v2 新增）** | ≤80 字，一句话 | 供卡片与提示词注入使用，避免注入时截断正文 |
| `source_sessions` | 否 | ≤5 个 | 不变 |
| `schema_version` | **是（v2 新增）** | 整数 `2` | 供读取侧判别新旧格式 |

### 1.3 category 枚举

- **knowledge**：`环境与构建` / `调试技巧` / `工作流` / `领域知识` / `项目约束` / `工具与依赖` / `其他`
- **skill**：`命令与脚本` / `配置步骤` / `排查流程` / `工具用法` / `其他`

（在现有 prompt 示例类目「环境与构建」「调试技巧」「工作流」基础上收敛，见 `index.ts:L165`。）

枚举外值的处理：**写入允许、读取归一**。模型产出无法强约束，硬拒绝会丢内容；因此 `saveEntry` 不拒绝未知 category，但 `listEntries`（§6 的 list 实现）读取时把未知值归入 `其他/misc` 分组展示，保证界面分组稳定。目录名仍按 `categoryDir()` 安全化（`library.ts:L66-L70`）。

### 1.4 tags 写法

- 沿用现有 frontmatter 流式序列写法：`tags: [a, b, c]`（`library.ts:L124`），单个 tag 不含逗号与方括号（现有 `sanitizeList` 已剥离并限制 8 个，`library.ts:L77-L79`——v2 保留 8 的上限与剥离逻辑）。
- provenance 标签 `knowledge-forge` 由 `saveEntry` 自动置于首位（沿用 `library.ts:L124`），**不计入** 8 个上限。
- 维度标签用 `前缀:值` 形式（`type:pitfall`、`stack:typescript`），体系与归一规则见 §3。
- v2 起 `knowledge_save` 拒绝「除 `knowledge-forge` 外没有任何维度标签」的调用，返回 `invalid`（复用现有 `SaveEntryResult` 的 `invalid` 分支，`library.ts:L34-L37`）。

### 1.5 旧格式（v1）条目兼容策略

v1 条目 = 无 `schema_version`、无 `summary`、`tags` 可能缺失的存量文件。策略：**读取宽容、不强制迁移**。

- `listEntries`/`readEntry` 解析 frontmatter 时逐字段容错：`tags` 缺省按 `[]`、`summary` 缺省回退为正文第一段截断 80 字、`category` 原样保留（展示时按 §1.3 归一）。
- 去重逻辑不变：v1 文件的正文标题行 `# <title>` 仍命中现有去重判定（`library.ts:L109`）。
- 不提供一次性迁移脚本；提供惰性补写：资料库 UI 的条目详情对 v1 条目显示「旧格式」徽记，后续可加「补齐字段」动作（走 `saveEntry` 更新通道时再议，首版不做）。
- `INDEX.md` 格式不变（`library.ts:L147-L168`），新旧条目混排无碍。

---

## 2. 沉淀工作流

### 2.1 实现形态

调度机制不变：每日任务把 prompt 派发进新会话，模型驱动工具闭环（`tasks.ts:L109-L113` 的契约注释）。重构的是 **prompt 内部结构** 与 **工具/schema 的配合**：

- `buildDigestPrompt()`（`tasks.ts:L114-L136`）从 5 步散文改为下述 8 步显式工作流，每步写明输入、输出与质量标准；
- 确定性步骤下沉代码：tag 归一（§3）、去重（`library.ts:L103-L116`）、索引更新（`library.ts:L141`）全部由 `saveEntry` 服务端执行，prompt 只要求模型「提案」，不允许模型绕过；
- `knowledge_save` 参数 schema 更新：`tags` 改必填、新增 `summary` 必填、`category` 描述里列出枚举（`index.ts:L161-L172` 的 TypeBox 定义处）。

### 2.2 八步工作流

| # | 步骤 | 输入 | 输出 | 执行者 | 质量标准 |
| --- | --- | --- | --- | --- | --- |
| 1 | 扫描 | `window`/`destination` 配置（`config.ts:L21-L30`） | 材料包 markdown（`renderScanResult`，`scan.ts:L318-L347`） | `knowledge_scan` 工具 | 材料截断时新会话优先（已实现，`scan.ts:L299-L313`）；材料为空则直接跳到步骤 8 报告「无内容」 |
| 2 | 候选筛选 | 材料包 | 候选清单（每条：出处会话 id + 一句话价值主张） | 模型 | 见 §2.3 的收录/丢弃标准；每条候选必须能指回具体会话，不允许「凭印象」 |
| 3 | 提炼 | 单条候选 | 自包含 `content` + `title` + `summary` | 模型 | 脱离原会话可读懂、可直接复用；知识=结论+适用条件+出处，技能=前置条件+可执行步骤/命令；每条 ≤1200 字；禁止空洞口号 |
| 4 | 打 tag | 单条提炼结果 + 会话所在工作区 cwd（材料里有，`scan.ts:L30`、`L326`） | tag 提案（≥1 个 `type:*`，适用时 `domain:*`/`stack:*`/`project:*`） | 模型 | `project:*` 值由工作区目录名推导（小写化）；每条恰好 1 个 `type:*` |
| 5 | tag 归一 | tag 提案 | 归一后的 tags 数组 | **代码**（新 `normalizeTags()`，§3.2） | 小写化、同义词合并、前缀合法化、维度上限、总数 ≤8；模型不可绕过——`saveEntry` 服务端再跑一遍 |
| 6 | 去重 | 待入库条目 | 放行 / 判重 | **代码**（`saveEntry`，`library.ts:L103-L116`）+ 模型辅助 | 代码级：同 kind+category 同名 title 判重返回 `duplicate`；模型级：prompt 注入最近条目清单（`libraryStats.recentTitles` 已有，`library.ts:L177-L197`），要求保存前先比对、近义条目合并到已有条目的判断写进 prompt |
| 7 | 入库 | 通过去重的条目 | 落盘文件 + `saved`/`duplicate` 回执 | `knowledge_save` 工具 → `saveEntry` | 原子写（临时文件+rename，`library.ts:L137-L139`）；frontmatter 按 §1.2 生成 |
| 8 | 更新索引 + 总结 | 本次全部回执 | INDEX.md 追加行 + 会话内 3-5 行总结 | 索引：**代码**（`updateIndex`，`library.ts:L147-L168`）；总结：模型 | 索引幂等（同链接不重复追加）；总结含「沉淀 N 条 / 跳过 M 条及原因」，跳过不算失败 |

### 2.3 收录与丢弃标准（写进 prompt 的质量门槛）

**值得沉淀（收录）：**

- 可复用的事实结论：环境/依赖/版本的确定性行为（如「Windows 上 sqlite 句柄不关会锁死目录」）；
- 踩坑与解法：报错现象 + 根因 + 可执行的修复；
- 决策依据：为什么选了 A 方案不选 B（含被否决项）；
- 领域/项目约束：业务规则、项目特有的目录约定、发布流程；
- 可执行技能：命令组合、配置步骤、排查流程、工具用法。

**必须丢弃：**

- 一次性上下文：具体某文件某行的改动、临时调试输出、当次任务的中间态；
- 常识与官方文档可查内容（语言语法、API 签名）；
- 空洞口号（「要写干净的代码」）；
- 敏感信息：凭据、密钥、token、个人隐私数据——扫描材料中疑似出现的，提炼时必须剔除；
- 与库中已有条目近义且无增量的内容（步骤 6 拦截）。

---

## 3. 标签体系

### 3.1 预定义维度

标签分「维度标签」（`前缀:值`，前缀是保留词）与「自由标签」（无前缀）两类。四个预定义维度：

| 维度前缀 | 含义 | 每条数量 | 取值 |
| --- | --- | --- | --- |
| `type:` | 条目类型 | **恰好 1 个（必填）** | `fact` 事实结论 / `pitfall` 踩坑与解法 / `decision` 决策依据 / `howto` 操作流程 / `reference` 参考资料 |
| `domain:` | 领域 | 0-1 | `frontend` / `backend` / `devops` / `data` / `mobile` / `testing` / `security` / `docs` |
| `stack:` | 技术栈 | 0-3 | 自由值（小写），如 `typescript` / `react` / `node` / `sqlite` / `rust` / `tauri` |
| `project:` | 项目 | 0-1 | 工作区目录名小写化（与 `deriveWorkspaceId` 的输入同源，`index.ts:L48` 引用的 `src/core/event-store/workspace.ts`），如 `zharness`；全局通用条目不打 |

自由标签：0-3 个，无前缀，小写（中文保留原样），用于维度覆盖不到的横切概念（如 `windows`、`性能`）。

### 3.2 归一规则（`normalizeTags()`，确定性，新模块 `knowledge-forge/tags.ts`）

按序执行：

1. `trim` + 值部分全小写（中文不变）；空前缀/空值丢弃；
2. **同义词合并**：内置初始表 + 用户可编辑的 `<mainDir>/knowledge-forge/synonyms.json`（缺文件用内置表）。初始表示例：`ts→typescript`、`js→javascript`、`前端→frontend`、`后端→backend`、`排错→pitfall`、`k8s→kubernetes`；
3. **前缀合法化**：未知前缀（非 `type:/domain:/stack:/project:`）降级为自由标签；`type:` 值不在枚举内时降级为自由标签；
4. **维度上限**：`type`=1、`domain`=1、`stack`=3、`project`=1、自由=3；超限按提案顺序截断；
5. **总数 ≤8**（不含自动置首的 `knowledge-forge`，沿用 `library.ts:L77-L79` 的上限）；
6. 去重（归一后撞名的只留第一个）。

`normalizeTags()` 同时在两处执行：`knowledge_save` 工具入口（`index.ts:L173-L201` 的 execute 内）与 `saveEntry` 内部（兜底，防其他调用方绕过）。

### 3.3 标签的治理

- 标签全集不预建表、不审批——从库中实际条目聚合产生（§6 `knowledge_library_tags`），避免「先有 taxonomy 还是先有内容」的死锁；
- 同义词表是唯一的治理杠杆：发现两个 tag 表达同一含义时，人改 `synonyms.json`，新条目即归一；存量条目不做批量改写（读取侧聚合时也过一遍归一，展示自动合并）。

---

## 4. 提示词注入策略

### 4.1 注入位置与形态

- **位置**：`buildSystemPrompt()`（`system-prompt.ts:L109`）中，`mainAgentPrefix`（banner/Identity/Long-Term Memory，`system-prompt.ts:L78-L106`）**之后**，新增 `# Knowledge Library` 段。注意 `buildSystemPrompt` 有**两个分支**：customPrompt 分支（`prompt = mainAgentPrefix + customPrompt`，`system-prompt.ts:L138-L168`；customPrompt 由 `session-facade-factory.ts:L438` 传入）与默认正文分支（`You are an expert coding assistant...`，`system-prompt.ts:L257-L296`）。注入段必须接在 `mainAgentPrefix` 的组装点（`system-prompt.ts:L124`）之后、**分支分流之前**——即把 `knowledgeDigest` 拼进统一前缀再进两个分支，两个分支都生效，不允许只改默认分支（否则配置了 SYSTEM.md 的项目会静默丢失注入）。实现通道与 soul/memory 相同：`BuildSystemPromptOptions` 新增 `knowledgeDigest?: string` 字段（同 `system-prompt.ts:L62-L65` 的 `soulFile`/`longTermMemory` 模式），由 `session-facade-factory.ts` 的 `buildPromptForTools()`（`session-facade-factory.ts:L373-L462`）组装传入。
- **生效范围**：**所有会话**（不限主 agent）。Long-Term Memory 仅主 agent（`session-facade-factory.ts:L418-L419`），但知识库的主要消费场景恰恰是项目工作区会话，故不做 `isMainAgent` 门控。
- **形态**：索引式，不注入全文——与 `loadLongTermMemory` 只注入 `_index.md` 同一设计（`main-agent.ts:L228-L236` 的注释明确说明理由）。每条一行：
  `- [标题](绝对路径) — summary（tags 简写）`。
  **路径必须是绝对路径**：候选集混排全局/项目两个 root（§4.2），相对路径本身有歧义，且全局库 root `<mainDir>/knowledge-forge/library` 在工作区之外（`library.ts:L53`），模型拿相对路径用 `_read` 无从定位；对照被照抄的 memory 注入传的就是绝对路径（`main-agent.ts:L222`、`L266`）。
  段首指引句注明两个库根的绝对路径：「以下为本地知识库中与当前工作区相关的条目索引（全局库 <root 绝对路径>；项目库 <root 绝对路径>），需要全文时用 cli 的 `_read` 命令按上面的绝对路径读取」（措辞模式照抄 `system-prompt.ts:L99-L100`）。项目库 root 不存在时省略项目库部分。

### 4.2 条目选取规则

新增 core 侧只读模块（`src/core/knowledge-digest.ts` 或挂在 resource-loader 上，参照 `getSoulFile`/`getLongTermMemory` 的可选方法模式，`resource-loader.ts:L42-L50`）：

1. **候选集**：全局库 ∪ 项目库（两个 root 都存在时都读；root 解析复用 `resolveLibraryRoot`，`library.ts:L48-L54`）；项目库 root 用当前 sidecar cwd；
2. **匹配加分**：条目 `project:` 标签 == 当前 cwd 目录名小写化 → +3；无 `project:` 标签的全局条目 → +1；`project:` 不匹配的条目 → +0（仍可凭 recency 入选，但排在后面）。首版只做 project 维度匹配；stack/domain 与工作区信号的匹配留作后续迭代；
3. **排序**：匹配分降序 → `date` 降序；
4. **截取**：前 `injectMaxEntries` 条（默认 8）。

### 4.3 token 预算与截断

- digest 总字符 ≤ `injectMaxChars`（默认 4000 字符，约 1000-1500 token——参照扫描侧单会话预算量级，`scan.ts:L70`）；
- 单条贡献 = 标题 + summary（schema 已限 ≤80 字，§1.2）+ 路径 + tags，天然有界；
- 超出预算时按排序截断，段尾标注「另有 K 条未列出，可用 knowledge_library_list 查询」；
- v1 条目的 summary 回退（§1.5）同样参与，截断在字符边界、不截断单条中间。

### 4.4 配置开关与默认值

`KnowledgeForgeConfig` 扩展三个字段（`config.ts:L21-L30` 处新增，`normalizeConfig` 给默认值，`config.ts:L77-L84`）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `injectEnabled` | boolean | `true` | 总开关；`false` 时 `# Knowledge Library` 段整体缺席 |
| `injectMaxEntries` | number | `8` | 注入条目上限 |
| `injectMaxChars` | number | `4000` | 注入段字符预算 |

沿用现有配置分层（全局 `<mainDir>/knowledge-forge/config.json` ← 项目 `<projectCwd>/.zharness/knowledge-forge.json` 覆盖，`config.ts:L93-L97`）。`/knowledge config` 命令补一个 `inject on|off` 子键（`index.ts:L237-L267` 的 config 分支处）。配置变更在会话边界随系统提示词重建生效（`refreshSystemPromptWithBreadcrumb`，`session-facade-factory.ts:L483-L492`），无需重启 sidecar。

---

## 5. 资料库界面信息架构

### 5.1 入口与路由

- 左侧主导航新增「资料库」条目（NavLink → `/library`），位置与样式参照「定时任务」条目（`apps/web/src/components/Layout.tsx` 的 `/tasks` NavLink，`L529-L542`）；
- 路由注册参照 `AutomationView` 的挂法（`apps/web/src/App.tsx:L625`）；
- 页面组件：`apps/web/src/views/LibraryView.tsx`；数据层：`apps/web/src/lib/library.ts`（`sendCommandAwait` 封装 + 形状防御，风格照 `lib/assistant.ts:L32-L60` 与 `lib/scheduler.ts:L56`）。

### 5.2 视图布局（参考 workbuddy 资料库，组件全部复用现有）

```
┌────────────────────────────────────────────────────────────┐
│ PageHeader: 资料库          [tab: 全部|知识|技能] [搜索框]   │
├──────────┬─────────────────────────────────────────────────┤
│ 左栏 220px│  标签 chips 行（多选过滤）                      │
│ ▸ 最近    │ ┌──────┐ ┌──────┐ ┌──────┐                     │
│ ▸ 收藏 ★  │ │卡片  │ │卡片  │ │卡片  │  ← 3 列卡片网格     │
│ 文件夹:   │ └──────┘ └──────┘ └──────┘                     │
│  ▸ 调试技巧│        ……（按分页/滚动加载）                    │
│  ▸ 工作流 │                                                 │
└──────────┴─────────────────────────────────────────────────┘
         点击卡片 → 右侧 440px 详情抽屉（markdown 阅读）
```

- **PageHeader**（`ui.tsx:L29-L54`）：标题 + 右侧 kind tab（全部/知识/技能）+ 搜索框（盒式输入，样式参照 `AutomationView.tsx:L438-L439`）。
- **左栏分组树**：`最近`（最近 20 条，按 date 倒序）、`收藏`、按 category 的「文件夹」分组（图标 + 条目数），点击即过滤；分组数据来自 `knowledge_library_stats` 与 `knowledge_library_list`。
- **卡片网格**：3 列（同 AutomationView 卡片网格模式）。卡片内容：kind `Badge`（`ui.tsx:L64-L84`）+ 标题 + summary 两行截断 + tags chips（样式沿用 `ProactiveAssistantWidget.tsx:L365` 的 `rounded bg-surface-2 px-1.5 py-0.5`）+ date + 收藏星标 + v1 条目「旧格式」徽记（§1.5）。
- **详情抽屉**：右侧 440px（沿用 AutomationView DetailDrawer 模式，`AutomationView.tsx:L96-L110`）：markdown 渲染正文、frontmatter 元信息表（category/date/tags/source_sessions/路径）、操作行（收藏切换 / 删除）。删除走 `ConfirmDialog`（`ui.tsx:L313-L351`）。
- **加载/空态**：`Spinner` + `EmptyState`（`ui.tsx:L201-L251`）。

### 5.3 各交互行为定义

| 交互 | 行为 |
| --- | --- |
| 搜索 | 对标题 + summary + tags + 正文做大小写不敏感子串匹配；300ms 防抖；与 tab/标签/分类过滤 **AND** 叠加（参照 `AutomationView.tsx:L303-L314` 的 `useMemo` 过滤模式；数据量大时下推为 `knowledge_library_list` 的 `query` 参数） |
| tab 过滤 | 全部 / 知识 / 技能（kind），单选 |
| 标签过滤 | chips 行展示 `knowledge_library_tags` 返回的 top 标签（按 count 降序，最多 20 个）；点击切换选中，多选 **OR**，与其他条件 AND |
| 分类（文件夹） | 左栏 category 单选；`最近`/`收藏` 是伪文件夹，与 category 互斥 |
| 详情阅读 | 抽屉内渲染完整 markdown 正文；`source_sessions` 显示为会话 id 文本（首版不做跳转） |
| 收藏 | 星标切换；**用浏览器 localStorage 实现**，键 `zharness:library:favorites`，存条目相对路径数组；直接复用 `usePersistedState`（自带 `zharness:` 前缀与异常吞没，`usePersistedState.ts:L8-L30`）。取舍说明：收藏是纯前端偏好、不换设备同步，刻意不动存储层、不加 RPC |

### 5.4 数据刷新

复用「事件做提示、数据走 RPC」模式（`lib/assistant.ts:L7-L8` 的注释原话；订阅实现 `L108-L120`）：`saveEntry`/`deleteEntry` 成功后由扩展侧广播 `CUSTOM_MESSAGE`（`kind: "knowledge_library_changed"`，参照 proactive_assistant_changed），前端收到后重新拉取 `knowledge_library_list`；同时保留定时任务事件（`SCHEDULED_TASK_COMPLETED`）的防抖刷新兜底（`AutomationView.tsx:L250-L274` 的模式）。

---

## 6. RPC 接口清单

风格对齐 `schedule_*`：命令是 `RpcCommand` 并集的**顶层成员**（`packages/protocol/index.ts:L548-L557` 的位置与形状），每条命令在 `RpcResponse` 有同名 typed data 行（`index.ts:L882-L891`），handler 落在 `rpc-mode.ts` 的命令 switch 里，用 `success(id, command, data)` / `error(id, command, message)` 返回（`rpc-mode.ts:L1419-L1606` 的现有范式）。protocol 包保持零依赖，只加类型。

### 6.1 新增协议类型（`packages/protocol/index.ts`）

```ts
export interface KnowledgeEntrySummary {
  /** 库内相对路径，如 "knowledge/调试技巧/20260930-sqlite-handle.md" —— 条目的稳定 id */
  path: string;
  kind: "knowledge" | "skill";
  category: string;          // 归一后的展示类目（§1.3）
  title: string;
  date: string;              // YYYY-MM-DD
  tags: string[];            // 归一后
  summary: string;           // v1 条目回退为正文首段 ≤80 字（§1.5）
  sourceSessions?: string[];
  scope: "global" | "project";
  schemaVersion: 1 | 2;
}

export interface KnowledgeLibraryStats {
  knowledge: { categories: number; entries: number };
  skills: { categories: number; entries: number };
  tagCount: number;
  lastEntryAt?: string;      // 最新条目的 date
  roots: { global: string; project?: string };
}
```

### 6.2 命令清单

| type | 参数 | 返回 data | 说明 |
| --- | --- | --- | --- |
| `knowledge_library_list` | `{ scope?: "global" \| "project" \| "all"; kind?: "knowledge" \| "skill"; category?: string; tags?: string[]; query?: string; limit?: number; offset?: number }` | `{ entries: KnowledgeEntrySummary[]; total: number }` | scope 默认 `"all"`（全局 ∪ 本 sidecar 项目库）；`tags` 多值为 OR；`query` 为标题/summary/正文子串；`limit` 默认 100、上限 500；`total` 为过滤后总数（分页用） |
| `knowledge_library_read` | `{ path: string }` | `{ entry: KnowledgeEntrySummary & { content: string } }` | `content` 为完整文件正文（frontmatter 之后的 markdown） |
| `knowledge_library_stats` | `{ scope?: "global" \| "project" \| "all" }` | `{ stats: KnowledgeLibraryStats }` | 对齐现有 `libraryStats()` 的返回形状（`library.ts:L170-L197`）并扩展 tag/roots 信息 |
| `knowledge_library_tags` | `{ scope?: "global" \| "project" \| "all" }` | `{ tags: Array<{ name: string; count: number }> }` | 全库 tag 聚合，归一后计数，按 count 降序；不含 provenance 标签 `knowledge-forge` |
| `knowledge_library_delete` | `{ path: string }` | `{ ok: true; path: string }` | 删文件并同步移除 INDEX.md 对应行；条目不存在返回 error |

**不开放 `knowledge_library_save`**：写入仍只走 agent 工具 `knowledge_save` 与定时任务（§2），保持「沉淀是显式/自动流程，UI 只读 + 管理」的边界。后续若支持 UI 手工新建再补。

### 6.3 安全与错误约定

- **路径安全**：`path` 参数必须是库内相对路径；`resolve` 后必须仍落在对应库 root 内，含 `..`、绝对路径、符号链接逃逸的一律 `success:false`（错误信息同 `schedule_*` 的直白风格，如 `rpc-mode.ts:L1429`）。
- **参数非法**（limit 超界、kind 非枚举等）：`success:false` + 原因，不静默兜底。
- **库不存在**（root 目录还没建过）：list/tags 返回空集、stats 返回全零，不报错——与 `libraryStats` 对缺失目录的现有容忍一致（`library.ts:L185`）。
- **sidecar 作用域**：rpc-mode 是 per-workspace sidecar；`scope:"all"` 时全局库 root 用 `getMainDir()`、项目库 root 用本 sidecar cwd（与 `resolveLibraryRoot` 同参数，`library.ts:L48-L54`）。别的项目窗口的库不跨进程读（与 schedule 任务「谁拥有谁执行」的分scope原则一致，`index.ts:L72-L88`）。

### 6.4 实现位置

- 读库纯函数（`listEntries`/`readEntry`/`deleteEntry`/`collectTags`/`stats`）加在 `src/builtin-extensions/knowledge-forge/library.ts`，roots 可注入（保持 `saveEntry`/`libraryStats` 同文件同风格，测试用临时目录）；
- frontmatter 解析为新增的轻量解析器（手写 `---` 块切分 + 行式字段读取，不引 YAML 依赖——protocol 包零依赖、核心包也不为 6 个字段引依赖）；
- handler 加在 `rpc-mode.ts` 命令 switch（`schedule_history` 之后，`rpc-mode.ts:L1603-L1606` 附近）；
- 前端封装 `apps/web/src/lib/library.ts`（§5.1）。

---

## 7. 测试与验收标准

测试框架 vitest，命令 `npm test`（即 `ZHARNESS_OFFLINE=1 vitest --run --no-file-parallelism --poolOptions.forks.singleFork`，`package.json:L45`）；测试文件放 `test/`，用 tmpdir fixture（参照 `test/knowledge-forge.test.ts:L12-L21` 的现有约定）。

### 7.1 领导要求①：沉淀有规范、有工作流、能打 tag

| 验证项 | 方法 | 通过标准 |
| --- | --- | --- |
| tag 归一 | 单元测试 `normalizeTags()` | 小写化/同义词合并/未知前缀降级/维度上限/总数 ≤8/去重，逐条断言 |
| tags 必填 | 单元测试 `saveEntry` + `knowledge_save` | 除 `knowledge-forge` 外无维度标签 → 返回 `invalid`，不落盘 |
| category 枚举 | 单元测试 `listEntries` | 枚举外 category 的条目读取时归入 `其他/misc` 分组 |
| v1 兼容 | 单元测试：手写无 `summary`/`tags`/`schema_version` 的 v1 文件 | `listEntries` 可读、`summary` 回退正文首段 ≤80 字、`schemaVersion===1` |
| 工作流 prompt | 单元测试 `buildDigestPrompt()` | 输出包含 §2.2 的 8 个步骤与 §2.3 的收录/丢弃门槛关键词；`knowledge` 与 `skill` 两个 purpose 分别断言 |
| 端到端入库 | 集成测试（tmpdir 库）| 模拟一次沉淀：`saveEntry` 落盘文件的 frontmatter 含 `schema_version: 2`、归一后 tags、`summary`；`INDEX.md` 追加对应行；同 title 重复保存返回 `duplicate`（沿用 `library.ts:L103-L116` 行为） |

### 7.2 领导要求②：资料库界面

| 验证项 | 方法 | 通过标准 |
| --- | --- | --- |
| RPC list 过滤 | 单元测试 handler 层（tmpdir 库 + 假 facade） | kind/category/tags(OR)/query/limit/offset 各自与叠加过滤结果正确；`total` 为过滤后总数 |
| RPC 路径安全 | 单元测试 `knowledge_library_read`/`delete` | `../x.md`、绝对路径、root 外路径一律 `success:false` |
| RPC tags 聚合 | 单元测试 `knowledge_library_tags` | 归一后计数正确、按 count 降序、不含 `knowledge-forge` |
| delete 同步索引 | 单元测试 | 删文件后 INDEX.md 对应行移除、其余行不动 |
| 界面可达性 | 手工验收 | 左侧导航出现「资料库」，点击进入 `/library`；卡片网格/左栏文件夹/最近/收藏 tab 均渲染 |
| 界面过滤 | 手工验收 | 搜索防抖生效；tab/标签/分类/收藏条件叠加结果正确；详情抽屉正文完整可读 |
| 收藏持久化 | 手工验收 | 收藏后刷新页面仍在；`localStorage["zharness:library:favorites"]` 为相对路径数组；禁用 localStorage（隐私模式）界面不崩（`usePersistedState` 吞错，`usePersistedState.ts:L13-L15`） |

### 7.3 领导要求③：使用时关联（提示词注入）

| 验证项 | 方法 | 通过标准 |
| --- | --- | --- |
| 注入位置 | 单元测试 `buildSystemPrompt()`（可挂在现有 `test/system-prompt.test.ts` 同风格） | 传入 `knowledgeDigest` 时 `# Knowledge Library` 段出现在 mainAgentPrefix 之后、`You are an expert coding assistant` 之前 |
| 开关 | 单元测试 | `injectEnabled=false` 时段落整体缺席 |
| 预算 | 单元测试 digest 生成 | 条数 ≤ `injectMaxEntries`；总字符 ≤ `injectMaxChars`；截断后段尾有「另有 K 条未列出」 |
| 匹配排序 | 单元测试：构造带 `project:zharness` 与无 project 标签的条目 | 当前 cwd 目录名为 `zharness` 时 project 匹配条目排最前；同分按 date 倒序 |
| 生效范围 | 集成测试（非主 agent 会话） | 普通项目工作区会话的系统提示词同样包含 `# Knowledge Library` 段（区别于 Long-Term Memory 的主 agent 门控，`session-facade-factory.ts:L418-L419`） |

### 7.4 回归要求

- `test/knowledge-forge.test.ts` 现有用例（config/scan/library/tasks 四组，`L82`/`L124`/`L228`/`L298`）在本重构后全部保持绿色；`saveEntry` 签名变更处同步更新。
- `npm test` 全量绿；web 侧 `npm run build:web`（`package.json:L39`）通过类型检查。

---

## 附：名词表

- **沉淀（distill）**：从会话材料提炼可复用知识/技能并写库的全过程（§2）。
- **维度标签 / 自由标签**：见 §3.1。
- **v1 / v2 条目**：无 `schema_version` 的存量条目为 v1；本规范定义的为 v2（§1.5）。
- **资料库**：本规范定义的本地知识管理界面（§5），区别于主 agent 记忆库 `<mainDir>/memory/`（§0 边界）。
