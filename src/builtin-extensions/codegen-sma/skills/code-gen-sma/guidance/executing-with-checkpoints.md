# Checkpoint 执行（简单任务）

> 参考 superpowers `executing-plans`：加载计划 → 批判性审查 → 逐个执行 → 每任务标记完成 → 阻塞时停下问人。
> 本路径用于**简单任务**（判定标准见 `workflow-router.md`，0~1 分）。核心思想：小步快跑 + 每步确认，避免一次性大改动后无法回退。

## 一、流程

```
1. 理解任务
   - 读取用户需求与相关文件（_read）
   - 确认目标产物（文件路径、功能行为）

2. 批判性审查（动手前）
   - 计划是否可执行？有无明显歧义？
   - 是否真正满足用户需求？有无遗漏边界？
   - 有疑问 → 在此刻向用户澄清（这是第一个 checkpoint）

3. 列出执行计划（含 checkpoint 点）
   向用户展示计划，格式：
   [执行计划]
   1. 创建/修改 xxx.py：实现 xxx 功能
   ⛳ checkpoint 1：功能实现完成，展示结果
   2. 补充 xxx_test.py：冒烟验证
   ⛳ checkpoint 2：测试通过，准备收尾
   [计划确认] 请确认或调整

4. 逐任务执行
   - 一次只做一件事
   - 每件事完成后做确定性验证（_find 检查文件存在、_read 抽样内容非空）
   - 严格按 quality-gates.md 的门禁校验

5. 到达 checkpoint → 停下，向用户展示结果，等待确认
   - 展示内容：改了什么文件、验证结果、下一步计划
   - 用户确认 → 继续下一个任务
   - 用户提出修改 → 先改再继续

6. 完成
   - 最终验证（按 quality-gates.md 汇总）
   - 向用户汇总交付物
```

## 二、Checkpoint 设计原则

1. **粒度**：每个"用户可见的结果"后设置一个 checkpoint（实现完成、测试通过、文档完成）
2. **简单任务至少 1 个 checkpoint**：实现完成后、收尾前必须停下确认
3. **checkpoint 不是形式**：必须真正等待用户回复，禁止自问自答后继续
4. **阻塞即 checkpoint**：遇到歧义、缺依赖、权限问题，停下问用户，绝不猜测

## 三、进度跟踪

ZHarness 无内置 TodoWrite，使用文件记录进度（可选，简单任务也可仅在对话中维护）：

```
_write ".code-gen-summary/code-gen-progress.json" '{
  "mode": "checkpoint",
  "current_task": "创建 xxx.py",
  "completed": [],
  "pending": ["创建 xxx.py", "补充测试", "收尾"],
  "checkpoints": ["实现完成", "测试通过"],
  "updated_at": "<时间戳>"
}'
```

## 四、与审计的关系

本路径的所有文件操作（_write/_edit）、验证（_find/_read）自动进入 ZHarness EventStore，
可通过事件日志回放完整执行链（见 `rules/audit-trail.md`）。无需手动记录。

## 五、完成标准

- 所有计划任务完成且通过确定性校验
- 所有 checkpoint 均获得用户确认
- 交付物清晰列出（文件路径 + 功能说明）
*（内容由AI生成，仅供参考）*
