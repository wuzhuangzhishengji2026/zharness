# 质量门禁

定义执行者（流水线路径的调度者 / checkpoint 路径的当前上下文）在每个阶段 Agent 返回后执行的确定性校验规则。所有校验由执行者使用 _find/_read 等工具执行，不依赖 Agent 的自我判断。checkpoint 路径（简单任务）同样适用：每个关键动作后按对应门禁做确定性验证。

---

## 一、门禁表

| ID | 门禁点 | 触发时机 | 校验逻辑 | 失败处理 |
|----|--------|---------|---------|---------|
| G0 | 会话初始化 | 阶段0 用户响应后 | 检查 stage 在 1-7 范围内或用户确认 restart | 提示用户重新选择 |
| G0.5 | 配置文件存在性 | 阶段1 写 ctx 后 | **_find/Test-Path** 检查 `context.config.*` 与 `context.script.*` 指向的文件均存在 | 向用户报告缺失文件，列出正确 skillRoot，中止进入 stage1 |
| G1 | 需求完整性 | 阶段1 Agent 返回后 | 解析 result，检查 `data.parsed_intent.objective` 不为空 | 展示 issue，通知用户 |
| G2 | 设计方案完整性 | 阶段2 Agent 返回后 | 解析 result，检查 `data.design_doc_path` 不为空且 `data.subtask_list` 是数组格式 | 标记 PARTIAL，向用户展示 |
| G3 | 任务覆盖度 | 阶段2 Agent 返回后 | 解析 result，检查 `data.subtask_list` 长度 ≥ 1 | 重新派发 Agent |
| G4 | 代码文件存在性 | 阶段3 Agent 返回后 | **_find 检查** `file_list` 中所有文件路径是否存在 | 重新派发 Agent，附带缺失文件列表 |
| G4.5 | 代码文件非空 | G4 通过后 | **_read 抽样**检查文件内容不为空（读取前 3 行） | 重新派发 Agent |
| G5 | 安全审计结果 | 阶段5 Agent 返回后 | ① 检查 `data.audit_result.coverage_report.checked_count / total_vuln_types >= 80%`（审计覆盖率达标）；② 检查 `data.audit_result.has_confirmed_findings` 及 `review_status=confirmed` 的漏洞数量 | 覆盖率不足 → 重新派发 stage5；存在漏洞 → 向用户展示所有已确认漏洞列表，等待用户决策（忽略继续 / 返回阶段3修复后重审） |
| G6 | 编译结果有效 | 阶段4 Agent 返回后 | 解析 result，检查 `data.compile_result.success` 是布尔值 | 展示错误详情给用户 |
| G7 | 测试结果有效 | 阶段6 Agent 返回后 | 解析 result，检查 `data.test_result.success` 是布尔值 | 展示失败详情给用户 |
| G8 | 汇总文件合规性 | 阶段7 Agent 返回后 | 从 `result.data.summary_path` 提取文件路径，**_find 精确检查**该路径文件是否存在 | 重新派发 stage7 |

---

## 二、校验工具

| 校验类型 | 使用的工具 | 说明 |
|---------|-----------|------|
| JSON 字段存在性 | 字符串解析 | 检查 result JSON 中必要字段非空 |
| 文件存在性 | **_find** | 通配符匹配验证文件已创建 |
| 文件存在性（精确） | **Test-Path**（Win）/ `test -f`（Linux） | 精确验证路径存在（G0.5 使用） |
| 文件非空 | **_read**（limit: 3） | 读取前 3 行验证文件有内容 |
| 数值/布尔检查 | 类型判断 | 验证 expected type |

---

## 三、失败处理策略

| 场景 | 处理方式 |
|------|---------|
| G0 失败（stage 无效或用户未确认） | 重新询问用户选择"继续"或"重新开始" |
| G0.5 失败（配置文件缺失） | 向用户报告缺失文件清单，列出正确 skillRoot，**中止进入 stage1**，不重试 |
| G1 失败 | 向用户展示"需求理解不完整"，提供 issues 详情 |
| G2 失败 | 向用户展示知识清单异常，用户确认后继续或终止 |
| G3 失败（task_list 为空） | 重新派发阶段2 Agent，增加"任务数为0，请检查分解逻辑"的提示 |
| G4/G4.5 失败（文件缺失） | 重新派发阶段3 Agent，prompt 中注入"以下文件缺失：xxx" |
| G5 失败（审计覆盖率不足） | 重新派发阶段5 Agent，prompt 中注入"上一轮只覆盖了 X/Y 种漏洞类型，请覆盖全部类型"。最多重试 3 次，仍不达标则向用户报告 |
| G5 失败（存在漏洞） | 向用户展示已确认漏洞列表（含文件路径、行号、描述、修复建议），等待用户选择：① 忽略继续（标记为已知风险）② 返回阶段3修复后重审。用户选择修复时，重新派发阶段3 Agent 修复漏洞 → 修复完成后重新调度阶段4编译 → 编译成功后重新调度阶段5审计 |
| G6 失败（编译失败） | 直接进入阶段7，不尝试重新派发 |
| G7 失败（测试失败） | 展示失败详情，进入阶段7 |
| G8 失败 | 重新派发 stage7（最多 3 次，重试见下方说明） |

### 重新派发说明

- **G3/G4 重新派发**时，更新 `meta.retry_count`。如果 `retry_count >= max_retry`（默认 3 次），不再重新派发，改为向用户展示问题
- **G8 重新派发**时，更新 `meta.retry_count` 和 `meta.project_root`。如果 `retry_count >= max_retry`（默认 3 次），改为提示用户手动检查 `.code-gen-summary/` 目录
- 重新派发时不需要清空或修改 `.code-gen-summary/code-gen-ctx.json`——文件中的状态不变
*（内容由AI生成，仅供参考）*
