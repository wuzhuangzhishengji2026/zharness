# 阶段三：漏洞挖掘（Java）

## 0. 前置步骤：加载外部交互点列表

开始漏洞挖掘前，必须先读取侦察阶段发现的完整外部交互点列表。

**审计策略**：

1. 按外部交互点列表逐个审计，优先审计无认证（`auth: "无认证"`）的交互点
2. 对每个交互点，执行下方各漏洞类型的检查
3. 同时执行 Sink 反向搜索，捕获交互点列表之外的漏洞
4. 审计完成后执行覆盖率检查（见 review-report SKILL）

## 0.1 正向分析方法（当前审计目标为外部交互点时使用）

当审计目标是 entry_points 中的某个外部交互点方法时，从该方法的外部输入参数出发，沿调用链向下追踪数据流向，直到数据到达 Sink 或被净化。

**步骤**：

1. **读取交互点方法完整代码**：使用 Read 工具读取该方法所在文件，理解方法签名、参数来源和整体逻辑
2. **标记污点参数**：识别方法中所有来自外部的输入数据（方法参数、请求对象的取值调用、文件读取返回值等），将每个外部输入标记为 `[TAINTED]`
3. **逐行追踪污点传播**：在方法体内，按代码执行顺序追踪每个 `[TAINTED]` 变量的流向：
   - **赋值传播**：`String b = a;` — 如果 a 是 `[TAINTED]`，则 b 也是 `[TAINTED]`
   - **拼接传播**：`String sql = "SELECT * FROM " + a;` — sql 是 `[TAINTED]`
   - **对象字段传播**：`dto.setName(a);` — dto 的 name 字段是 `[TAINTED]`
   - **集合传播**：`list.add(a);` / `map.put("key", a);` — 集合中包含 `[TAINTED]` 元素
   - **返回值传播**：`return process(a);` — 如果 process 内部未净化，返回值仍是 `[TAINTED]`
4. **跨方法追踪**：当 `[TAINTED]` 数据作为参数传入另一个方法时，使用 Read/Grep 工具读取被调用方法的实现，进入该方法继续追踪。逐层深入，不跳过中间层
5. **检查净化点**：在追踪过程中，遇到以下情况可以移除 `[TAINTED]` 标记，中断该分支的追踪：
   - 类型转换为非字符串类型（如 `Integer.parseInt()`、`Long.valueOf()`）
   - 白名单校验通过（枚举匹配、固定值列表包含检查）
   - 正则校验通过且正则足够严格（如只允许字母数字）
   - 框架参数绑定机制（如 `#{}` 占位符、`PreparedStatement ?` 参数化）
   - 编码/转义函数处理（需确认转义类型与 Sink 类型匹配，如 HTML 转义只防 XSS 不防 SQL 注入）
6. **Sink 匹配**：当 `[TAINTED]` 数据流入危险操作时，记录为疑似漏洞。危险操作的判定参照下方各漏洞类型章节的 Sink 模式
7. **记录完整数据流**：对每个发现，记录从外部交互点参数到 Sink 的完整调用路径

## 0.2 反向追踪方法（当前审计目标为 Sink 点时使用）

当审计目标是通过 Grep 搜索发现的危险函数调用（Sink 点）时，从 Sink 的参数出发，沿调用链向上回溯，直到确认参数是否来自外部输入。

**步骤**：
1. **读取 Sink 上下文**：使用 Read 工具读取 Sink 所在方法的完整代码，理解 Sink 的参数是什么、从哪里来
2. **识别待回溯参数**：确定 Sink 中哪个参数是潜在危险的
3. **在当前方法内回溯**：找到赋值语句，对赋值的右值继续回溯
4. **跨方法回溯**：当参数来自方法参数时，使用 Grep 搜索该方法的所有调用者
5. **判定结果**：回溯到外部输入来源 → 用户可控；回溯到硬编码常量 → 排除
6. **验证中间防护**：确认 Source 到 Sink 之间是否存在有效的净化措施
7. **记录完整数据流**

## 0.3 审计执行顺序

对于每个漏洞类型，按以下顺序执行：
1. **Sink 搜索**：用 Grep 搜索该漏洞类型的所有 Sink 模式，得到候选列表
2. **快速筛选**：排除明显安全的调用（参数为硬编码常量、已使用安全绑定机制等）
3. **反向追踪**：对剩余候选项执行反向追踪，确认参数是否用户可控
4. **正向验证**：对外部交互点列表中的高优先级交互点，执行正向追踪作为补充
5. **交叉验证**：将正向和反向的结果合并去重，形成最终发现列表

## 0.4 全局误报排除规则

以下情况**不计入漏洞**：
- 代码位于单行注释中（`// ...`）
- 代码位于多行注释中（`/* ... */`）
- 代码位于被注释掉的方法、类或语句中
- 仅分析实际会执行的代码，忽略所有注释内容

---

## 1. SQL 注入 (CWE-89)

### 1.1 MyBatis ${} 拼接

**搜索**: 在所有 `*Mapper.xml` 文件中搜索 `${`
```
Grep: \$\{
Glob: **/*Mapper.xml
```

**验证步骤**:
1. 记录 `${}` 所在的 SQL 语句和参数名
2. 找到对应的 Mapper 接口方法
3. 找到调用该 Mapper 方法的 Service
4. 追溯参数来源到 Controller

**误报排除**:
- `${tableName}` 如果在 Service 层做了白名单校验（只允许特定表名）→ 非漏洞
- `${orderBy}` 如果只允许 ASC/DESC 且列名来自枚举 → 非漏洞
- `${}` 的值来自系统配置或常量，非用户输入 → 非漏洞
- `${}` 用于 `<foreach>` 的 `separator`/`open`/`close` 属性 → 非漏洞

**确认漏洞**:
- `${}` 的值直接或间接来自 HTTP 请求参数，且无白名单校验 → SQL 注入
- 特别关注：ORDER BY、表名、列名场景，因为这些无法用 `#{}` 参数化

### 1.2 JDBC 字符串拼接

**搜索**:
```
Grep: (Statement|PreparedStatement|Connection)\s*[\w]*\s*=.*\n.*\.execute
Grep: ".*SELECT.*"\s*\+\s*|".*INSERT.*"\s*\+\s*|".*UPDATE.*"\s*\+\s*|".*DELETE.*"\s*\+\s*
```

### 1.3 JPA/Hibernate 原生查询

**搜索**:
```
Grep: createNativeQuery|createQuery.*\+|nativeQuery\s*=\s*true
Grep: @Query.*\+|@Query.*nativeQuery
```

### 1.4 JdbcTemplate 拼接

**搜索**:
```
Grep: jdbcTemplate\.(query|update|execute|batchUpdate)\(
```

---

## 2. 命令注入 (CWE-78)

**搜索**:
```
Grep: Runtime\.getRuntime\(\)\.exec\(
Grep: new ProcessBuilder\(
Grep: ScriptEngine.*\.eval\(
Grep: GroovyShell|GroovyClassLoader.*\.parse
```

**验证步骤**:
1. exec() 或 ProcessBuilder 的参数是否包含用户输入
2. 是否使用了字符串数组形式（相对安全）还是单字符串形式（危险）
3. 是否有命令白名单或参数过滤

**严重程度**: 如果未认证用户可触发 → Critical；需认证 → High

---

## 3. 路径遍历 (CWE-22)

**搜索**:
```
Grep: new File\(.*\+|new File\(.*request|new File\(.*param
Grep: Paths\.get\(.*\+|Path\.of\(.*\+
Grep: getOriginalFilename\(\)
Grep: \.transferTo\(
Grep: FileUtils\.(read|write|copy)|IOUtils\.copy
```

**验证步骤**:
1. 文件路径是否包含用户可控部分
2. 是否有路径规范化处理（`File.getCanonicalPath()`, `Path.normalize()`）
3. 是否校验了规范化后的路径仍在允许的目录内
4. 文件名是否过滤了 `../`、`..\\`、空字节 `%00`

---

## 4. 反序列化 (CWE-502)

**搜索**:
```
Grep: ObjectInputStream|\.readObject\(\)|\.readUnshared\(\)
Grep: XMLDecoder
Grep: JSON\.parse|JSON\.parseObject|JSON\.parseArray|autoType
Grep: enableDefaultTyping|@JsonTypeInfo|DefaultTyping
Grep: XStream\.fromXML|xstream\.fromXML
Grep: Yaml\.load\(|new Yaml\(\)\.load
Grep: SerializationUtils\.deserialize
Grep: Hessian2Input|HessianInput|BurlapInput
Grep: Kryo.*\.read
```

**验证步骤**:
1. 反序列化的数据来源是否用户可控
2. 是否配置了反序列化过滤器（JEP 290 ObjectInputFilter）
3. Fastjson 版本是否 < 1.2.83（autoType 绕过）
4. Jackson 是否启用了 `enableDefaultTyping()`
5. 项目依赖中是否包含已知 gadget chain 库（Commons Collections 3.x, Commons Beanutils 等）

**严重程度**: 未认证可触发 + 有可用 gadget → Critical

---

## 5. SSRF (CWE-918)

**搜索**:
```
Grep: new URL\(.*\)\.open|HttpURLConnection
Grep: RestTemplate\.(getFor|postFor|exchange|execute)\(
Grep: WebClient\.(create|build)
Grep: HttpClient\.(send|newHttpClient)
Grep: OkHttpClient|\.newCall\(
Grep: Jsoup\.connect\(
Grep: ImageIO\.read\(new URL
```

**验证步骤**:
1. URL 参数是否来自用户输入
2. 是否有 URL 白名单校验（域名、IP、协议）
3. 是否禁止了内网地址（127.0.0.1, 10.x, 172.16-31.x, 192.168.x, 169.254.x）
4. 是否禁止了危险协议（file://, gopher://, dict://）

---

## 6. XXE (CWE-611)

**搜索**:
```
Grep: DocumentBuilderFactory|SAXParserFactory|XMLInputFactory
Grep: TransformerFactory|SchemaFactory|XMLReader
Grep: SAXBuilder|SAXReader
Grep: Digester
```

**验证步骤**:
1. XML 解析器是否禁用了外部实体：
   - `setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)`
   - `setFeature("http://xml.org/sax/features/external-general-entities", false)`
   - `setFeature("http://xml.org/sax/features/external-parameter-entities", false)`
2. 解析的 XML 数据是否来自用户输入

---

## 7. XSS (CWE-79)

### 7.1 反射型 XSS

**搜索**:
```
Grep: response\.getWriter\(\)\.(write|print)\(.*request\.get
Grep: @ResponseBody.*return.*request\.get
```

### 7.2 存储型 XSS

**搜索**: 追踪用户输入 → 数据库存储 → 页面展示的完整链路

### 7.3 模板注入导致的 XSS

**搜索**:
```
Grep: th:utext|v-html|dangerouslySetInnerHTML|\{!!.*!!}
Grep: Velocity.*\.merge|FreeMarker.*process
```

**误报排除**:
- 前后端分离架构中，后端只返回 JSON，XSS 防护在前端框架（Vue/React 自动转义）→ 通常非漏洞
- Spring Boot 默认使用 Thymeleaf `th:text`（自动转义），只有 `th:utext` 不转义

---

## 8. 认证绕过 (CWE-287)

**搜索**:
```
Grep: permitAll|anon|@Anonymous|@IgnoreAuth|@NoAuth
Grep: filterChainDefinitionMap|antMatchers|requestMatchers
Grep: \.excludePathPatterns\(
```

**验证步骤**:
1. 列出所有匿名访问端点
2. 检查每个匿名端点是否确实应该公开
3. 检查路径匹配规则是否有绕过可能：
   - `/api/admin` vs `/api/admin/` (尾部斜杠)
   - `/api/admin` vs `/api/Admin` (大小写)
   - `/api/admin` vs `/api/admin;bypass` (分号截断，Shiro 经典漏洞)
   - `/api/admin` vs `/api/./admin` (路径规范化)
4. 检查 JWT 校验逻辑：
   - 是否验证签名？是否检查过期时间？
   - 是否允许 `alg: none`？
   - 密钥是否硬编码或过于简单？

---

## 9. 越权访问 (CWE-862 / CWE-863)

### 9.1 水平越权（IDOR）

**搜索**: 所有接收资源标识符（ID、编号、名称等）并用于数据操作的接口
```
Grep: @PathVariable.*[Ii]d|@RequestParam.*[Ii]d|@RequestBody.*[Ii]d
Grep: getById\(|selectById\(|deleteById\(|updateById\(|removeById\(
Grep: findById\(|findOne\(|getOne\(|getReferenceById\(
Grep: @PathVariable.*[Nn]o|@RequestParam.*[Nn]o|@PathVariable.*[Cc]ode
Grep: @PathVariable.*[Uu]uid|@RequestParam.*[Uu]uid
Grep: @RequestParam.*orderId|@RequestParam.*orderNo|@RequestParam.*fileId
```

**验证步骤（正向追踪）**：
1. **定位参数来源**：确认接口方法中哪些参数是资源标识符，标记为 `[TAINTED]`
2. **追踪参数流向**：跟踪该标识符从外部交互点方法到最终数据操作的完整路径
3. **检查每一层是否有归属校验**：SQL 层面关联用户、Service 层面校验归属、框架层面数据权限注解
4. **如果整条链路中无任何归属校验** → 水平越权

### 9.2 垂直越权

**搜索**: 管理类/特权操作接口
```
Grep: /admin|/manage|/system|/internal|/ops|/super
Grep: @PreAuthorize|@Secured|@RolesAllowed|@RequiresRoles|@RequiresPermissions
Grep: hasRole\(|hasAuthority\(|hasPermission\(
Grep: @IgnoreAuth|@Anonymous|@NoAuth|permitAll|anon
```

### 9.3 参数级越权

**搜索**: 接口中接收角色/权限/状态等敏感字段的参数
```
Grep: role|roleId|isAdmin|userType|status|level|grade|vip
Grep: @RequestBody.*User|@RequestBody.*Account|@RequestBody.*Member
```

---

## 10. CSRF (CWE-352)

**搜索**:
```
Grep: csrf\(\)\.disable\(\)|csrf\.disable|@CrossOrigin
Grep: CorsConfiguration|addAllowedOrigin\(\"\*\"\)
```

---

## 11. 表达式注入 (CWE-917)

**搜索**:
```
Grep: SpelExpressionParser|parseExpression\(
Grep: StandardEvaluationContext
Grep: OGNL\.getValue|ActionContext
Grep: MVEL\.eval
```

**验证**:
- 表达式内容是否来自用户输入
- 是否使用了 `SimpleEvaluationContext`（安全）而非 `StandardEvaluationContext`（危险）

---

## 12. 文件操作 (CWE-434)

**搜索**:
```
Grep: MultipartFile|@RequestPart|CommonsMultipartFile
Grep: getOriginalFilename\(\)|getContentType\(\)
Grep: transferTo\(|\.write\(
```

**验证步骤**:
1. 是否校验了文件扩展名（白名单，非黑名单）
2. 是否校验了文件内容（Magic Number / MIME Type）
3. 存储文件名是否使用了随机生成（UUID）而非原始文件名
4. 存储路径是否在 Web 可访问目录外
5. 是否限制了文件大小

---

## 13. 信息泄露 (CWE-200)

**搜索**:
```
Grep: printStackTrace\(\)|e\.getMessage\(\).*response|e\.toString\(\).*response
Grep: /actuator|/swagger-ui|/druid|/h2-console|/console
Grep: @ApiOperation|springdoc|springfox
Grep: server\.error\.include-stacktrace|server\.error\.include-message
```

---

## 14. 开放重定向 (CWE-601)

**搜索**:
```
Grep: sendRedirect\(|redirect:|RedirectView|setViewName\("redirect:
Grep: response\.setHeader\("Location"
```

---

## 15. JNDI 注入 (CWE-074)

**搜索**:
```
Grep: InitialContext\.lookup\(|Context\.lookup\(
Grep: JndiTemplate\.lookup\(
Grep: JdbcRowSetImpl|setDataSourceName
```

---

## 16. 拒绝服务 (CWE-400)

### 16.1 资源耗尽

**搜索**:
```
Grep: while\s*\(\s*true\s*\)|for\s*\(\s*;;\s*\)
Grep: \.read\(\)|BufferedReader.*readLine|InputStream.*read
Grep: \.size\(\)|\.length\(\)|\.length
Grep: Collections\.sort|Arrays\.sort|Stream\.sorted
Grep: \.split\(|StringTokenizer
Grep: Pattern\.compile|Pattern\.matcher
```

### 16.2 正则表达式 DoS (ReDoS)

**搜索**:
```
Grep: Pattern\.compile\(.*".*(\(.*\)|\+|\\{2,}|\[.*\].*)+.*"
Grep: \.matches\(|String\.matches\(|Pattern\.matches\(
```

### 16.3 未限制的并发与大小

**搜索**:
```
Grep: @RequestMapping|@GetMapping|@PostMapping
Grep: MultipartFile|@RequestPart|MaxUploadSize
Grep: server\.tomcat\.max-http-form-post-size|spring\.servlet\.multipart\.max-file-size
Grep: @Async|ExecutorService|ThreadPoolExecutor
Grep: Semaphore|CountDownLatch|CyclicBarrier
```

### 16.4 缓存攻击

**搜索**:
```
Grep: @Cacheable|@CachePut|@CacheEvict
Grep: RedisTemplate|StringRedisTemplate
Grep: ConcurrentHashMap|GuavaCache|Caffeine
```

## 输出 Finding 格式

```json
{
  "findings": [
    {
      "id": "VULN-001",
      "title": "漏洞标题",
      "severity": "critical|high|medium|low|info",
      "cwe_id": "CWE-89",
      "category": "漏洞分类",
      "file_path": "path/to/file.java",
      "line_start": 42,
      "line_end": 45,
      "description": "漏洞描述",
      "data_flow": "Controller 参数 → Service → 危险操作",
      "code_snippet": "...",
      "remediation": "修复建议",
      "confidence": "high|medium|low",
      "reviewed": false,
      "review_status": "pending",
      "review_detail": ""
    }
  ]
}
```