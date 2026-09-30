---
name: code-review
description: 代码评审工作流:梳理改动 → 逐项审查(正确性/安全/可维护性并行) → 汇总评审意见
version: 1.0.0
author: zharness
tags: [评审, 质量]
args:
  - name: scope
    description: 评审范围(git ref 如 main..HEAD,或文件/目录路径)
    default: 未提交与最近的改动
steps:
  - id: changes
    title: 梳理改动
    role: 变更分析师
    prompt: |
      梳理评审范围「{{args.scope}}」内的全部改动:
      1. 列出涉及的文件与每处改动的意图;
      2. 标注改动类型(新功能/修复/重构/配置/依赖);
      3. 指出需要重点评审的高风险文件。
      输出:改动清单 + 高风险点。
  - id: correctness
    title: 正确性审查
    parallel: true
    role: 正确性审查员
    prompt: |
      针对 {{steps.changes.output}} 中的改动做正确性审查:
      边界条件、错误处理、并发/竞态、资源泄漏、与现有逻辑的兼容性。
      输出:问题列表(文件:行号 + 严重级别 + 修复建议),无问题则明确说明检查过的方面。
  - id: security
    title: 安全审查
    parallel: true
    role: 安全审查员
    prompt: |
      针对 {{steps.changes.output}} 中的改动做安全审查:
      注入(命令/SQL/路径穿越)、敏感信息硬编码、越权访问、不安全的依赖。
      输出:问题列表(位置 + 严重级别 + 修复建议),无问题则明确说明检查过的方面。
  - id: maintainability
    title: 可维护性审查
    parallel: true
    role: 可维护性审查员
    prompt: |
      针对 {{steps.changes.output}} 中的改动做可维护性审查:
      命名与可读性、重复代码、缺失测试、注释是否只在必要处、是否符合项目既有风格。
      输出:建议列表(位置 + 优先级),无建议则明确说明。
  - id: summary
    title: 汇总评审意见
    role: 评审组长
    prompt: |
      汇总三路审查结果 —— 正确性 {{steps.correctness.output}}、
      安全 {{steps.security.output}}、可维护性 {{steps.maintainability.output}} ——
      输出评审报告:
      # 评审结论(通过 / 有条件通过 / 需修改)
      ## 必须修复(阻断合并)
      ## 建议修复(不阻断)
      ## 亮点
      每条意见引用文件:行号;结论给出明确判断依据。
---

## 补充说明

- 三路审查相互独立,可交给子代理并行执行;无子代理时按顺序逐项完成。
- 「必须修复」仅用于会导致错误、安全漏洞或明显行为回归的问题。
