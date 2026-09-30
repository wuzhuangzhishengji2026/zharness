---
name: deep-research
description: 深度调研工作流:多源检索 → 交叉验证 → 结构化成稿,产出带引用的调研报告
version: 1.0.0
author: zharness
tags: [调研, 报告]
args:
  - name: topic
    description: 调研主题
    required: true
  - name: depth
    description: 调研深度(quick=快速摸底 / standard=标准 / deep=深挖)
    default: standard
steps:
  - id: search
    title: 多源检索
    role: 检索专员
    prompt: |
      围绕「{{args.topic}}」开展多源检索(深度:{{args.depth}}):
      1. 拆解主题为 3-5 个子问题;
      2. 逐个子问题检索可用的资料来源(本地文件、代码库、可用的检索工具);
      3. 为每条关键信息记录来源,无法溯源的标注[未验证]。
      输出:子问题清单 + 每个子问题下的要点与来源。
  - id: verify
    title: 交叉验证
    role: 事实核查员
    prompt: |
      对检索结果 {{steps.search.output}} 做交叉验证:
      1. 找出相互矛盾或仅单一来源支撑的关键结论;
      2. 对矛盾点补充检索或标注置信度(高/中/低);
      3. 剔除与主题无关的噪声条目。
      输出:经过验证的结论清单,每条附置信度与来源。
  - id: report
    title: 结构化成稿
    role: 报告撰写人
    prompt: |
      基于 {{steps.verify.output}} 撰写调研报告,结构:
      # {{args.topic}} 调研报告
      ## 摘要(3-5 句)
      ## 核心发现(按重要性排序,每条注明置信度)
      ## 不同观点与争议
      ## 结论与建议
      ## 参考资料
      要求:结论先行、每条发现可溯源;篇幅与深度 {{args.depth}} 相称。
---

## 补充说明

- 检索阶段优先使用当前环境实际可用的检索途径,不要臆造来源。
- 引用一律落到「参考资料」一节统一编号,正文用 [n] 指回。
