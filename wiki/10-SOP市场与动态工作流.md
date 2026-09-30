# SOP 市场与动态工作流

> 对应代码:`src/core/sop.ts`(解析)、`src/core/workflow/`(引擎)、
> `src/core/sop-install.ts`(安装)、`src/builtin-extensions/sop-market/`(命令)、
> `packages/rpc/rpc-mode.ts`(市场 RPC)。

SOP(标准操作流程)是 zharness 里可分发的工作流模板,像技能一样通过市场
(GitHub 仓库或内置模板)安装到 `<agentDir>/sops/<slug>/`。它有两种形态,
共用同一市场、安装与卸载管线:

| 形态 | 载体 | 执行方式 |
| --- | --- | --- |
| **static(声明式)** | SOP.md frontmatter 的 `steps` | 渲染成编排提示词,交给**当前会话**的模型按步骤推进 |
| **dynamic(动态工作流)** | 同目录 `workflow.ts` 脚本 | **工作流引擎**执行脚本,`agent().ask()` 派生独立子代理进程,脚本掌握循环/分支/扇出 |

dynamic 形态对齐 ZCode 的 CreateWorkflow 模型:一份 TypeScript 脚本以
facade 编排多个模型会话,结果按接口契约(JSON)在子代理之间流转。

## 目录结构与 frontmatter

```
<agentDir>/sops/<slug>/
├── SOP.md          # 元信息 + 正文(补充说明/编写契约)
└── workflow.ts     # dynamic 专用:编排脚本(引擎经 jiti 转译执行)
```

static 的 frontmatter:`name/description/version/author/tags/args/steps`。

dynamic 的 frontmatter 在此基础上:

```yaml
kind: dynamic        # 声明动态(或省略 kind 但目录里有 workflow.ts,同样推断为 dynamic)
concurrency: 4       # 可选:子代理并发上限(默认 4)
args:                # 启动参数声明;启动前校验必填、填默认
  - name: task
    required: true
  - name: constraints
    default: ""
```

`steps` 在 dynamic 下被忽略(可为空);`kind: static` 却带脚本、`kind: dynamic`
却没有脚本都是解析期错误。参考模板:`src/builtin-sops/dynamic-task/`。

## workflow.ts 编写契约(facade)

脚本**不 import 任何模块**,引擎注入以下顶层名字:

```ts
// 子代理:持久上下文的模型会话(独立进程,拥有完整工具)
const plan = await agent("规划员", "角色设定一句话").ask<Plan>("拆解这个任务", { of: "Plan" });
//   - name 在一次运行内必须唯一(重名 → 整个运行失败);匿名 agent() 也合法
//   - persona 冻结在创建时;同一 agent 多次 ask 上下文累积、按 FIFO 串行
//   - { of: "Plan" } 指向脚本内 `interface Plan {...}` 声明:子代理必须以
//     ```json 围栏块返回该形状,引擎解析为对象;缺省 of 时返回纯文本
//   - 并发受引擎信号量约束(默认 4),并行靠「不立刻 await」实现

phase("按依赖分波并行执行子任务");   // 阶段标记:进度与日志按阶段归组
log("第 1/2 波:分析、检索");        // 一条人读的进度消息
report(reviewed, "progress");       // 渐进结果:运行失败也随结局交付,边产出边 report

const check = await world.run("npm", ["test"], { timeoutMs: 600_000 });
//   确定性闸门:命令名必须是字面量;退出码是值(exitCode)不是异常,
//   spawn 失败/超时才 reject。分支逻辑读 exitCode,下一轮反馈带 stderr。

const files = await files.glob("src/**/*.ts");   // 工作区相对路径(排序,超量拒绝)
const src = await files.read("src/index.ts");    // 只读,512KB 上限,不得出工作区
const changed = await git.changedFiles("HEAD");  // 不在 git 仓库时 reject,可 try/catch 回退 glob

await artifact.file("profile", "out/profile.html", { title: "性能剖析" });
await artifact.markdown("report", reportMd, { title: "执行报告", primary: true });
//   产物卡片:markdown 写到 out/sop-runs/<runId>/<id>.md;primary 标记主交付物

const task = String(args.task ?? "").trim();     // 启动参数(已按声明校验/填默认)
return { conclusion, findings, verified, notCovered };  // 顶层 return 交付结果
```

### 与 ZCode CreateWorkflow 的差异(zharness v1)

- **无编译期类型检查**:脚本经 jiti 转译即执行。typed ask 不靠 `ask<T>`
  泛型(运行时不可见),而是 `ask(prompt, { of: "接口名" })`;引擎把脚本内
  对应 `interface` 声明原文(含 JSDoc 字段说明)组装进子代理的 JSON 契约。
- **无 amend/resume**:运行是一次性的;但每次运行落一份完整 journal
  (`<agentDir>/sop-runs/<runId>/`:meta.json + journal.jsonl + script.ts),
  失败的运行保留已完成的 report 与产物。
- **无子代理升级(escalation)通道**:子代理被要求「做不到就如实返回失败」,
  由脚本分支处理。
- **无 run 前确认窗**:`world.run` 命令集不做事前批准 —— SOP 来自用户主动
  安装,信任模型与扩展一致;命令全部记录在 journal 中可审计。

### 编排要点(与 ZCode 同源)

- 结果喂给后续步骤、带停止条件的循环、按类型分支 —— 是动态工作流的形状。
- 每个独立单元一个新 agent(独立上下文);需要跨项校准一致时才共享一个。
- 并行靠 `Promise.all` 前不 await;一对一的阶段链在各自回调里完成,只在
  真正需要全员到齐处汇合。
- 规划/草稿给独立复核(新上下文读现场证据),发现的问题标注
  verified/unconfirmed,不悄悄丢弃。
- 循环带轮数上限;可调常数(阈值、轮数)放控制流里,不要内插进 ask 文本。

## 运行与运维

```
/sop                          # 列出已安装(static/dynamic 分标)
/sop run <slug> [k=v …]       # static:渲染提示词交当前会话;dynamic:后台启动运行
/sop runs                     # 动态工作流运行记录(进行中/历史)
/sop stop <runId前缀>          # 中止进行中的运行
/sop show <slug>              # 查看定义(步骤表或脚本概要)
```

dynamic 的运行:TUI 下后台推进,状态行实时显示当前阶段/子代理,结束时
结论、渐进结果与产物以会话消息交付(不触发新回合);无 UI(print/RPC)
下同步等待并打印。子代理进程经 RpcClient 派生(`--mode rpc`,与
`delegate_agent` 同机制),共享 agentDir 的认证与模型配置。

GUI 的「SOP 市场」页(`sop_list` / `sop_market` / `sop_install` /
`sop_uninstall` RPC)同时展示两种形态:dynamic 条目带「动态工作流」徽标,
运行按钮同样走 `/sop run`。

## 测试

- `test/sop.test.ts`:两种形态的解析、动态判推断、sidecar 读取。
- `test/sop-install.test.ts`:安装拷贝(含 workflow.ts)、内置模板清单。
- `test/sop-workflow.test.ts`:引擎(stub 执行器,不派生真实进程)——
  typed ask 契约、phase/report/artifact、world.run 退出码语义、重名失败、
  参数校验、中止语义,以及内置 dynamic-task 脚本的端到端冒烟。
