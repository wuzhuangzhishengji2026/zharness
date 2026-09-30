# 阶段四：配置与敏感信息审计（Java）

## 1. 硬编码凭证扫描

### 1.1 高精度搜索模式

以下 Grep 模式按误报率从低到高排列，优先使用前面的模式：

```
# 赋值语句中的密码/密钥（高置信度）
Grep: (password|passwd|secret|token|apikey|api_key)\s*=\s*"[^"]{8,}"
Grep: (password|passwd|secret|token|apikey|api_key)\s*=\s*'[^']{8,}'

# 配置文件中的明文凭证
Grep (在 *.yml/*.yaml/*.properties 中):
  password:\s*[^\s$#\{][^\s#]+
  secret:\s*[^\s$#\{][^\s#]+
  token:\s*[^\s$#\{][^\s#]+
  key:\s*[^\s$#\{][^\s#]+

# 连接字符串中的密码
Grep: jdbc:.*password=|mongodb://.*:.*@|redis://.*:.*@|amqp://.*:.*@

# 私钥内容
Grep: -----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----
Grep: -----BEGIN CERTIFICATE-----

# 云服务凭证
Grep: AKIA[0-9A-Z]{16}                    ← AWS Access Key
Grep: (ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}  ← GitHub Token
Grep: sk-[A-Za-z0-9]{48}                  ← OpenAI API Key
Grep: xox[bpors]-[0-9a-zA-Z-]+            ← Slack Token
```

### 1.2 排除规则（减少误报）

以下情况不算漏洞：
- 值为环境变量引用：`${DB_PASSWORD}`, `$DB_PASSWORD`, `%DB_PASSWORD%`
- 值为 Spring 占位符：`${spring.datasource.password}`
- 值为空字符串或占位符：`""`, `"changeme"`, `"xxx"`, `"your-secret-here"`
- 位于测试目录（`src/test/`）中的 mock 数据
- 位于注释中的示例值（标记为 info 级别）
- 位于 `.example` 或 `.template` 后缀的文件中

### 1.3 熵值辅助判断

对于不确定的字符串，评估其信息熵：
- 高熵（看起来随机，混合大小写+数字+特殊字符）→ 更可能是真实密钥
- 低熵（有意义的单词、重复字符）→ 更可能是占位符

## 2. 安全框架配置检查

### 2.1 Spring Security 配置

**搜索**:
```
Grep: class.*extends WebSecurityConfigurerAdapter|SecurityFilterChain
Grep: http\.(csrf|cors|headers|sessionManagement|authorizeRequests|authorizeHttpRequests)
```

**检查项**:
| 配置项 | 安全要求 | 搜索模式 |
|--------|----------|----------|
| CSRF | 不应全局禁用 | `csrf().disable()` |
| CORS | 不应允许 `*` origin | `allowedOrigins("*")` 或 `addAllowedOrigin("*")` |
| Session | 应配置超时和并发控制 | `sessionManagement()` |
| Headers | 应启用安全头 | `headers().frameOptions()`, `contentSecurityPolicy()` |
| 密码编码 | 应使用 BCrypt/SCrypt/Argon2 | `BCryptPasswordEncoder`, `PasswordEncoder` |

### 2.2 Shiro 配置

**搜索**:
```
Grep: ShiroFilterFactoryBean|filterChainDefinitionMap|ShiroConfig
```

**检查项**:
| 配置项 | 安全要求 | 搜索模式 |
|--------|----------|----------|
| 过滤器链 | anon 范围不应过大 | `anon` 条目列表 |
| RememberMe | 密钥不应硬编码 | `setCipherKey\|rememberMeManager` |
| Session | 应配置超时 | `setGlobalSessionTimeout` |
| 密码匹配 | 应使用安全哈希 | `HashedCredentialsMatcher`, `hashAlgorithmName` |

### 2.3 JWT 配置

**搜索**:
```
Grep: JWTVerifier|JWT\.create|Jwts\.builder|SignAlgorithm|Algorithm\.HMAC
Grep: jwt\.secret|jwt\.key|jwt\.token|signingKey
```

**检查项**:
- 签名密钥是否硬编码？长度是否足够（HMAC 至少 256 位）？
- 是否验证了 `exp`（过期时间）？
- 是否允许 `alg: none`？
- Token 过期时间是否合理（不应超过 24 小时）？
- 是否有 Token 刷新机制？

### 2.4 Sa-Token 配置

**搜索**:
```
Grep: SaTokenConfig|sa-token|SaManager|StpUtil
```

**检查项**: token-timeout 设置、is-concurrent 并发登录、is-share Token 共享

## 3. Spring Boot 配置审计

### 3.1 Actuator 端点

**搜索**:
```
Grep (在 application*.yml/properties 中):
  management\.endpoints\.web\.exposure\.include
  management\.endpoint\.\w+\.enabled
```

**高危端点**:
| 端点 | 风险 | 严重程度 |
|------|------|----------|
| /actuator/env | 泄露环境变量和配置（含密码） | Critical |
| /actuator/heapdump | 泄露堆内存（可提取密钥） | Critical |
| /actuator/configprops | 泄露所有配置属性 | High |
| /actuator/mappings | 泄露所有 URL 映射 | Medium |
| /actuator/beans | 泄露所有 Spring Bean | Medium |
| /actuator/health | 通常安全，但 details 可能泄露信息 | Low |

如果 `include=*` 且无认证保护 → Critical

### 3.2 调试与错误配置

**搜索**:
```
Grep (在 application*.yml/properties 中):
  server\.error\.include-stacktrace
  server\.error\.include-message
  spring\.devtools
  debug:\s*true|debug=true
  logging\.level\.root:\s*DEBUG|logging\.level\.root=DEBUG
```

### 3.3 数据库连接配置

**搜索**:
```
Grep: spring\.datasource\.(url|username|password|driver)
Grep: jdbc:(mysql|postgresql|oracle|sqlserver|h2)://
```

**检查项**:
- 密码是否明文写在配置文件中（应使用加密或环境变量）
- 是否使用了 H2 内存数据库的 Web Console（`spring.h2.console.enabled=true`）
- 连接是否启用了 SSL（`useSSL=true`）

### 3.4 文件上传配置

**搜索**:
```
Grep: spring\.servlet\.multipart\.(max-file-size|max-request-size|location)
Grep: multipart\.maxFileSize|multipart\.maxRequestSize
```

**检查**: 文件大小限制是否合理？上传目录是否在 Web 根目录外？

## 4. 第三方组件管理面板

**搜索**:
```
Grep: /druid|DruidStatViewServlet|StatViewServlet
Grep: /swagger-ui|/swagger-resources|springfox|springdoc
Grep: /h2-console|H2ConsoleAutoConfiguration
Grep: /nacos|/sentinel|/xxl-job-admin
```

**检查**: 这些管理面板是否有认证保护？是否应该在生产环境禁用？

## 5. CORS 配置

**搜索**:
```
Grep: @CrossOrigin|CorsConfiguration|CorsRegistry|addCorsMappings
Grep: allowedOrigins|allowedMethods|allowCredentials
Grep: Access-Control-Allow-Origin
```

**高危配置**:
- `allowedOrigins("*")` + `allowCredentials(true)` → 允许任意域携带凭证访问
- `allowedMethods("*")` → 允许所有 HTTP 方法

## 6. 日志安全

**搜索**:
```
Grep: log\.(info|debug|warn|error)\(.*password|log\.(info|debug|warn|error)\(.*token
Grep: log\.(info|debug|warn|error)\(.*secret|log\.(info|debug|warn|error)\(.*credential
Grep: logger\.(info|debug|warn|error)\(.*password
```

**检查**: 日志中是否打印了密码、Token、密钥等敏感信息？

## 7. 输出格式

每个发现标注类型：
- `[硬编码凭证]` — 代码或配置中的明文密码/密钥
- `[配置缺陷]` — 安全配置不当
- `[信息泄露]` — 管理面板/调试接口暴露
- `[日志泄露]` — 敏感信息写入日志