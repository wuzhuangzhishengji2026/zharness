---
name: dynamic-task
description: >-
  动态任务工作流：任意任务进来，由规划员按当前工作区现场拆解成带依赖的子任务计划，
  按依赖分波并行执行，每个子任务由独立复核员核实、未通过自动修复一轮，
  最后汇总成任务执行报告（markdown 产物 + 渐进结果）。脚本编排子代理，
  模型对齐 ZCode 的动态工作流（CreateWorkflow）。
version: 1.0.0
author: zharness
tags: [dynamic, orchestration, planning, review]
kind: dynamic
concurrency: 4
args:
  - name: task
    description: 要完成的任务：一句话说清目标与验收标准
    required: true
  - name: constraints
    description: 附加约束与偏好（输出语言、允许改动的范围等），可留空
    required: false
    default: ""
---

# 动态任务工作流（dynamic SOP 模板）

这是 zharness SOP 市场里的**动态工作流**：编排逻辑不是声明式 steps，
而是同目录 `workflow.ts` 里的一份 TypeScript 脚本。它同时是编写动态
SOP 的参考模板 —— 复制本目录、改 frontmatter 与脚本即可。

## 与声明式 SOP（static）的区别

- static：SOP.md 声明 steps，运行时渲染成一条编排提示词交给**当前会话**执行。
- dynamic：脚本由工作流引擎（jiti 转译）执行，`agent().ask()` 派生**独立子代理
  进程**（各自拥有完整工具与独立上下文），脚本掌握循环、分支、扇出与汇合，
  结果按接口契约以 JSON 在子代理之间流转。

## workflow.ts 编写契约（facade）

脚本不 import 任何模块，引擎注入以下名字（均为顶层可用）：

| 名字 | 说明 |
| --- | --- |
| `agent(name?, persona?)` | 创建一个持久子代理（名字在运行内必须唯一；persona 为角色设定字符串或 `{system}`）。同一 agent 多次 `ask` 上下文累积、按 FIFO 串行 |
| `.ask(instructions, { of })` | 派一个任务。`of` 指向脚本内 `interface X {...}` 声明时，子代理必须以 JSON 返回该形状，引擎解析为对象；缺省返回文本。接口里的 `/** */` 注释就是字段说明，请写清楚 |
| `phase(name)` | 标记阶段（进度按阶段归组；名字写给用户看，如「按依赖分波并行执行」） |
| `log(message)` | 一条人读的进度消息 |
| `report(item, tag?)` | 落一条渐进结果：运行失败也会随结局交付，边产出边 report |
| `world.run(cmd, args, {timeoutMs})` | 确定性闸门。退出码是值不是异常；spawn 失败/超时才抛错。命令名必须是字面量 |
| `files.glob(pattern)` / `files.read(path)` | 脚本自身分片/分支用的只读世界访问（工作区相对路径；过量即拒绝） |
| `git.changedFiles(base?)` | 变更文件清单（扇出对象；不在 git 仓库会抛错，用 try/catch 回退到 files.glob） |
| `artifact.file(id, path, opts)` | 发布一个工作区内已有文件为产物卡片 |
| `artifact.markdown(id, md, opts)` | 把 markdown 写到 `out/sop-runs/<runId>/<id>.md` 并发布；`{primary: true}` 标记主交付物 |
| `args` | 启动参数（启动前已按下方声明校验必填、填默认；值需自行 `String(...)` 收窄） |

脚本顶层直接写语句，用 `return` 交付最终结果；推荐返回
`{ conclusion, findings, verified, notCovered }` 报告形状（见脚本内注释）。

## 编排要点（本模板的取法）

- 规划/执行/复核分工：规划员产出带依赖的子任务计划，执行员与复核员
  相互独立（复核员从证据自己核实，不信执行员的自报）。
- 按依赖分波并行：同波子任务的「执行→复核→（修复→复检）」链在一个
  回调里完成，只在波与波之间汇合 —— 不给一对一的阶段之间加 barrier。
- 独立复核 + 修复一轮：`refuted` 的子任务交回执行员修复，再换一个
  新复核员复检；仍不通过则保留结果并标注 `unconfirmed`，不悄悄丢弃。
- 边产出边 `report`；最终报告用 `artifact.markdown` 落成主交付物。

## 运行

```
/sop run dynamic-task task="调研本仓库未提交的改动并写一份中文综述到 out/change-review.md" constraints="全程用中文;除 out/ 外不得改动文件"
```

运行记录在 `<agentDir>/sop-runs/<runId>/`（journal.jsonl 全程可回放）；
`/sop runs` 查看、`/sop stop <runId>` 中止。
