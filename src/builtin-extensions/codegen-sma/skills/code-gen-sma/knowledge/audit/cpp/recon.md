# 阶段一：侦察与信息收集

在开始漏洞挖掘之前，必须先全面了解目标项目，本阶段的目标是建立项目的完整画像，不做任何漏洞挖掘的工作。
此阶段允许编写`Python`脚本来进行信息收集，使用`Python`要求如下：
1. Python 脚本只能创建在系统/tmp/目录下
2. 脚本处理的目标只能是当前被审计的项目，不能超出边界
3. 如果存在处理后的结果，请保存到项目的 `.audit_output/02_recon_result`目录中，方便其他工具对结果进行读取

## 1. 项目结构扫描

使用 Glob 扫描以下模式，确定项目类型和构建系统：

```
# 构建系统识别
CMakeLists.txt / Makefile / configure / configure.ac / meson.build / SConstruct → CMake / Make / Autotools / Meson / SCons
# 源码结构
**/*.c
**/*.cpp / **/*.cc / **/*.cxx
**/*.h / **/*.hpp / **/*.hxx
```

记录：单模块还是多模块？每个模块/目录的职责是什么？

## 2. 技术栈指纹识别

### 2.1 框架与库识别 — 读取构建文件与源码

从 CMakeLists.txt、Makefile、configure.ac、pkg-config 文件、vcpkg.json、conanfile.txt 等构建配置中提取依赖，识别以下关键组件（包括但不限于）：

| 组件类型 | 常见选项 | 识别方法 |
|----------|----------|----------|
| 网络/Web 框架 | libevent, libmicrohttpd, mongoose, civetweb, cpp-httplib, Crow, Drogon, Boost.Beast | 依赖配置 + #include 扫描 |
| 加密/安全库 | OpenSSL, mbedTLS, libsodium, GnuTLS, wolfSSL | 依赖 + #include 扫描 |
| 数据库 | libpq (PostgreSQL), libmysqlclient, sqlite3, ODBC, libhiredis (Redis) | 依赖 + API 调用扫描 |
| 序列化/解析 | protobuf, flatbuffers, json-c, cJSON, nlohmann/json, rapidjson, libxml2, expat | 依赖 + #include 扫描 |
| IPC/RPC | gRPC, D-Bus, ZeroMQ, Unix socket | 依赖 + API 调用扫描 |
| 内存管理 | jemalloc, tcmalloc, 自定义分配器 | 依赖 + 链接选项 |
| 日志 | spdlog, log4cxx, syslog, 自研 | 依赖 + #include 扫描 |

### 2.2 编译器与标准版本确认

```
Grep: -std=c11 / -std=c17 / -std=c++11 / -std=c++14 / -std=c++17 / -std=c++20
Grep: CMAKE_C_STANDARD / CMAKE_CXX_STANDARD
Grep: 编译选项中的安全标志: -fstack-protector / -D_FORTIFY_SOURCE / -fPIE / -Wformat-security
```

编译器版本和标准影响可用的安全特性（如 C11 的 `_s` 安全函数、C++17 的 `std::optional` 等）。

如果上述方法无法获取版本信息，请在结果中标记为未识别。

## 3. 攻击面枚举

### 3.1 外部交互点与功能收集

分析项目结构后，需要识别程序的所有外部交互点和关键功能模块，需要重点关注以下三种类型的文件并进行收集：

**交互点类型**：
- `main()` 函数及其命令行参数解析逻辑
- 网络监听交互点：`socket/bind/listen/accept`、HTTP handler 注册、RPC 服务注册
- 信号处理函数：`signal()` / `sigaction()` 注册的 handler
- 回调函数：注册到框架/事件循环中的回调
- 导出函数：共享库（.so/.dll）中的导出 API
- IPC 交互点：管道、共享内存、消息队列、D-Bus handler
- 文件解析交互点：处理外部输入文件的解析函数（如配置文件解析、协议解析）

**敏感函数文件收集**：

需要扫描并记录包含以下敏感函数（包括但不限于）调用的文件，优先使用 Python 脚本进行批量处理：

| 敏感类别 | 函数/模式 |
|----------|----------|
| 命令执行 | `system()`, `popen()`, `exec*()`, `fork()+exec*()`, `ShellExecute()`, `CreateProcess()` |
| 内存操作 | `memcpy()`, `memmove()`, `strcpy()`, `strncpy()`, `strcat()`, `sprintf()`, `gets()`, `scanf()` 无宽度限制 |
| 格式化字符串 | `printf(var)`, `fprintf(var)`, `syslog(var)` — 第一个参数为变量而非字面量 |
| 文件操作 | `fopen()`, `open()`, `rename()`, `unlink()`, `chmod()`, `chown()`, `mkdir()`, 路径拼接 |
| 网络操作 | `connect()`, `send()`, `recv()`, `recvfrom()`, `sendto()`, DNS 解析函数 |
| 整数运算 | 涉及 `malloc/calloc/realloc` 参数的算术运算（整数溢出风险） |
| 类型转换 | 有符号/无符号混用、窄化转换 |
| 加密相关 | 自实现加密、弱随机数 `rand()/srand()`、硬编码密钥 |

获取全量的外部交互点文件和敏感函数所在的文件信息，优先使用 Python 脚本来进行处理，找不到情况下才使用 Grep 工具来进行收集，要求如下：
1. 仅对当前审计的目标进行处理
2. 对每个交互点记录：文件名、函数名、交互点类型、接收的外部输入描述
3. 对每个敏感函数调用记录：文件名、所在函数、敏感函数名、调用上下文
4. 结果按文件组织，方便后续开展漏洞分析，减少 token 浪费
5. 将得到的结果保存到指定的结果文件 `.audit_output/02_recon_result/recon-result.json` 的 entry_points 结构中

*重要*：需要注意需要收集全量的外部交互点和敏感函数数据，需要认真阅读目标源码，分析架构，编写脚本对目标文件进行提取，在提取后需要对结果进行二次检查，看是否有目标遗漏，需要尽可能覆盖全部交互点所在的文件，这样前期侦察对后续的深入审计的效果才能起到一个决定性的作用。

### 3.2 认证/授权与权限检查

```
Grep 模式:
  # 权限检查
  getuid|geteuid|getgid|getegid|setuid|setgid|seteuid|setegid
  cap_get_proc|cap_set_flag|prctl\(PR_SET_
  
  # 访问控制
  access\(|faccessat\(|stat\(.*S_I[RWX]
  
  # 沙箱/隔离
  chroot|seccomp|pledge|unveil|sandbox
  setrlimit|prctl\(PR_SET_SECCOMP
  
  # 自定义认证
  auth|login|password|credential|token|session|cookie
  verify|validate|check_permission|is_authorized
```

重点关注：是否存在权限提升路径？是否有未经认证即可触达的功能？setuid 程序的输入校验是否充分？

注意事项：如果上述方式无法确定认证/授权架构，请根据项目的实际情况来对权限控制进行分析。

### 3.3 加密与安全机制
需要详细检查当前项目是否存在以下安全机制：
- 数据加密：使用了哪些加密算法？是否存在自实现加密？
- 通信安全：TLS/SSL 配置是否正确？证书校验是否完整？
- 随机数生成：是否使用了密码学安全的随机数生成器？
- 密钥管理：密钥是否硬编码？存储方式是否安全？

需要对这些情况分析，并附上对应的代码示例进行佐证。

## 4. 配置文件定位

```
Glob 模式:
  **/CMakeLists.txt
  **/Makefile / **/Makefile.am / **/Makefile.in
  **/configure.ac / **/configure.in
  **/*.conf / **/*.cfg / **/*.ini
  **/*.json (配置类)
  **/*.xml (配置类)
  **/.env*
  **/docker-compose*.yml
  **/Dockerfile*
  **/vcpkg.json / **/conanfile.txt / **/conanfile.py
```

## 5. 侦察报告输出格式

完成侦察后，输出以下结构化信息：

```
## 侦察报告
- 项目类型: [单体/多模块/库]
- C/C++ 标准: [C11/C17/C++14/C++17/...]
- 构建工具: [CMake/Make/Autotools/Meson/...]
- 编译安全选项: [stack-protector/FORTIFY_SOURCE/PIE/...]
- 网络框架: [libevent/mongoose/无/...]
- 加密库: [OpenSSL/mbedTLS/无/...]
- 数据库: [sqlite3/libpq/无/...]
- 序列化库: [protobuf/json-c/...]
- 外部交互点数量: [n]
- 敏感函数调用文件数: [n]
- 无认证可达交互点: [列表]
- 文件操作交互点: [列表]
- 高风险模块: [按优先级排序的模块列表]
```

高风险模块优先级排序依据：
1. 处理外部网络输入的模块
2. 包含命令执行/系统调用的模块
3. 包含内存操作（缓冲区操作）的模块
4. 包含文件操作/路径处理的模块
5. 包含格式化字符串操作的模块
6. 包含权限操作/setuid 逻辑的模块
7. 包含加密/认证逻辑的模块
8. 包含第三方库调用的模块

## 6. 侦察结果持久化

侦察完成后，完整结果需要保存到 `.audit_output/02_recon_result/recon-result.json`，供后续分析阶段读取。
该文件包含以下关键数据，所有字段不能为空，无匹配项时数组填 []，字符串填 "未识别", 后续阶段将依赖它进行全量审计：
```json
{
  "entry_points": [
    {
      "file": "文件相对路径",
      "function": "函数名",
      "entry_type": "main/network_handler/signal_handler/callback/exported_api/ipc/file_parser",
      "description": "交互点功能描述",
      "external_input": "接收的外部输入描述",
      "auth": "权限检查描述 或 无认证"
    }
  ],
  "sensitive_calls": [
    {
      "file": "文件相对路径",
      "caller_function": "调用所在的函数名",
      "sensitive_function": "被调用的敏感函数名",
      "category": "command_exec/memory_op/format_string/file_op/network_op/integer_op/crypto",
      "context": "调用上下文简述"
    }
  ],
  "auth_config": { "type": "...", "unauthenticated_paths": [...] },
  "audit_targets": ["建议重点审计的文件路径"],
  "sensitive_files": ["安全关键文件"],
  "dependencies": ["关键第三方依赖"]
}
```

**关键要求**：
- `entry_points` 中的 `file` 字段是必须的，必须覆盖项目所有模块的所有外部交互点
- `entry_points` 必须包含所有处理外部输入的函数（网络、文件、命令行、IPC 等）
- `sensitive_calls` 必须覆盖所有包含敏感函数调用的文件
- 上面的预扫描结果列出了项目的所有模块，确保每个模块都被扫描
- `audit_targets` 应包含所有包含交互点/敏感调用的文件，以及安全关键文件
- 禁止输出任何与报告内容无关的话
- 每个交互点的 `auth` 字段必须准确标注认证/权限检查状态