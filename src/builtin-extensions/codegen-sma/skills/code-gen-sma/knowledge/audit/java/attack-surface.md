# 阶段二：攻击面分析与数据流追踪（Java）

基于侦察阶段的结果，本阶段对每个外部交互点进行 Source-Sink 分析，建立数据流追踪路径。

## 1. Source 定义（用户可控输入）

### 1.1 HTTP 请求参数

| Source 类型 | Java 代码模式 | 风险等级 |
|-------------|---------------|----------|
| URL 参数 | `@RequestParam`, `request.getParameter()`, `request.getParameterValues()` | 高 |
| 路径参数 | `@PathVariable`, `request.getPathInfo()` | 高 |
| 请求体 | `@RequestBody`, `request.getInputStream()`, `request.getReader()` | 高 |
| 请求头 | `@RequestHeader`, `request.getHeader()` | 中 |
| Cookie | `@CookieValue`, `request.getCookies()` | 中 |
| 上传文件 | `MultipartFile`, `request.getPart()`, `request.getParts()` | 高 |
| 完整 URL | `request.getRequestURI()`, `request.getRequestURL()`, `request.getQueryString()` | 中 |

### 1.2 间接 Source

| Source 类型 | 说明 | 风险等级 |
|-------------|------|----------|
| 数据库读取 | 存储型攻击：之前写入的恶意数据被读出使用 | 中 |
| 消息队列 | 消费的消息内容可能被污染 | 中 |
| 文件读取 | 读取用户上传的文件内容 | 中 |
| 环境变量 | 容器环境中可能被注入 | 低 |
| 第三方 API 响应 | 外部服务返回的数据不可信 | 低 |

## 2. Sink 定义（危险操作）

### 2.1 SQL 注入 Sink

```
Grep 模式:
  # JDBC 直接拼接
  Statement\.execute|Statement\.executeQuery|Statement\.executeUpdate
  ".*SELECT.*\+|".*INSERT.*\+|".*UPDATE.*\+|".*DELETE.*\+
  String\.format\(.*SELECT|String\.format\(.*INSERT|String\.format\(.*UPDATE

  # MyBatis 动态拼接
  \$\{                    ← 在 Mapper XML 中搜索，#{} 是安全的，${} 是危险的
  @Select.*\$\{|@Update.*\$\{|@Insert.*\$\{|@Delete.*\$\{

  # JPA/Hibernate
  createQuery\(.*\+|createNativeQuery\(.*\+|createSQLQuery\(.*\+
  nativeQuery.*=.*true

  # JdbcTemplate
  jdbcTemplate\.(query|update|execute)\(.*\+
```

### 2.2 命令注入 Sink

```
Grep 模式:
  Runtime\.getRuntime\(\)\.exec\(
  ProcessBuilder
  \.start\(\)
  ScriptEngine\.eval\(
  GroovyShell|GroovyClassLoader
  javax\.script\.ScriptEngine
```

### 2.3 文件操作 Sink

```
Grep 模式:
  new File\(|new FileInputStream\(|new FileOutputStream\(
  new FileReader\(|new FileWriter\(
  Files\.(read|write|copy|move|delete|newInputStream|newOutputStream)
  IOUtils\.copy|FileUtils\.(read|write|copy|move)
  transferTo\(|getOriginalFilename\(\)
  \.getResource\(|ResourceUtils\.getFile
```

### 2.4 反序列化 Sink

```
Grep 模式:
  ObjectInputStream|\.readObject\(\)|\.readUnshared\(\)
  XMLDecoder|\.readObject\(\)
  JSON\.parse|JSON\.parseObject|JSON\.parseArray    ← Fastjson
  enableDefaultTyping|@JsonTypeInfo                  ← Jackson
  SerializationUtils\.deserialize
  Hessian2Input|HessianInput
  Kryo\.readObject|Kryo\.readClassAndObject
  XStream\.fromXML
  Yaml\.load\(                                       ← SnakeYAML
```

### 2.5 SSRF Sink

```
Grep 模式:
  new URL\(.*\)\.open|HttpURLConnection
  RestTemplate\.(getForObject|getForEntity|postForObject|exchange)
  WebClient\.create|WebClient\.builder
  HttpClient\.send|HttpClient\.newHttpClient
  OkHttpClient|\.newCall\(
  Jsoup\.connect\(
  ImageIO\.read\(new URL
```

### 2.6 XSS Sink

```
Grep 模式:
  response\.getWriter\(\)\.write\(|response\.getWriter\(\)\.print\(
  response\.getOutputStream\(\)\.write\(
  PrintWriter\.write\(|PrintWriter\.print\(
  @ResponseBody.*return.*\+     ← 字符串拼接返回
  ModelAndView|addAttribute\(   ← 检查模板是否转义
```

### 2.7 LDAP 注入 Sink

```
Grep 模式:
  LdapTemplate|DirContext\.search\(
  SearchControls|NamingEnumeration
  ".*\(.*=.*\+                  ← LDAP filter 拼接
```

### 2.8 表达式注入 Sink

```
Grep 模式:
  SpelExpressionParser|ExpressionParser\.parseExpression
  StandardEvaluationContext
  OGNL\.getValue|OgnlUtil
  MVEL\.eval|MVEL\.compileExpression
  ELProcessor\.eval|ELManager
  FreeMarker.*Template|Velocity.*Template
```

### 2.9 XXE Sink

```
Grep 模式:
  DocumentBuilderFactory|SAXParserFactory|XMLInputFactory
  TransformerFactory|SchemaFactory|XMLReader
  SAXBuilder|SAXReader                               ← dom4j
  Digester                                           ← Apache Commons
```

### 2.10 日志注入 Sink

```
Grep 模式:
  log\.(info|debug|warn|error)\(.*\+|log\.(info|debug|warn|error)\(.*request\.get
  logger\.(info|debug|warn|error)\(.*\+
```

## 3. 数据流追踪方法论

### 3.1 正向追踪（Source → Sink）

从每个 Controller 方法的参数出发：
1. 记录参数名和类型
2. 跟踪参数在方法体内的传递：直接使用？赋值给局部变量？传入 Service 方法？
3. 进入 Service 层：参数是否被校验/过滤/转换？
4. 进入 DAO/Mapper 层：参数最终如何被使用？

关键判断点：
- 参数是否经过白名单校验（枚举值、正则匹配、范围检查）
- 参数是否经过编码/转义函数（HtmlUtils.htmlEscape, URLEncoder.encode）
- 参数是否经过全局过滤器/拦截器处理（XSS Filter, SQL 注入过滤器）

### 3.2 反向追踪（Sink → Source）

从危险函数调用出发：
1. 确认 Sink 函数的参数来源
2. 逐层回溯：局部变量 → 方法参数 → 调用者传入 → Controller 参数
3. 判断参数是否最终来自用户输入

### 3.3 追踪中断条件（安全）

以下情况可以中断追踪，判定为安全：
- 参数经过 PreparedStatement 参数化绑定（`?` 占位符 或 MyBatis `#{}`）
- 参数经过严格的白名单校验（枚举、固定值列表）
- 参数经过框架内置的转义函数
- 参数来源是系统内部常量，非用户可控
- 参数经过类型转换为非字符串类型（int, long, boolean）

### 3.4 追踪加速技巧

- 先搜索 Sink，再反向追踪，效率高于正向全量扫描
- 优先审计匿名访问端点（无需认证即可触发）
- 优先审计接收 String 类型参数的接口（类型化参数天然防注入）
- 关注 Map<String,Object> 和 JSONObject 类型参数（绕过类型检查）

## 4. 信任边界

```
外部用户 ──→ [Nginx/Gateway] ──→ [Filter/Interceptor] ──→ [Controller]
                                                              │
                                                              ▼
                                                         [Service]
                                                              │
                                              ┌───────────────┼───────────────┐
                                              ▼               ▼               ▼
                                         [Database]    [File System]   [External API]
```

每次跨越信任边界时，检查是否有输入校验/输出编码。
重点关注：Controller → Service 之间是否有校验，Service → DAO 之间参数是否安全绑定。