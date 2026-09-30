# 阶段三：漏洞挖掘与验证

基于第二阶段攻击面分析和数据流追踪结果，本阶段对每个确认的 Source-Sink 路径进行漏洞验证。

## 0. 漏洞挖掘方法

**核心原则**：
1. 对于每个外部交互点，追踪其数据流直至到达 Sink 函数
2. 不仅关注直接的数据流，还需要关注间接调用
3. 到达 Sink 后，需要判断是否存在安全校验
4. 对于无法确认的漏洞，标记为"待调查"，留给 review-report SKILL 处理

## 1. SQL 注入 (CWE-89)

**搜索**:
```
Grep: sprintf\(.*SELECT\|sprintf\(.*INSERT\|sprintf\(.*UPDATE\|sprintf\(.*DELETE
Grep: snprintf\(.*SELECT\|snprintf\(.*INSERT\|snprintf\(.*UPDATE\|snprintf\(.*DELETE
Grep: string.*\+.*SELECT\|string.*\+.*INSERT\|string.*\+.*UPDATE\|string.*\+.*DELETE
Grep: mysql_query\|mysql_real_query\|sqlite3_exec\|sqlite3_prepare_v2
Grep: ODBC\|SQLExecDirect\|SQLPrepare\|PQexec\|PQexecParams
```

**验证**:
1. SQL 语句中是否包含外部输入？
2. 是否使用了参数化查询？
3. 是否使用了安全的 API（`mysql_stmt_prepare`, `sqlite3_prepare_v2`, `PQexecParams`）？
4. 输入是否经过了充分的过滤？

## 2. 命令注入 (CWE-78)

**搜索**:
```
Grep: system\(
Grep: popen\(
Grep: exec[lv]p?\(|execve?\(
Grep: wordexp\(
Grep: ShellExecute\w*\(|CreateProcess\w*\(|WinExec\(
```

**验证**:
1. `system()` / `popen()` 的参数是否包含外部输入？
2. 输入是否经过了充分的过滤？
3. 是否使用了白名单/命令白名单？
4. `exec*()` 的参数是否完全可控？

## 3. 路径遍历 (CWE-22)

**搜索**:
```
Grep: fopen\(.*\+|open\(.*\+
Grep: realpath\(|canonicalize_file_name\(
Grep: strcat\(.*path|sprintf\(.*path|snprintf\(.*path
Grep: chdir\(|chroot\(
```

**验证**:
1. 文件路径是否包含外部输入？
2. 是否使用了路径规范化（`realpath()`）？
3. 规范化后的路径是否在允许的目录内？
4. 是否有 `../` 或 null 字节注入？

## 4. 缓冲区溢出 (CWE-120/CWE-121/CWE-122)

### 4.1 栈缓冲区溢出

**搜索**:
```
Grep: strcpy\(|strcat\(|sprintf\(|vsprintf\(
Grep: gets\(
Grep: scanf\(.*%[^0-9*]*(s|\[)
```

**验证**:
1. 源数据是否来自外部输入？
2. 目标缓冲区大小是否足够容纳源数据？
3. 是否有长度检查？

### 4.2 堆缓冲区溢出

**搜索**:
```
Grep: malloc\(.*\).*strcpy\(|malloc\(.*\).*memcpy\(
Grep: realloc\(
Grep: strncpy\(.*,.*,.*strlen    ← 长度参数不正确
```

### 4.3 Off-by-One 错误

**搜索**:
```
Grep: \[.*sizeof.*-\s*1\]|\[.*len\s*\]
Grep: <=\s*sizeof|<=\s*len|<=\s*size
Grep: strncat\(.*sizeof\(.*\)    ← strncat 的最后一个参数不正确
```

## 5. 格式化字符串漏洞 (CWE-134)

**搜索**:
```
Grep: printf\s*\(\s*[a-zA-Z_]\w*\s*\)
Grep: fprintf\s*\(\s*\w+\s*,\s*[a-zA-Z_]\w*\s*\)
Grep: sprintf\s*\(\s*\w+\s*,\s*[a-zA-Z_]\w*\s*\)
Grep: snprintf\s*\(\s*\w+\s*,\s*\w+\s*,\s*[a-zA-Z_]\w*\s*\)
Grep: syslog\s*\(\s*\w+\s*,\s*[a-zA-Z_]\w*\s*\)
```

**验证**:
1. 格式化函数的第一个参数是变量还是字符串字面量？
2. 如果是变量，它是否来自外部输入？
3. 是否使用了 `%n` 写入操作符或 `%x` 信息泄露？

## 6. 整数溢出/下溢 (CWE-190/CWE-191)

**搜索**:
```
Grep: malloc\s*\(.*[\+\*]|calloc\s*\(.*[\+\*]|realloc\s*\(.*[\+\*]
Grep: (int|short|int32_t)\s+\w+\s*=.*size_t|size_t.*=.*(int|short|int32_t)
Grep: \(int\)\s*\w*(len|size|count)|\(unsigned\)\s*\w*(len|size|count)
```

## 7. Use-After-Free (CWE-416)

**搜索**:
```
Grep: free\(.*\)[\s\S]*?\1    ← 同一变量 free 后仍被使用
Grep: free\(
Grep: delete\s+\w|delete\s*\[\s*\]\s*\w
```

## 8. 认证绕过 (CWE-287)

**搜索**:
```
Grep: strcmp.*password\|strcmp.*secret\|strcmp.*token
Grep: memcmp.*password\|memcmp.*secret\|memcmp.*token
Grep: time\(\)|gettimeofday\(\)|localtime\(\)|gmtime\(\)
Grep: strncmp\(.*password\|strncmp\(.*secret
Grep: ==.*\"password\"\|==.*\"secret\"\|==.*\"token\"
```

## 9. 越权访问 (CWE-862/CWE-863)

### 9.1 水平越权（IDOR）

**搜索**:
```
Grep: strcat.*id\|strcat.*ID\|sprintf.*id\|sprintf.*ID
Grep: \+.*id\b\|\+.*ID\b
Grep: fopen\(.*id\|open\(.*id
Grep: sqlite3_exec.*id\|mysql_query.*id
```

### 9.2 垂直越权

**搜索**:
```
Grep: /admin\|/manage\|/system\|/internal\|/super
Grep: strcmp.*admin\|strcmp.*role\|strcmp.*privilege
Grep: getuid\(\)|geteuid\(\)|getgid\(\)|getegid\(\)
Grep: access\(|faccessat\(
```

### 9.3 属性篡改

**搜索**:
```
Grep: role\|roleId\|isAdmin\|userType\|status\|level\|grade\|vip
Grep: strcpy.*role\|strcpy.*status\|sprintf.*role\|sprintf.*status
Grep: ->role\|\.role\|\->status\|\.status
```

## 10. Double-Free (CWE-415)

**搜索**:
```
Grep: free\(
Grep: delete\s
```

## 11. 竞态条件 / TOCTOU (CWE-367)

**搜索**:
```
Grep: access\(.*\)[\s\S]*?open\(
Grep: stat\(.*\)[\s\S]*?open\(
Grep: lstat\(.*\)[\s\S]*?(open|unlink|rename)\(
Grep: tmpnam\(|tempnam\(|mktemp\(
```

## 12. 文件操作漏洞 (CWE-434)

### 12.1 文件写入

**搜索**:
```
Grep: fopen\(.*"w\|fopen\(.*"wb\|open\(.*O_WRONLY\|open\(.*O_RDWR.*O_CREAT
Grep: write\(|fwrite\(|fputs\(|fprintf\(
Grep: recv\(|read\(|fread\(|fgets\(
```

### 12.2 文件读取

**搜索**:
```
Grep: fopen\(.*"r\|fopen\(.*"rb\|open\(.*O_RDONLY
Grep: read\(|fread\(|send\(|write\(
Grep: printf\|fprintf\|puts\|fputs
```

### 12.3 文件删除

**搜索**:
```
Grep: remove\(|unlink\(|DeleteFile\|DeleteFileW
Grep: rmdir\(|_rmdir\(
Grep: open\(.*O_TRUNC\|open\(.*O_CREAT.*O_TRUNC
```

### 12.4 文件类型校验绕过

**搜索**:
```
Grep: strstr\(.*\.jpg\|strstr\(.*\.png\|strstr\(.*\.gif\|strstr\(.*\.pdf
Grep: strcmp\(.*\.jpg\|strcmp\(.*\.png\|strcmp\(.*\.gif\|strcmp\(.*\.pdf
Grep: \.jpg\|\.png\|\.gif\|\.pdf
```

## 13. 未初始化变量 (CWE-457/CWE-908)

**搜索**:
```
Grep: (char|int|struct)\s+\w+\s*;    ← 栈变量声明后可能未初始化
Grep: malloc\(                        ← malloc 不初始化内存（calloc 会）
Grep: alloca\(
```

## 14. 空指针解引用 (CWE-476)

**搜索**:
```
Grep: malloc\(|calloc\(|realloc\(|strdup\(|fopen\(
```

## 15. 信号处理漏洞 (CWE-479)

**搜索**:
```
Grep: signal\(|sigaction\(
Grep: SIG_IGN|SIG_DFL
```

## 16. 资源耗尽 (CWE-400)

### 16.1 内存耗尽

**搜索**:
```
Grep: malloc\(.*user\|malloc\(.*len\|malloc\(.*size
Grep: new\s+\w+\(.*user\|new\s+\w+\(.*len\|new\s+\w+\(.*size
Grep: while\s*\(\s*1\s*\)|for\s*\(\s*;\s*;\s*\)|for\s*\(\s*;\s*true\s*\)
Grep: recv\(|read\(|fgets\(|fread\(|gets\(
```

### 16.2 正则表达式 DoS (ReDoS)

**搜索**:
```
Grep: regex\(|std::regex\|boost::regex\|pcre_compile
```

### 16.3 线程/连接资源耗尽

**搜索**:
```
Grep: pthread_create\|CreateThread\|std::thread
Grep: listen\(|accept\(|socket\(
Grep: fopen\(|open\(|FILE\|fdopen
```

## 17. 弱加密/随机数 (CWE-327/CWE-338)

**搜索**:
```
Grep: rand\(\)|srand\(|random\(\)|srandom\(
Grep: MD5_Init\(|MD5\(|SHA1_Init\(|SHA1\(
Grep: DES_|RC4_|RC2_|IDEA_
Grep: EVP_des_|EVP_rc4\(|EVP_rc2\(
Grep: SSL_CTX_set_verify\(.*VERIFY_NONE
Grep: (key|secret|password|passwd)\s*(\[.*\])?\s*=\s*["{]
```

## 18. XML 外部实体注入 XXE (CWE-611)

**搜索**:
```
Grep: xmlParseFile\(|xmlParseMemory\(|xmlReadFile\(|xmlReadMemory\(
Grep: xmlCtxtReadFile\(|xmlCtxtReadMemory\(
Grep: XML_Parse\(|XML_ParseBuffer\(
Grep: xmlSubstituteEntitiesDefault\(|xmlLoadExtDtdDefaultValue
```

## 19. 内存泄漏 (CWE-401)

**搜索**:
```
Grep: malloc\(|calloc\(|strdup\(|realloc\(
Grep: new\s+\w
```

## 20. 不安全 API 使用

**搜索**:
```
Grep: gets\(                    ← 永远不安全的函数
Grep: scanf\(.*%s              ← 无宽度限制的 %s
Grep: strcpy\(|strcat\(        ← 无长度检查
Grep: sprintf\(                ← 无长度检查
Grep: atoi\(|atol\(|atof\(    ← 错误处理不完善，使用 strtol 代替
Grep: alloca\(                 ← 栈分配可能导致栈溢出
```

**安全替代方案**:
| 不安全函数 | 安全替代 |
|------------|----------|
| `gets()` | `fgets()` |
| `strcpy()` | `strncpy()` / `strlcpy()` / `snprintf()` |
| `strcat()` | `strncat()` / `strlcat()` |
| `sprintf()` | `snprintf()` |
| `scanf("%s")` | `scanf("%255s")` 或 `fgets()` |
| `atoi()` | `strtol()` + 错误检查 |
| `tmpnam()` | `mkstemp()` |