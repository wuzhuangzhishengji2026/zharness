---
name: interface-test-outline-generator
version: 1.0.0
description: 从接口规范文档自动生成结构化的接口测试大纲，覆盖功能、边界、异常、性能等维度，并输出到指定的工作目录下。
inputs:
  docs_path: 
    type: string
    required: true
    description: "输入的接口定义文档文件路径（如 OpenAPI、Protobuf 或自定义规范的纯文本格式文件）。"
  output_dir: 
    type: string
    required: true
    description: "本地工作目录路径（work_dir）。技能必须将生成的测试大纲命名为 'test_outline.yaml' 并保存在该目录下。"
outputs:
  test_outline_path:
    type: string
    description: "最终生成的测试大纲文件的绝对物理路径（即 {output_dir}/test_outline.yaml）。"
---
# Universal Interface Test Outline Generator
## Description
通用接口测试大纲生成技能。从接口规范文档中智能识别接口信息（接口名称、描述、请求参数、返回值、错误码等），自动生成结构化的接口测试大纲。

## 执行规范
1. 读取 `docs_path` 的文件内容。
2. 按照大纲模板进行用例维度梳理。
3. 将产物严格命名为 `test_outline.yaml` 并写入 `output_dir` 目录。
4. 【验证 header_path】读取刚刚写入的 `test_outline.yaml`，检查 `header_info.header_path` 是否符合规范。如果文档中无显式声明，必须将其硬编码修正为默认值 `$NUSP_HOME/src/include`。禁止使用源码目录路径。
