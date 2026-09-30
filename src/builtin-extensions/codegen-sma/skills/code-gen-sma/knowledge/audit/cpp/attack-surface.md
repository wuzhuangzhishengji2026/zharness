# 阶段二：攻击面分析与数据流追踪

基于侦察阶段的结果，本阶段对每个外部交互点进行 Source-Sink 分析，建立数据流追踪路径。

## 1. Source 定义（用户可控输入）

### 1.1 直接外部输入

| Source 类型 | C/C++ 代码模式 | 风险等级 |
|-------------|----------------|----------|
| 命令行参数 | `argc/argv`, `getopt()`, `getopt_long()`, `argp_parse()` | 高 |
| 标准输入 | `stdin`, `fgets(stdin)`, `scanf()`, `gets()`, `getline()`, `read(STDIN_FILENO)` | 高 |
| 网络数据 | `recv()`, `recvfrom()`, `recvmsg()`, `read(sockfd)`, `SSL_read()` | 高 |
| 文件读取 | `fread()`, `fgets()`, `read()`, `mmap()`, `getc()`, `fgetc()` | 高 |
| 环境变量 | `getenv()`, `secure_getenv()`, `environ` | 中 |
| HTTP 请求 | 框架特定的请求解析函数（mongoose/civetweb/libmicrohttpd handler 参数） | 高 |
| IPC 输入 | `msgrcv()`, 共享内存 `shmat()`, 管道 `read(pipefd)`, D-Bus 消息 | 中 |
| DNS/主机名 | `gethostbyname()`, `getaddrinfo()` 返回值 | 中 |

### 1.2 间接 Source

| Source 类型 | 说明 | 风险等级 |
|-------------|------|----------|
| 数据库读取 | 存储型攻击：之前写入的恶意数据被读出使用 | 中 |
| 配置文件 | 解析 INI/JSON/XML/YAML 配置文件中的值 | 中 |
| 共享内存 | 其他进程写入的共享内存数据 | 中 |
| 信号参数 | `siginfo_t` 中的附加数据 | 低 |
| 第三方库回调 | 外部库通过回调传入的数据 | 低 |
| /proc 或 /sys | 从伪文件系统读取的数据 | 低 |

## 2. Sink 定义（危险操作）

### 2.1 缓冲区溢出 Sink

```
Grep 模式:
  # 不安全的字符串操作
  strcpy\(|strcat\(|sprintf\(|vsprintf\(
  gets\(
  scanf\(.*%s|scanf\(.*%\[

  # 有长度但可能错误的操作
  strncpy\(|strncat\(|snprintf\(
  memcpy\(|memmove\(|memset\(
  
  # 宽字符版本
  wcscpy\(|wcscat\(|swprintf\(
  
  # C++ string 到 C 缓冲区
  \.c_str\(\).*strcpy|\.c_str\(\).*memcpy
```

### 2.2 格式化字符串 Sink

```
Grep 模式:
  # 格式化函数的第一个参数为变量（非字面量）
  printf\s*\(\s*[a-zA-Z_]       ← printf(var) 而非 printf("literal")
  fprintf\s*\(.*,\s*[a-zA-Z_]
  sprintf\s*\(.*,\s*[a-zA-Z_]
  snprintf\s*\(.*,.*,\s*[a-zA-Z_]
  syslog\s*\(.*,\s*[a-zA-Z_]
  
  # 日志函数
  LOG_.*\(\s*[a-zA-Z_]
```

### 2.3 命令注入 Sink

```
Grep 模式:
  system\(
  popen\(
  exec[lv]p?\(|execve?\(
  ShellExecute\(|CreateProcess\(|WinExec\(
  wordexp\(
  dlopen\(.*\+|dlopen\(.*var    ← 动态库加载
```

### 2.4 整数溢出 Sink

```
Grep 模式:
  # malloc/calloc/realloc 参数中的算术运算
  malloc\s*\(.*[\+\*]|calloc\s*\(.*[\+\*]|realloc\s*\(.*[\+\*]
  
  # 数组索引中的算术
  \[.*[\+\*].*\]
  
  # 有符号/无符号比较
  size_t.*<\s*0|unsigned.*<\s*0
  
  # 长度/大小参数
  (len|size|count|num|offset)\s*[\+\-\*]
```

### 2.5 文件操作 Sink

```
Grep 模式:
  fopen\(|open\(|creat\(|openat\(
  rename\(|unlink\(|remove\(|rmdir\(
  chmod\(|chown\(|chgrp\(
  mkdir\(|mkdtemp\(|mkstemp\(
  symlink\(|link\(|readlink\(
  access\(|stat\(|lstat\(
  
  # 路径拼接
  strcat\(.*path|sprintf\(.*path|snprintf\(.*path
  realpath\(|canonicalize_file_name\(
```

### 2.6 Use-After-Free / Double-Free Sink

```
Grep 模式:
  free\(
  delete\s|delete\s*\[
  realloc\(
  
  # C++ 智能指针误用
  \.get\(\).*delete|\.release\(\)
  unique_ptr.*\.get\(\)    ← 获取裸指针后可能误用
```

### 2.7 竞态条件 Sink

```
Grep 模式:
  # TOCTOU（检查-使用竞态）
  access\(.*open\(|stat\(.*open\(|lstat\(.*open\(
  
  # 不安全的临时文件
  tmpnam\(|tempnam\(|mktemp\(
  
  # 缺少锁保护的共享资源
  pthread_mutex|pthread_rwlock|std::mutex|std::lock_guard
  # 注意：搜索这些是为了确认是否有锁保护，而非 Sink 本身
```

### 2.8 类型混淆 Sink

```
Grep 模式:
  # C 风格强制转换
  \(char\s*\*\)|\(int\s*\*\)|\(void\s*\*\)
  reinterpret_cast<|static_cast<
  
  # union 类型双关
  union\s*\{
  
  # 可变参数函数
  va_start|va_arg|va_list
```

### 2.9 XML/数据解析 Sink

```
Grep 模式:
  # XML 解析（XXE 风险）
  xmlParseFile\(|xmlParseMemory\(|xmlReadFile\(|xmlReadMemory\(
  xmlCtxtReadFile\(|xmlCtxtReadMemory\(
  XML_Parse\(|XML_ParseBuffer\(          ← expat
  
  # JSON 解析
  json_loads\(|json_parse\(|cJSON_Parse\(
  
  # YAML 解析
  yaml_parser_parse\(
```

### 2.10 加密相关 Sink

```
Grep 模式:
  # 弱随机数
  rand\(\)|srand\(|random\(|srandom\(
  
  # 弱哈希
  MD5_Init\(|MD5_Update\(|SHA1_Init\(
  MD5\(|SHA1\(
  
  # 硬编码密钥
  (key|secret|password|passwd)\s*=\s*"[^"]{8,}"
  (key|secret|password|passwd)\s*\[\]\s*=\s*\{
  
  # 不安全的 TLS 配置
  SSL_CTX_set_verify\(.*SSL_VERIFY_NONE
  SSL_set_verify\(.*SSL_VERIFY_NONE
```

## 3. 数据流追踪方法论

### 3.1 正向追踪（Source → Sink）

从每个外部交互点函数的外部输入参数出发：
1. 记录输入来源和缓冲区/变量名
2. 跟踪数据在函数内的传递：直接使用？拷贝到局部缓冲区？传入子函数？
3. 进入被调用函数：参数是否被校验/截断/转换？
4. 最终到达 Sink：数据如何被使用？

关键判断点：
- 是否有长度检查（`strlen()` 比较、`sizeof()` 限制）
- 是否有边界校验（数组索引范围检查）
- 是否有输入净化（过滤特殊字符、白名单校验）
- 是否使用了安全替代函数（`strncpy` 替代 `strcpy`、`snprintf` 替代 `sprintf`）

### 3.2 反向追踪（Sink → Source）

从危险函数调用出发：
1. 确认 Sink 函数的参数来源
2. 逐层回溯：局部变量 → 函数参数 → 调用者传入 → 外部交互点函数参数
3. 判断参数是否最终来自外部输入

### 3.3 追踪中断条件（安全）

以下情况可以中断追踪，判定为安全：
- 数据经过严格的长度截断且目标缓冲区足够大
- 使用了安全函数且长度参数正确（如 `snprintf(buf, sizeof(buf), ...)`)
- 输入经过白名单校验（枚举值、正则匹配）
- 数据来源是编译期常量或硬编码字面量
- 整数参数经过范围检查后再用于内存分配/数组索引
- 使用了 C++ 安全容器（`std::string`, `std::vector`）且无裸指针操作

### 3.4 追踪加速技巧

- 先搜索 Sink，再反向追踪，效率高于正向全量扫描
- 优先审计处理网络输入的函数（直接暴露给远程攻击者）
- 优先审计接收 `char*` / `void*` 参数的函数（类型不安全）
- 关注 `size_t` 和 `int` 混用的场景（整数溢出/截断）
- 关注宏定义中隐藏的不安全操作

## 4. 信任边界

```
外部输入 ──→ [网络层/文件读取] ──→ [输入解析/协议解析] ──→ [业务逻辑]
                                                              │
                                                              ▼
                                                         [核心处理]
                                                              │
                                              ┌───────────────┼───────────────┐
                                              ▼               ▼               ▼
                                         [文件系统]    [系统调用]      [外部进程/网络]
```

每次跨越信任边界时，检查是否有输入校验/长度限制/类型检查。
重点关注：外部输入 → 解析层是否有充分校验，业务逻辑 → 系统调用之间参数是否安全。