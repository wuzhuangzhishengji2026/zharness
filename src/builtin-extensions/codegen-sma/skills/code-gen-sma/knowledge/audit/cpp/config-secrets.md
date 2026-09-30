# 阶段四：配置与敏感信息审计

## 1. 硬编码凭证扫描

### 1.1 高精度搜索模式

以下 Grep 模式按误报率从低到高排列，优先使用前面的模式：

```
# 赋值语句中的密码/密钥（高置信度）
Grep: (password|passwd|secret|token|apikey|api_key)\s*=\s*"[^"]{8,}"
Grep: (password|passwd|secret|token|apikey|api_key)\s*\[\]\s*=\s*"[^"]{8,}"
Grep: (password|passwd|secret|token|apikey|api_key)\s*\[\]\s*=\s*\{

# 配置文件中的明文凭证
Grep (在 *.conf/*.cfg/*.ini/*.json/*.xml 中):
  password\s*[=:]\s*[^\s$#\{][^\s#]+
  secret\s*[=:]\s*[^\s$#\{][^\s#]+
  token\s*[=:]\s*[^\s$#\{][^\s#]+

# 连接字符串中的密码
Grep: (mysql|postgres|redis|mongo)://.*:.*@
Grep: host=.*password=

# 私钥内容
Grep: -----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----
Grep: -----BEGIN CERTIFICATE-----

# 云服务凭证
Grep: AKIA[0-9A-Z]{16}                    ← AWS Access Key
Grep: (ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}  ← GitHub Token
Grep: sk-[A-Za-z0-9]{48}                  ← OpenAI API Key
```

### 1.2 排除规则（减少误报）

以下情况不算漏洞：
- 值为环境变量引用：`getenv("DB_PASSWORD")`
- 值为空字符串或占位符：`""`, `"changeme"`, `"xxx"`, `"your-secret-here"`
- 位于测试目录（`test/`, `tests/`, `t/`）中的 mock 数据
- 位于注释中的示例值（标记为 info 级别）
- 位于 `.example` 或 `.template` 后缀的文件中
- `#define` 定义的默认值且有运行时覆盖机制

### 1.3 熵值辅助判断

对于不确定的字符串，评估其信息熵：
- 高熵（看起来随机，混合大小写+数字+特殊字符）→ 更可能是真实密钥
- 低熵（有意义的单词、重复字符）→ 更可能是占位符

## 2. 编译安全选项检查

### 2.1 编译器安全标志

**搜索**:
```
Grep (在 CMakeLists.txt/Makefile/configure.ac 中):
  -fstack-protector|-fstack-protector-strong|-fstack-protector-all
  -D_FORTIFY_SOURCE
  -fPIE|-fPIC|-pie
  -Wformat|-Wformat-security|-Wformat=2
  -fno-strict-overflow|-fwrapv
  -z\s*relro|-z\s*now
  -z\s*noexecstack
  ASLR|stack.protector|fortify
```

**检查项**:
| 安全选项 | 作用 | 缺失风险 |
|----------|------|----------|
| `-fstack-protector-strong` | 栈溢出检测 | 栈缓冲区溢出可利用 |
| `-D_FORTIFY_SOURCE=2` | 运行时缓冲区溢出检测 | 缓冲区溢出不被检测 |
| `-fPIE -pie` | 地址空间随机化 | ASLR 无效 |
| `-Wformat-security` | 格式化字符串警告 | 格式化字符串漏洞不被发现 |
| `-z relro -z now` | GOT 表保护 | GOT 覆写攻击 |
| `-z noexecstack` | 栈不可执行 | 栈上代码执行 |

### 2.2 危险编译选项

**搜索**:
```
Grep: -fno-stack-protector
Grep: -D_FORTIFY_SOURCE=0
Grep: -z\s*execstack
Grep: -fno-PIE|-no-pie
Grep: -Wno-format|-Wno-format-security
```

如果存在这些选项 → 标记为安全配置缺陷

## 3. TLS/SSL 配置审计

### 3.1 OpenSSL 配置

**搜索**:
```
Grep: SSL_CTX_new\(|SSL_new\(
Grep: SSL_CTX_set_verify\(
Grep: SSL_CTX_set_cipher_list\(|SSL_CTX_set_ciphersuites\(
Grep: SSL_CTX_set_min_proto_version\(|SSL_CTX_set_max_proto_version\(
Grep: SSLv2_method\(|SSLv3_method\(|SSLv23_method\(|TLSv1_method\(
```

**检查项**:
| 配置项 | 安全要求 | 搜索模式 |
|--------|----------|----------|
| 证书验证 | 不应设为 VERIFY_NONE | `SSL_VERIFY_NONE` |
| 协议版本 | 应禁用 SSLv2/SSLv3/TLSv1.0/TLSv1.1 | `SSLv2\|SSLv3\|TLSv1_method` |
| 密码套件 | 不应包含弱密码 | `NULL\|EXPORT\|DES\|RC4\|MD5` 在 cipher list 中 |
| 主机名验证 | 应验证服务器主机名 | `SSL_set1_host\|X509_check_host` |

### 3.2 mbedTLS / wolfSSL 配置

**搜索**:
```
Grep: mbedtls_ssl_conf_authmode\(.*MBEDTLS_SSL_VERIFY_NONE
Grep: wolfSSL_CTX_set_verify\(.*SSL_VERIFY_NONE
```

## 4. 权限与沙箱配置

### 4.1 setuid/setgid 程序

**搜索**:
```
Grep: setuid\(|seteuid\(|setgid\(|setegid\(
Grep: setreuid\(|setregid\(|setresuid\(|setresgid\(
```

### 4.2 沙箱/隔离机制

**搜索**:
```
Grep: chroot\(|pivot_root\(
Grep: seccomp\(|prctl\(PR_SET_SECCOMP
Grep: pledge\(|unveil\(
Grep: setrlimit\(|prlimit\(
Grep: unshare\(|clone\(.*CLONE_NEW
Grep: cap_set_flag\(|cap_set_proc\(
```

## 5. 配置文件安全

### 5.1 配置文件权限

检查包含敏感信息的配置文件权限是否过于宽松（world-readable）

### 5.2 默认配置

**搜索**:
```
Grep (在 *.conf/*.cfg/*.ini 中):
  bind\s*=?\s*0\.0\.0\.0|listen\s*=?\s*0\.0\.0\.0    ← 监听所有接口
  debug\s*=?\s*(true|1|on|yes)                         ← 调试模式
  auth\s*=?\s*(false|0|off|no|disabled)                ← 认证禁用
  allow_remote\s*=?\s*(true|1|on|yes)                  ← 远程访问
```

### 5.3 Docker/容器配置

**搜索**:
```
Grep (在 Dockerfile* 中):
  --privileged|--cap-add|--security-opt.*no-new-privileges
  USER\s+root                                          ← 以 root 运行
  COPY.*\.(key|pem|cert|p12)                          ← 复制密钥文件到镜像
```

## 6. 日志安全

**搜索**:
```
Grep: (syslog|LOG_|log_|fprintf.*stderr)\(.*password
Grep: (syslog|LOG_|log_|fprintf.*stderr)\(.*token
Grep: (syslog|LOG_|log_|fprintf.*stderr)\(.*secret
Grep: (syslog|LOG_|log_|fprintf.*stderr)\(.*key
```

## 7. 输出格式

每个发现标注类型：
- `[硬编码凭证]` — 代码或配置中的明文密码/密钥
- `[编译安全缺陷]` — 缺少安全编译选项
- `[TLS 配置缺陷]` — TLS/SSL 配置不当
- `[权限配置缺陷]` — 权限/沙箱配置不当
- `[信息泄露]` — 调试接口/日志泄露敏感信息
- `[日志泄露]` — 敏感信息写入日志