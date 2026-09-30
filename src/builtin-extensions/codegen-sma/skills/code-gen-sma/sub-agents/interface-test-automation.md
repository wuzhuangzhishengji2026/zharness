---
name: interface-test-automation
description: 接口测试全流程自动化编排工作流。输入接口定义文档、头文件、源码，依次生成测试大纲、测试用例、测试程序与脚本，然后上传编译执行。若执行失败，自动调用修复技能并重试，最多尝试5次。
---

# 接口测试自动化编排工作流

版本: 1.1.0（ZHarness 平台适配版：由流水线阶段6 Agent 加载后**内联执行**，不再作为独立 subagent 注册）

## 前置条件

1. 四个子技能与 code-gen-sma **同级安装**（`<skill_root>/../` 下），执行时用 **_read** 加载其 SKILL.md：
   - `interface-test-outline-generator`
   - `intf-test-case-generation-from-outline`
   - `intf-test-program-generation`
   - `intf-testcase-progm-fix`
2. 上传同步脚本位于 `<skill_root>/scripts/sync.ps1`，配置文件为 `<skill_root>/scripts/sync_config.yaml`。

> `<skill_root>` 指 code-gen-sma 技能目录的绝对路径，由调用方（阶段6）通过 ctx.json 的 config 路径解析结果提供；若未提供，用 `_find` 从技能根目录定位。

## 路径格式要求

执行时自动将 Windows 反斜杠路径转换为正斜杠路径，支持两种格式：
- Windows格式：`E:\AIassiant\Workspace\src\para_man`
- Unix格式：`E:/AIassiant/Workspace/src/para_man`

均会自动转换为 `E:/AIassiant/Workspace/src/para_man` 后使用。

## 工作流程

按顺序执行：
1. 测试大纲生成
2. 测试用例生成
3. 测试程序生成
4. 上传编译执行
5. 失败时自动修复并重试（最多5次）

## 输入参数

用户会提供以下内容：
- `api_doc`: 接口定义文档（如OpenAPI、Protobuf、自定义格式等），必需
- `header_files`: 一个或多个头文件（.h），必需
- `source_files`: 一个或多个源文件（.c/.cpp等），必需
- `work_dir`: 工作目录路径（可选，所有中间文件和日志将保存在此目录下）

### work_dir默认规则

- 如果用户**不提供** `work_dir`，则自动计算默认路径
- 计算公式：`{项目根目录}/{源码路径最后一层目录名}_test_output`

**项目根目录定义**：
- 项目根目录 = 智能体运行时的 Working directory（工作目录）
- 例如：当前 Working directory = `E:\AIassiant\Workspace`，则项目根目录 = `E:\AIassiant\Workspace`
- 这是智能体执行命令的默认目录，所有相对路径都基于此目录

**完整示例**：
  - Working directory = E:\AIassiant\Workspace （项目根目录）
  - source_files = E:\AIassiant\Workspace\src\para_man
  - 目录最后一层 = para_man
  - 默认 work_dir = E:\AIassiant\Workspace\para_man_test_output

## 执行流程（严格按顺序）

### 阶段0：初始化工作目录

1. 如果用户未提供 `work_dir`，自动推导默认路径：
   - 获取智能体运行时的 Working directory 作为项目根目录（如 E:\AIassiant\Workspace）
   - 从 `source_files` 提取源码路径最后一层目录名（如 para_man）
   - 拼接为默认路径：`{Working directory}/{目录名}_test_output`
2. 检查 `work_dir` 是否存在，若不存在则创建该目录。
3. 后续所有生成的文件均保存在此目录下。

### 阶段1：生成测试大纲

1. **_read** `<skill_root>/../interface-test-outline-generator/SKILL.md` 并严格按其流程执行，输入 `api_doc` 文件。
2. 将输出的测试大纲内容保存为 `{work_dir}/test_outline.yaml`（或技能指定的格式）。
3. **验证 header_path 正确性**：
   - 读取生成的 test_outline.yaml 文件内容
   - 检查 header_info.header_path 是否符合规范：
     - ✅ 如果文档有显式声明，使用声明的值
     - ✅ 如果文档无声明，必须使用默认值 `$NUSP_HOME/src/include`
     - ❌ 禁止使用源码目录路径（如 `E:\AIassiant\Workspace\src\para_man`）
   - 若不符合规范，修正 header_path 后重新保存文件。

### 阶段2：生成测试用例

1. **_read** `<skill_root>/../intf-test-case-generation-from-outline/SKILL.md` 并严格按其流程执行，传入以下参数：
   - 测试大纲文件路径：`{work_dir}/test_outline.yaml`
   - 头文件列表：`header_files`
   - 源文件列表：`source_files`
2. 将输出的测试用例内容保存为 `{work_dir}/test_cases.yaml`（或指定格式）。

### 阶段3：生成测试程序与脚本

1. **_read** `<skill_root>/../intf-test-program-generation/SKILL.md` 并严格按其流程执行，传入以下参数（参数名与技能 frontmatter 契约严格一致）：
   - `outline_path`：测试大纲文件路径 `{work_dir}/test_outline.yaml`
   - `header_def_path`：头文件定义路径（即用户提供的 `header_files`）
   - `yaml_path`：测试用例文件路径 `{work_dir}/test_cases.yaml`
   - `output_dir`：工作目录 `{work_dir}`（生成的全部产物写入此目录）
2. 将输出的两个部分分别保存：
   - 测试程序：`{work_dir}/test_program.c`（或对应语言源文件）
   - 测试脚本：`{work_dir}/run_test.sh`（或对应脚本文件）

### 阶段4：上传编译执行与自动修复循环

**初始化**：设置重试计数器 `retry_count = 0`，最大重试次数 `MAX_RETRY = 5`。

**日志目录**：`{work_dir}/logs`

**日志文件列表**：
- `upload.log` - 上传阶段日志（清理远程目录、创建远程目录、上传源文件、验证文件、设置权限）
- `compiler.log` - 编译阶段日志（make clean、make 编译）
- `run_tests.log` - 测试执行日志（run_tests.sh 运行结果）

**sync 脚本正确调用方式**：

⚠️ **重要**：sync 不是系统命令，而是技能自带的 PowerShell 脚本（`<skill_root>/scripts/sync.ps1`）。**禁止硬编码绝对路径**，从 `<skill_root>` 动态拼接。

**正确的调用方式**（动态拼接，禁止写死）：
```powershell
# 方式1：使用相对路径（推荐，当前目录为项目根且 skill_root 相对可达时）
powershell -ExecutionPolicy Bypass -File "<skill_root>/scripts/sync.ps1" -LocalPath "{work_dir}"

# 方式2：使用Join-Path动态构建
$SyncScript = Join-Path $env:ZHARNESS_CODEGEN_SKILL_ROOT "scripts\sync.ps1"
powershell -ExecutionPolicy Bypass -File $SyncScript -LocalPath "{work_dir}"
```

**参数说明**：
| 参数 | 说明 |
|------|------|
| `-LocalPath` | 本地工作目录（自动推导） |
| `-RemotePath` | 远程目录（可选，从配置文件读取） |
| `-RemoteHost` | SSH主机（可选，从配置文件读取） |

**配置文件位置**：`<skill_root>/scripts/sync_config.yaml`

**循环体**：
1. 使用 PowerShell 调用 sync 脚本（调用方式同上方"正确的调用方式"）。
2. 命令执行完成后，分析 logs 目录下的日志：
   - 读取 `upload.log` 判断上传是否成功（SCP exit code = 0）
   - 读取 `compiler.log` 判断编译是否成功（无 "error:"、"Build failed" 等错误关键词）
   - 读取 `run_tests.log` 判断测试是否通过

3. **成功标志**：
   - upload.log 中包含 "Status: Completed" 且 SCP exit code = 0
   - compiler.log 中不包含 "error:"、"Build failed"、"Exit code: [非0]" 等错误
   - run_tests.log 中所有测试用例为 PASSED 或返回码为 0

   若全部成功，则跳出循环，流程结束。

4. 若失败：
   - **_read** `<skill_root>/../intf-testcase-progm-fix/SKILL.md` 并严格按其流程执行修复，传入以下参数：
     - logs目录：`{work_dir}/logs`（包含 upload.log, compiler.log, run_tests.log）
     - 源文件列表：`source_files`
     - 测试用例文件：`{work_dir}/test_cases.yaml`
     - 测试程序文件：`{work_dir}/test_program.c`
     - 测试脚本文件：`{work_dir}/run_test.sh`
   - 该技能会返回修复后的三份文件内容（测试用例、测试程序、测试脚本）。
   - 用返回的内容覆盖工作目录中的对应文件。
   - `retry_count += 1`
   - 若 `retry_count < MAX_RETRY`，返回循环顶部继续执行。
   - 若 `retry_count >= MAX_RETRY`，终止循环，记录最终失败信息。

### 阶段5：输出结果

- 若最终执行成功，返回成功状态，并输出：
  - `final_logs_dir`: `{work_dir}/logs`（包含 upload.log, compiler.log, run_tests.log）
  - `final_artifacts_dir`: `work_dir`
- 若达到最大重试次数仍失败，返回失败状态，并输出：
  - `final_logs_dir`: `{work_dir}/logs`
  - `final_artifacts_dir`: `work_dir`
  - 以及最后一次失败的原因简述。

## 重要：执行环境说明

### 阶段4不在Windows本地尝试编译

- 本流程的执行环境可能是Windows (win32)
- 接口库（如libparamanage.so）是Linux二进制格式
- Windows本地可能没有C++编译器(g++, gcc, MSVC)
- Windows本地无法编译链接Linux .so动态库

### 正确的阶段4执行流程

1. **直接使用sync脚本上传**：不检查本地编译器，不在Windows尝试编译
2. sync 脚本会将文件传输到Linux编译服务器进行编译和测试
3. 获取Linux环境的执行日志进行分析

### 禁止在本地执行的尝试

- ❌ 禁止执行 `g++ --version` 检查编译器
- ❌ 禁止尝试用cl.exe或MinGW编译
- ❌ 禁止在Windows本地运行测试程序
- ✅ 应直接进入sync脚本上传流程

## 测试结果判断逻辑

### 单个测试用例结果判断

- PASSED: 输出包含 "Result: [PASS]"
- FAILED: 输出包含 "Result: [FAIL]"
- NOT_EXECUTED: 无 "Result: [PASS]" 且无 "Result: [FAIL]" (原因: 环境配置缺失/程序编译失败/接口异常)

### 批量测试统计变量

- PASSED_COUNT: 通过的测试用例数
- FAILED_COUNT: 失败的测试用例数
- NOT_EXECUTED_COUNT: 未执行的测试用例数 (无PASS/FAIL输出)
- pass_rate: PASSED_COUNT / 总用例数 × 100%

### 日志文件分析

- upload.log: SCP exit code = 0
- compiler.log: Make exit code = 0，无 "error:"
- run_tests.log: 统计PASS/FAIL/未执行用例数

### 整体结果判断

- 完全通过: PASSED_COUNT = 总数 且 NOT_EXECUTED_COUNT = 0
- 部分通过: PASSED_COUNT > 0 且 (FAILED_COUNT > 0 或 NOT_EXECUTED_COUNT > 0)
- 完全失败: PASSED_COUNT = 0 且 FAILED_COUNT > 0
- 未执行: NOT_EXECUTED_COUNT = 总数

## 产物位置

所有中间及最终产物保存在智能体工作目录（由 `work_dir` 指定）下，包括：
- `test_outline.yaml`
- `test_cases.yaml`
- `test_program.c`
- `run_test.sh`
- `execution.log`

## 注意事项

- 每个子技能执行前，请确保所需文件已正确写入工作目录。
- 若任何子技能返回错误（非业务逻辑错误，如网络超时），应立即终止流程并报告异常，不纳入重试计数。
- 所有中间文件保留在工作目录中，便于问题追溯。
- 如果 sync 脚本需要额外的环境配置（如目标服务器地址、认证信息），请通过环境变量或配置文件提供。

## 执行示例

输入：请对以下接口进行自动化测试。
      api_doc=./接口规范文档.txt, source=./src/para_man

执行过程：
        检测到source_files=./src/para_man，自动推导工作目录 ./para_man_test_output
        (项目根目录 ./ + para_man + _test_output)
        工作目录 ./para_man_test_output 已创建。开始生成测试大纲...
        (_read interface-test-outline-generator/SKILL.md 并执行)
        测试大纲已生成正在生成测试用例...
        (_read intf-test-case-generation-from-outline/SKILL.md 并执行)
        测试用例已生成正在生成测试程序与脚本...
        (_read intf-test-program-generation/SKILL.md 并执行)
        已生成测试程序与脚本，开始上传编译执行...
        (调用 sync.ps1 - PowerShell脚本方式)
        powershell -ExecutionPolicy Bypass -File "<skill_root>/scripts/sync.ps1" -LocalPath "./para_man_test_output"
        执行失败，检测到编译错误正在调用修复技能（第1次）...
        (_read intf-testcase-progm-fix/SKILL.md 并执行)
        修复完成，重新上传执行...
        (再次调用 sync.ps1)
        执行成功！测试通过。
        日志文件：./para_man_test_output/logs/run_tests.log
        产物目录：./para_man_test_output
