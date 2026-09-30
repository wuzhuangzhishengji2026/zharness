---
name: intf-test-program-generation
version: 1.21.0
description: 根据接口测试大纲、头文件定义以及测试用例 YAML 数据，自动提取编译信息，生成可执行的 C++ 测试程序、Makefile 及批量执行 Shell 脚本。
inputs:
  outline_path: 
    type: string
    required: true
    description: "接口测试大纲文件路径（{work_dir}/test_outline.yaml）。用于提取头文件路径、动态库名、编译链接方式等元数据。"
  yaml_path: 
    type: string
    required: true
    description: "生成的 YAML 测试用例文件路径（{work_dir}/test_cases.yaml）。用于解析 case_id、interface 等字段以展开命令行脚本。"
  header_def_path: 
    type: string
    required: true
    description: "头文件定义文件的绝对路径，用于提取类名、Public 接口列表及函数签名。"
  output_dir: 
    type: string
    required: true
    description: "本地工作目录路径（work_dir）。生成的全部代码、构建文件与脚本必须悉数写入此目录下。"
outputs:
  test_code_path: 
    type: string
    description: "生成的测试程序源文件路径（如 {output_dir}/test_program.c）。"
  makefile_path: 
    type: string
    description: "生成的 Makefile 物理路径。"
  shell_script_path: 
    type: string
    description: "生成的标准版批量执行脚本（{output_dir}/run_tests.sh）与简化版脚本（{output_dir}/run_tests_simple.sh）的所在路径。"
---
## 核心代码与脚本生成原则
1. **测试程序（test_runner）规范**：仅支持命令行控制模式，不接受 YAML 输入。每次测试独立执行创建对象、主测试、销毁对象，并且不执行自动清理。
2. **三进程架构支持**：生成的 `run_tests.sh` 脚本必须严格将每个用例拆分为 PRE_SETUP（带 --skip-cleanup）、MAIN_CMD、POST_CLEANUP（不带 --skip-cleanup，由脚本直接调用）三个独立的 test_runner 进程。
3. **输出要求**：控制台输出必须按照标准格式刷新，包含每个阶段的执行开始时间、完整命令行、退出码及 STDOUT/STDERR，禁止使用管道截断（如 `| head -n`），以防触发系统 SIGPIPE 错误（退出码 141）。

## 模板文件说明

本技能目录内包含三个模板文件，生成时用作构建测试产物的骨架：

| 模板文件 | 用途 |
|----------|------|
| `Makefile.tpl` | Makefile 构建模板。提供编译、链接、清理（make clean / make）的标准规则骨架，包含动态库名、头文件路径等占位符，生成时替换为从 `outline_path` 提取的实际编译信息。 |
| `test_runner.cpp.tpl` | 测试程序（test_runner）框架模板。提供命令行控制模式的主程序骨架（创建对象、主测试、销毁对象），包含接口调用与参数占位符，生成时按测试用例展开每段调用与断言。 |
| `README.tpl` | 测试程序说明文档模板。生成 README 说明文档，包含用例清单、编译运行方式等占位符。 |

### 使用方式

1. 生成时先读取本技能目录下对应的 `.tpl` 模板文件。
2. 识别模板中的占位符（形如 `{{placeholder}}`），用从 `outline_path` / `header_def_path` / `yaml_path` 提取的实际值（仓库名、头文件路径、动态库名、用例列表等）替换。
3. 将替换后的内容分别保存为：`{output_dir}/test_program.c`（源自 `test_runner.cpp.tpl`）、`{output_dir}/Makefile`（源自 `Makefile.tpl`）、`{output_dir}/README.md`（源自 `README.tpl`）。
