# 主动式交互助手（proactive-assistant）设计

一个后台小助手：在用户与主模型交互过程中实时分析当前活跃对话，
**阻塞时**主动给出脱困建议，**做得好时**提示用户把本次经验沉淀为长期知识。
目标是让工具"更懂用户"，同时绝不打扰用户。

## 三条设计原则

1. **不打扰**（Non-intrusive）
   - 建议不进入聊天流、不进入 LLM 上下文（`CUSTOM_MESSAGE(display:false)` 广播）。
   - GUI 上是右下角浮动角标 + 数字，用户主动点开才展开。
   - 同类建议有冷却期；免打扰（mute）；知识沉淀每会话最多提示一次。
2. **确定性分析**（Deterministic）
   - 分析器是纯规则引擎，不额外调用 LLM：零成本、零延迟、不与主循环抢上下文。
   - 所有结论可由事件流复核（信号在 analyzer 内累积，随时可查）。
3. **同一套扩展机制**（Native extension）
   - 与 task-board / context-editor 相同的三面模式：
     `/assistant` 斜杠命令（TUI）、`proactive_assistant` RPC（GUI）、
     事件广播（多端同步）。启用/禁用走 `settings.disabledBuiltinExtensions`。

## 架构

```
┌──────────────────────────── sidecar（agent 进程） ────────────────────────────┐
│                                                                              │
│  扩展 hooks（index.ts）                                                       │
│  ├ before_agent_start ─┐                                                      │
│  ├ tool_execution_end  ├─→ analyzer.ts（规则引擎，累积信号）                    │
│  ├ message_end(assistant) ┘        │                                          │
│  └ agent_end ────────────→ 结算本轮 → store.ts（建议生命周期）                  │
│                                    │                                         │
│                    ┌───────────────┴───────────────┐                          │
│                    ▼                               ▼                          │
│          CUSTOM_MESSAGE(display:false)      knowledge.ts                     │
│          kind=proactive_assistant_changed   （沉淀→主 agent 记忆库            │
│                    │                        memory/*.md + _index.md）         │
└────────────────────┼──────────────────────────────────────────────────────────┘
                     │ rpc_event 转发（bridge）
┌────────────────────▼─────────── Web GUI ──────────────────────────────────────┐
│  lib/assistant.ts（RPC + 事件订阅）                                            │
│  ProactiveAssistantWidget（右下角浮动小助手：角标→面板→建议卡片→知识编辑弹窗）   │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 信号 → 建议（analyzer）

信号在一轮 agent loop 内累积，`agent_end` 时结算，产出 0..1 条建议。
所有阈值集中在 `analyzer.ts` 顶部常量，可测试可调整。

### 阻塞类（stuck）

| id | 触发条件（默认阈值） | 建议动作 |
|----|--------------------|---------|
| S1 | 本轮连续工具失败 ≥ 3 次 | steer：让主模型先复盘再换思路 |
| S2 | 同一命令/同一目标连续相同失败 ≥ 2 次 | steer：换一种方式达成目标 |
| S3 | assistant `stopReason = "length"`（被 max tokens 截断） | steer："继续" |
| S4 | `agent_end` 时上下文使用率 ≥ 85% | compact |
| S5 | assistant `stopReason = "error"` | steer：总结错误并重试 |

优先级 S5 > S1 > S2 > S3 > S4，一轮只出最高优先级一条（避免轰炸）。

### 顺利类（success）

| id | 触发条件（默认阈值） | 建议动作 |
|----|--------------------|---------|
| K1 | 本轮 reason=stop 顺利完成 + 工具调用 ≥ 5 + 零失败 + 会话内已 ≥ 2 个用户轮 | save_knowledge（沉淀本次经验） |

K1 每会话只提示一次（`knowledgeOffered` 标记）。

## 建议生命周期（store）

```
active ──dismiss──→ dismissed
   │──apply──────→ applied
   └──新用户消息──→ expired（knowledge_offer 到期；stuck 类保留）
```

- 冷却：同一 `kind` 在 cooldownMs（默认 5 分钟）内不重复产生。
- 容量：active 上限 3 条，超出移除最旧。
- 免打扰：`mutedUntil` 时间戳，静默期内不产生新建议（已有建议仍可查看）。
- 状态是进程内单例（同 context-editor state.ts 模式）：扩展 hooks 与
  RPC 数据面共享；sidecar 重启即清空——建议本来就是"当下"的语义。

## 知识沉淀（knowledge）

目标位置 = 主 agent 长期记忆库（`~/.zharness/main/memory/`，与 get_persona /
PersonaCard 同一体系）：

- 新文件 `knowledge/<slug>.md`：frontmatter（date/session/tags）+ 正文。
- 同步在 `_index.md` 追加一行 `- <file> — <摘要>`，让下次会话的系统提示词
  （long-term memory index）自然带上它——沉淀后立刻"生效"。
- 草稿从会话投影生成：用户目标（首条用户消息）+ 过程统计 + 最终结论
  （最后一轮 assistant 文本），用户在 GUI 编辑确认后落盘。
- 沉淀是显式动作：永远由用户点击并确认，助手只负责"提议 + 预填"。

## RPC 协议（packages/protocol）

命令 `proactive_assistant`：

| action | 入参 | 出参 |
|--------|------|------|
| list | — | active 建议 + 扩展加载状态 + 会话统计 + mutedUntil |
| dismiss | suggestionId | dismissed |
| apply | suggestionId | 执行建议动作（compact / steer / continue），返回 applied + 动作名 |
| knowledge_draft | suggestionId | 生成的知识草稿（title/content/tags） |
| knowledge_save | title, content, tags | 写入记忆库的文件路径（含 suggestionId 的建议由 GUI 显式 dismiss） |
| clear | — | cleared |
| mute | minutes | mutedUntil |

事件广播：`CUSTOM_MESSAGE(extension_id="proactive-assistant",
kind="proactive_assistant_changed", data={reason:"changed"}, display:false)`，
同一 tick 内的多次变更合并为一条；GUI 收到后调用 `list` 拉全量
（同 task-board 的"事件做提示、数据走 RPC"模式）。

## GUI（apps/web）

- `ProactiveAssistantWidget` 挂在 App 根（与 ExtensionUIDialog 平级，
  所有页面右下角可见）。
- 角标（badge）：**常驻显示**——有 active 建议时高亮 + 数字 + 呼吸动画；
  无建议时低对比静默态，点开可随时查看空态、会话轮数与扩展加载状态；
  免打扰期间显示静音态，可在面板一键解除。
- 面板：建议卡片列表，每张卡片 = 图标 + 标题 + 正文 + 动作按钮。
- 知识沉淀流：卡片「沉淀为知识」→ 拉草稿 → 编辑弹窗（可改标题/正文/标签）
  → 保存 → toast 显示落盘路径。
- 免打扰：面板底部「1 小时内不再提醒」/「解除免打扰」。

## TUI（斜杠命令）

`/assistant list|clear|mute <分钟>`：文本形态查看/管理；建议产生时通过
footer `setStatus` 显示轻量计数（`助手建议 x1`），不弹对话框。

## 明确不做（V1 边界）

- 不用第二个 LLM 分析对话（确定性规则已覆盖主要阻塞形态）。
- 不注册 agent 工具（这是用户面功能，LLM 无需感知）。
- 不做每条建议的持久化（sidecar 生命周期 = 建议生命周期）。
- 不自动执行任何建议动作（apply 一律来自用户点击）。
