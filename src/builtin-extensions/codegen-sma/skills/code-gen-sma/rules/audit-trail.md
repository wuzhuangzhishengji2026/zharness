# 审计追踪规则

定义 ZHarness 事件溯源架构下，code-gen-sma 各阶段调用的审计追踪机制。

---

## 一、自动事件记录

每次 `_delegate_agent` 调用，ZHarness 自动在 EventStore（SQLite）中记录以下事件：

| 事件类型 | 触发时机 | 记录内容 | caused_by |
|---------|---------|---------|-----------|
| `USER_MESSAGE` | 用户发起代码生成请求 | 用户原始需求文本 | — |
| `AGENT_TURN_REQUESTED` | 执行者开始处理 | turn 请求 | USER_MESSAGE |
| `INTENT_TOOL_CALL` | 执行者决定委派子 agent | 工具名=cli, 参数含 _delegate_agent 和 task | AGENT_MESSAGE_END |
| `TOOL_EXECUTION_START` | 子 agent 进程启动 | 含 cwd 和 task 摘要 | INTENT_TOOL_CALL |
| `TOOL_EXECUTION_END` | 子 agent 进程结束 | 含子 agent 完整返回结果 | TOOL_EXECUTION_START |
| `TOOL_RESULTS_AGGREGATED` | 结果聚齐（单工具直接聚合） | 聚合结果 | TOOL_EXECUTION_END |
| `AGENT_TURN_COMPLETED` | 总控完成本轮 turn | turn 结束 | TOOL_RESULTS_AGGREGATED |

---

## 二、7 阶段事件链

一次完整的代码生成流程，事件日志中会记录 7 条 `_delegate_agent` 调用链：

```
USER_MESSAGE "用户需求"
  └→ AGENT_TURN_REQUESTED
       └→ INTENT_TOOL_CALL (_delegate_agent stage1)
            └→ TOOL_EXECUTION_START → TOOL_EXECUTION_END
                 └→ AGENT_TURN_COMPLETED
                      └→ AGENT_TURN_REQUESTED (stage2)
                           └→ INTENT_TOOL_CALL (_delegate_agent stage2)
                                └→ TOOL_EXECUTION_START → TOOL_EXECUTION_END
                                     └→ ... (递进到 stage7)
```

每个阶段的子 agent 有**独立的 EventStore**（因为 _delegate_agent spawn 的是独立进程），因此：

- **主控事件日志**：记录 7 次委派调用的宏观流程
- **子 agent 事件日志**：每个阶段子 agent 内部的详细操作（读文件、写代码、编译等）

---

## 三、审计回放操作

### 3.1 查看会话树

```
_history_tree
```

显示当前 workspace 的所有会话分支，含每次代码生成的 turn。

### 3.2 导出事件日志

从 ZHarness 的 SQLite 数据库导出事件日志：

```bash
# 数据库位置：<agentDir>/workspaces/<workspace_id>/events.sqlite
#   - agentDir 默认 ~/.zharness/agent（可用环境变量 ZHARNESS_CODING_AGENT_DIR 覆盖）
#   - workspace_id = "ws_" + sha256(规范化 cwd) 前 12 位，每个项目目录一个独立库
# 导出为 JSON（payload 列名为 payload_json，事件类型列名为 type）
sqlite3 ~/.zharness/agent/workspaces/<workspace_id>/events.sqlite \
  "SELECT * FROM events ORDER BY sequence;" > audit-log.json
```

### 3.3 因果链追溯

从任意阶段的返回结果，通过 `caused_by` 字段回溯到用户原始输入：

```sql
-- 递归 CTE 查询因果链（在目标 workspace 的 events.sqlite 中执行）
WITH RECURSIVE causal_chain AS (
  SELECT * FROM events WHERE event_id = '<目标事件ID>'
  UNION ALL
  SELECT e.* FROM events e
  JOIN causal_chain c ON e.event_id = c.caused_by
)
SELECT sequence, type, payload_json, timestamp
FROM causal_chain ORDER BY sequence;
```

### 3.4 阶段级审计

每个阶段的子 agent 有独立的 EventStore，可单独审计：

```bash
# 子 agent 的 EventStore 在其 cwd 对应的 workspace 下：
#   ~/.zharness/agent/workspaces/ws_<sha256(子agent cwd)前12位>/events.sqlite
sqlite3 ~/.zharness/agent/workspaces/<子agent的workspace_id>/events.sqlite \
  "SELECT * FROM events ORDER BY sequence;"
```

---

## 四、等保 2.0 三级合规对照

| 等保要求 | ZHarness 事件溯源的满足方式 |
|---------|------------------------|
| 操作留痕 | 所有 Agent 决策自动产生事件，无需手动记录 |
| 可追溯 | caused_by 因果链，从结果倒查到原始输入 |
| 可回放 | 重放事件日志重建任意时刻状态 |
| 不可篡改 | 事件日志 append-only，写入后不可修改 |
| 操作时间戳 | 每个事件含 UUIDv7 时间有序 ID + timestamp 字段 |
| 操作主体 | 每个事件含 workspace_id 和 thread_id，可定位操作来源 |
| 操作内容 | payload 含完整的工具调用参数和返回结果 |

---

## 五、审计报告生成

在阶段7（修改文件汇总）完成后，可生成审计报告：

1. **宏观流程报告**：从主控 EventStore 导出 7 次委派调用的事件链
2. **阶段详细报告**：从每个子 agent 的 EventStore 导出该阶段的详细操作
3. **因果链报告**：从最终结果通过递归 CTE 回溯到用户原始输入

报告格式建议：JSON + Markdown，存档至 `.code-gen-summary/audit/` 目录。
*（内容由AI生成，仅供参考）*
