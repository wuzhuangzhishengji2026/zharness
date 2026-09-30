---
name: intf-test-case-generation-from-outline
version: 1.4.0
description: 读取本地测试大纲文件，并通过分析 C/C++ 模块源码进行边界/异常返回值的对齐修正，最终生成结构化的 YAML 测试用例数据。
inputs:
  outline_path: 
    type: string
    required: true
    description: "前置阶段生成的测试大纲物理文件路径（例如：{work_dir}/test_outline.yaml）。"
  header_files:
    type: string
    required: true
    description: "待测模块的头文件（.h）路径或通配符规则，用于用例生成时的签名比对。"
  source_files:
    type: string
    required: true
    description: "待测模块的 C/C++ 源码文件路径。技能必须使用本地工具分析这些源码，以确认接口在空值/边界条件下的实际真实返回值（如 DelKey、DelSection、GetKeys 等的实际行为）。"
  output_dir: 
    type: string
    required: true
    description: "本地工作目录路径（work_dir）。技能必须将生成的测试用例命名为 'test_cases.yaml' 并保存在该目录下。"
outputs:
  yaml_path: 
    type: string
    description: "最终落盘的测试用例文件路径（即 {output_dir}/test_cases.yaml）。"
---
# Test Case Generation from Outline
## Description
解析大纲中的接口定义、测试点表格，结合对源码中实际逻辑的静态分析，生成具备真实预期返回值（expected_ret）的测试用例。

## 源码分析修正铁律
在将大纲细化为用例时，大模型必须利用 `source_files` 路径进行代码审查。如果源码行为与大纲预期不符（例如源码缺少空值校验而实际返回 1 成功），必须将 `expected_ret` 修正为源码的实际行为，确保用例的确定性。
