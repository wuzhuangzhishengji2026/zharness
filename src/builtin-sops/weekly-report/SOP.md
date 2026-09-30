---
name: weekly-report
description: 周报生成工作流:收集本周事项 → 按模板起草 → 润色定稿,产出可直接发送的周报
version: 1.0.0
author: zharness
tags: [报告, 周报]
args:
  - name: owner
    description: 汇报人姓名(默认不署名)
  - name: period
    description: 统计周期(如 2026-W39 / 本周)
    default: 本周
steps:
  - id: collect
    title: 收集本周事项
    role: 信息收集员
    prompt: |
      收集「{{args.period}}」的工作事项,来源包括:
      1. git 提交记录(若提供了 {{args.owner}} 则按该作者过滤);
      2. 任务板/待办中状态变化的事项;
      3. 当前会话与项目目录中的阶段性产出。
      输出:按项目/主题分组的事项清单,标注完成/进行中/受阻。
  - id: draft
    title: 按模板起草
    role: 周报撰写人
    prompt: |
      基于 {{steps.collect.output}} 起草周报,模板:
      # {{args.period}}周报
      ## 本周完成
      ## 进行中(含进度与预计完成时间)
      ## 受阻与需协调
      ## 下周计划
      要求:每条一句话讲清「做了什么 + 结果/产出」,避免流水账。
  - id: polish
    title: 润色定稿
    role: 编辑
    prompt: |
      润色 {{steps.draft.output}}:
      1. 合并同类项、删掉冗余修饰;
      2. 核对数字与专有名词;
      3. 确保受阻项都写明了需要的支持。
      输出:定稿周报(可直接复制发送)。
---

## 补充说明

- 收集阶段拿不到的来源(git 无提交、任务板为空)如实说明,不要编造。
- 受阻项是周报里最有信息量的部分,宁可少写成绩也要写清阻塞。
