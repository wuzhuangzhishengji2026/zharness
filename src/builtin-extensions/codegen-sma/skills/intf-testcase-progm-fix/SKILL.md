---
name: intf-testcase-progm-fix
version: 1.0.0
description: 根据远程编译或执行返回的失败日志，对比本地模块源码，自动分析是测试用例预期值不匹配、CSV/YAML解析错误还是测试脚本缺陷，并就地重写工作目录下的测试文件。
inputs:
  work_dir: 
    type: string
    required: true
    description: "当前智能体的工作目录。技能需要去读取其中的 `{work_dir}/logs/`（包含 upload.log、compiler.log、run_tests.log）以及被测的三份原始产物。"
  source_files: 
    type: string
    required: true
    description: "模块的原始 C/C++ 源码文件路径，用于对比实际的返回值逻辑（Bug 适配模式）。"
outputs:
  status: 
    type: string
    description: "修复结果状态：fixed（已修复）/ unrepairable（无法修复）。"
---
# 接口测试用例与程序自动修正
## Description
针对执行中出现的 `Result: [FAIL]` 的用例，通过查看日志的 Return Code 与期望值差异，以及查看源码错误关键字来进行闭环修正。

## 修复流转原则
1. **源码行为决定论**：如果通过日志发现实际返回值与 expected_ret 不一致，且确认是源码自身逻辑（如缺少空值校验 bug 导致返回 1），测试用例必须无条件适配源码行为。修改 `{work_dir}/test_cases.yaml` 中的预期值，重新生成并覆盖物理文件。
2. **框架问题排查**：如果是 CSV 解析错位或脚本路径硬编码，直接重写对应的测试程序逻辑或 `run_tests.sh`。
3. 修复完毕后返回 `fixed` 状态，触发主工作流重新调用命令上传编译。
