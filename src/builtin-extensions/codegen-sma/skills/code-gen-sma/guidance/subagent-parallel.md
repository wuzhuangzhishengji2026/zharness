# 子智能体并行（复杂任务·子任务独立）

> 参考 superpowers `subagent-driven-development`（每任务派发新子智能体 + 两级评审：spec 合规 → 代码质量）
> 与 `dispatching-parallel-agents`（2+ 独立问题域 → 每域一个 agent 并行 → 返回后 review + integrate + 全量测试）。
> 本路径用于**复杂任务且子任务相互独立**（判定标准见 `workflow-router.md`，≥2 分且子任务独立）。

## 一、核心思想

- 每个子任务由**独立子智能体**在**隔离上下文**中完成（独立 EventStore、独立压缩、独立审计）
- 子智能体并行执行，主上下文不被中间步骤撑大，只接收每个子智能体的最终摘要
- 完成后做**两级评审**（先 spec 合规、再代码质量），最后**集成验证**

## 二、流程

```
1. 任务分析
   - 拆解复杂任务为独立子任务（问题域划分：模块 / 文件 / 领域）
   - 确认子任务间无强数据依赖、无共享可变状态

2. 定义子任务规格（每个子任务包含）
   - 目标产物（文件路径、接口签名）
   - 输入（读取哪些已有文件）
   - 约束（遵循哪些规则/风格，如 knowledge-arch.md）
   - 完成标准（可验证的行为）

3. 并行派发（二选一）
   A. 推荐：scripts/parallel_delegate.py 并行运行多个 ZHarness 子进程
      python <skillRoot>/scripts/parallel_delegate.py --cli <zharness路径> \
        --tasks <tasks.json> [--timeout 秒] [--agent-dir <dir>]
      tasks.json 格式：
      [
        {"id":"t1","cwd":"<项目目录>","task":"<子任务完整描述>"},
        {"id":"t2","cwd":"<项目目录>","task":"<子任务完整描述>"}
      ]
      → 每个子进程独立 EventStore，输出 JSON 汇总（id/exit_code/output/error）
   B. 兜底：逐个 _delegate_agent（同步阻塞，逻辑独立但物理顺序）
      _delegate_agent cwd="<项目目录>" task="<子任务描述>"
      → 每个子 agent 独立上下文，自动产生 TOOL_EXECUTION_START/END 事件

4. 两级评审（全部子任务返回后）
   第一级 · spec 合规：每个子任务输出是否符合其子任务规格（文件是否存在、接口是否一致）
   第二级 · 代码质量：整体代码质量、风格一致性、边界处理、异常路径
   任一评审不通过 → 重新派发该子任务（最多 2 次）

5. 集成验证
   - 合并所有子任务产物
   - 执行整体验证（编译 / 运行 / 冒烟测试，按 quality-gates.md）
   - 验证失败 → 定位到具体子任务，修复后重验

6. 完成
   - 向用户汇总：子任务清单、每项结果、集成验证结论、交付物列表
```

## 三、并行派发细节

### parallel_delegate.py 说明

- **作用**：用 subprocess 并行 spawn 多个 `zharness -p` 子进程，实现真正的并行子智能体
- **环境对齐**：子进程继承 `ZHARNESS_CODING_AGENT_DIR`（共享认证/模型/已知工作区），与主 agent 对齐
- **超时**：默认每子任务 300 秒（可 --timeout 覆盖）；超时任务标记为 timeout，不阻塞其他任务
- **结果**：每个子任务的结果写入 `--out-dir`（默认 `.code-gen-summary/parallel-results/`），stdout 打印 JSON 汇总
- **审计**：每个子进程是独立 ZHarness 会话，产生独立 EventStore，可单独回放

### 何时用 _delegate_agent（兜底 B）

- 子任务数少（≤2）且无并行收益
- parallel_delegate.py 不可用（脚本缺失/CLI 路径无法解析）
- 子任务需要主上下文中的实时状态

## 四、评审要点（参考 subagent-driven-development）

1. **spec 合规评审优先**：先验证"做了该做的"，再谈"做得好不好"
2. **子任务间一致性**：接口命名、错误处理风格、日志规范跨子任务对齐
3. **不要重复评审**：已通过的子任务不重新评审，除非集成验证暴露问题

## 五、完成标准

- 所有子任务通过两级评审
- 集成验证通过（或已向用户明示失败项与原因）
- 交付物列表清晰（文件路径 + 功能说明）
- 每个子任务的执行链可在各自 EventStore 回放
*（内容由AI生成，仅供参考）*
