# 阶段一：侦察与信息收集（Java）

在开始漏洞挖掘之前，必须先全面了解目标项目，本阶段的目标是建立项目的完整画像，不做任何漏洞挖掘的工作。
此阶段允许编写`Python`脚本来进行信息收集，使用`Python`要求如下：
1. Python 脚本只能创建在系统/tmp/目录下
2. 脚本处理的目标只能是当前被审计的项目，不能超出边界
3. 如果存在处理后的结果，请保存到项目的 `.audit_output/02_recon_result`目录中，方便其他工具对结果进行读取

## 1. 项目结构扫描

使用 Glob 扫描以下模式，确定项目类型和构建系统：

```
# 构建系统识别
pom.xml / build.gradle / build.gradle.kts → Maven / Gradle
# 模块结构
**/src/main/java/**
**/src/main/resources/**
```

记录：单模块还是多模块？每个模块的职责是什么？

## 2. 技术栈指纹识别

### 2.1 框架识别 — 读取构建文件

从 pom.xml 、build.gradle、web.xml或者依赖目录等，Java中常见的配置中提取依赖，识别以下关键组件（包括但不限于）：

| 组件类型 | 常见选项 | 识别方法 |
|----------|----------|----------|
| Web 框架 | Spring MVC, Spring WebFlux, Struts2, Jersey, Vert.x | 依赖 groupId/artifactId |
| 安全框架 | Spring Security, Apache Shiro, Sa-Token, 自研 | 依赖 + 配置类扫描 |
| ORM/数据层 | MyBatis, MyBatis-Plus, Hibernate/JPA, JdbcTemplate | 依赖 + Mapper/Repository 扫描 |
| 序列化 | Fastjson, Jackson, Gson, Hessian, Kryo | 依赖 + import 扫描 |
| 模板引擎 | Thymeleaf, FreeMarker, Velocity, JSP | 依赖 + 模板文件扫描 |
| 缓存 | Redis (Jedis/Lettuce/Redisson), Ehcache, Caffeine | 依赖 + 配置 |
| 消息队列 | RabbitMQ, RocketMQ, Kafka | 依赖 + Listener 扫描 |

### 2.2 Java 版本确认

```
Grep: <java.version> 或 sourceCompatibility 或 <source> 或 <release>
```

Java 版本影响可用的安全特性（如 JEP 290 反序列化过滤器需要 Java 9+）。

如果上述方法无法获取版本信息，请在结果中标记为未识别。

## 3. 攻击面枚举

### 3.1 认证/授权架构

```
Grep 模式:
  # Spring Security
  extends WebSecurityConfigurerAdapter|SecurityFilterChain|HttpSecurity
  \.permitAll\(\)|\.anonymous\(\)|antMatchers|requestMatchers
  @PreAuthorize|@Secured|@RolesAllowed

  # Shiro
  ShiroFilterFactoryBean|filterChainDefinitionMap
  anon|authc|perms|roles

  # Sa-Token
  SaRouter|StpUtil\.check

  # JWT
  JwtFilter|JwtToken|JWTVerifier|SignAlgorithm

  # 自定义注解
  @IgnoreAuth|@NoAuth|@Anonymous|@PermissionLimit|@RequiresPermissions
```

重点关注：哪些路径配置了匿名访问（anon/permitAll）？过滤器链的顺序是什么？

注意事项：如果上述方式无法确定认证/授权架构，请根据项目的实际情况来对授权进行分析。

### 3.2 加密、验签技术
需要详细的检查当前项目是否存在对请求进行加密、验签的情况，如果有的话是如何实现的？
需要对这种情况分析，并附上对应的代码示例进行佐证。

### 3.3 HTTP 端点文件收集

分析项目结构后，该阶段需要学习知识库`JavaWeb应用HTTP端点定义方式大全.md`来进行知识储备，然后分析项目的HTTP端点是怎么创建的（如`Spring MVC`使用注解的模式，Servlet使用了`web.xml` 或 `@WebServlet`等，Struts2使用了`struts.xml`中`action`配置），需要考虑规则是什么样的，怎么才能对端点所在的文件进行全量收集，**这里的思考很重要，用于给后续获取全量的HTTP端点信息做铺垫**。

获取全量的 HTTP 端点对应的文件信息，优先使用 Python 脚本来进行处理，找不到情况下才使用Grep工具来进行收集，要求如下：
1. 仅对当前审计的目标进行处理
2. 对每个端点的记录（非必须）：类名、路径前缀（类级 @RequestMapping）、所有方法路径、HTTP 方法。
3. 结果需要是文件名下包含对应的端点记录，这样方便后续开展漏洞分析，减少token浪费
4. 将得到的结果保存到指定的结果文件`.audit_output/02_recon_result/recon-result.json`的entry_points结构中

*重要*：需要注意需要收集全量的包含端点的文件数据，需要认真阅读目标源码，分析架构，编写脚本对目标文件进行提取，在提取后需要对结果进行二次检查，看是否有目标遗漏，需要尽可能覆盖全部端点所在的文件，这样前期侦察对后续的深入审计的效果才能起到一个决定性的作用。

## 4. 配置文件定位

```
Glob 模式:
  **/application*.yml
  **/application*.yaml
  **/application*.properties
  **/bootstrap*.yml
  **/*.xml (过滤 pom.xml 和 Mapper XML)
  **/.env*
  **/docker-compose*.yml
```

## 5. 侦察报告输出格式

完成侦察后，输出以下结构化信息：

```
## 侦察报告
- 项目类型: [单体/微服务/模块化]
- Java 版本: [x]
- 构建工具: [Maven/Gradle]
- Web 框架: [Spring Boot x.x / ...]
- 安全框架: [Spring Security / Shiro / Sa-Token / 无]
- ORM: [MyBatis / MyBatis-Plus / JPA / JdbcTemplate]
- 序列化库: [Fastjson / Jackson / Gson]
- HTTP 端点数量: [n]
- 匿名访问端点: [列表]
- 文件上传交互点: [列表]
- 高风险模块: [按优先级排序的模块列表]
```

高风险模块优先级排序依据：
1. 包含匿名访问端点的模块
2. 包含文件上传/下载的模块
3. 包含用户认证/登录逻辑的模块
4. 包含动态 SQL / 数据查询接口的模块
5. 包含系统命令执行的模块
6. 包含第三方服务调用的模块

## 6. 侦察结果持久化

侦察完成后，完整结果需要保存到 `.audit_output/02_recon_result/recon-result.json`，供后续分析阶段读取。
该文件包含以下关键数据，所有字段不能为空，无匹配项时数组填 []，字符串填 "未识别", 后续阶段将依赖它进行全量审计：
```json
{
  "entry_points": [
    {
      "file": "文件相对路径",
      "method": "方法/函数名",
      "http_method": "GET/POST/PUT/DELETE",
      "path": "URL 路径",
      "params": ["参数名 (来源: query/body/path/header)"],
      "auth": "认证注解/装饰器 或 无认证"
    }
  ],
  "auth_config": { "type": "...", "public_paths": [...] },
  "audit_targets": ["建议重点审计的文件路径"],
  "sensitive_files": ["安全关键文件"],
  "dependencies": ["关键第三方依赖"]
}
```

**关键要求**：
- `entry_points` 必须覆盖项目的所有模块的所有 HTTP 端点，不能只扫描部分模块
- 上面的预扫描结果列出了项目的所有模块，确保每个模块的路由都被发现
- `audit_targets` 应包含所有包含路由/外部交互点的文件，以及安全关键文件
- 禁止输出任何与报告内容无关的话
- 每个交互点的 `auth` 字段必须准确标注认证状态