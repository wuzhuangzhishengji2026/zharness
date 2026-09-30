# 阶段六：依赖与供应链审计（Java）

## 1. 依赖文件定位与解析

### 1.1 Maven 项目

```
Glob: **/pom.xml
```

从每个 pom.xml 中提取：
- `<parent>` 的 Spring Boot / Spring Cloud 版本
- `<dependencies>` 中所有直接依赖的 groupId:artifactId:version
- `<dependencyManagement>` 中的版本管理
- `<properties>` 中定义的版本变量

注意：多模块项目需要从根 pom.xml 开始，逐层解析子模块。

### 1.2 Gradle 项目

```
Glob: **/build.gradle
Glob: **/build.gradle.kts
Glob: **/gradle/libs.versions.toml
```

提取 `implementation`, `api`, `compileOnly`, `runtimeOnly` 等配置中的依赖。

## 2. 高危组件速查表

### 2.1 已知 RCE 漏洞组件

| 组件 | 危险版本 | CVE | 漏洞类型 |
|------|----------|-----|----------|
| log4j-core | < 2.17.1 | CVE-2021-44228 (Log4Shell) | JNDI 注入 RCE |
| fastjson | < 1.2.83 | CVE-2022-25845 等 | autoType 反序列化 RCE |
| fastjson2 | < 2.0.26 | 多个 autoType 绕过 | 反序列化 RCE |
| shiro-core | < 1.11.0 | CVE-2023-22602 等 | 认证绕过/反序列化 |
| shiro-core | < 1.7.1 | CVE-2020-17523 | 路径匹配绕过 |
| spring-framework | < 5.3.18 | CVE-2022-22965 (Spring4Shell) | RCE |
| spring-cloud-function | < 3.2.3 | CVE-2022-22963 | SpEL 注入 RCE |
| spring-cloud-gateway | < 3.1.1 | CVE-2022-22947 | SpEL 注入 RCE |
| commons-collections | 3.0 - 3.2.1 | CVE-2015-6420 | 反序列化 gadget |
| commons-beanutils | < 1.9.4 | CVE-2019-10086 | 反序列化 gadget |
| commons-text | < 1.10.0 | CVE-2022-42889 (Text4Shell) | 插值注入 RCE |
| commons-io | < 2.7 | CVE-2021-29425 | 路径遍历 |
| jackson-databind | < 2.13.4.1 | 多个 CVE | 反序列化 RCE |
| xstream | < 1.4.20 | 多个 CVE | 反序列化 RCE |
| snakeyaml | < 2.0 | CVE-2022-1471 | 反序列化 RCE |
| mybatis | < 3.5.6 | CVE-2020-26945 | 反序列化 |
| druid | < 1.2.18 | 多个 | 未授权访问/信息泄露 |
| hutool | < 5.8.20 | 多个 | 多种漏洞 |
| dom4j | < 2.1.3 | CVE-2020-10683 | XXE |
| poi | < 5.2.3 | 多个 | XXE / SSRF |
| h2database | < 2.1.214 | CVE-2022-23221 | RCE |
| mysql-connector-java | < 8.0.28 | CVE-2021-2471 | SSRF / 反序列化 |
| postgresql | < 42.4.3 | CVE-2022-41946 | 临时文件信息泄露 |
| bcprov-jdk15on | < 1.70 | 多个 | 加密缺陷 |
| jsoup | < 1.15.3 | CVE-2022-36033 | XSS |
| thymeleaf | < 3.0.15 | CVE-2023-38286 | SSTI |
| velocity | < 2.3 | 多个 | SSTI |

### 2.2 搜索方法

对于 Maven 项目，在 pom.xml 中搜索：
```
Grep: <artifactId>(log4j|fastjson|shiro|commons-collections|commons-beanutils|commons-text|xstream|snakeyaml|jackson-databind|druid|hutool|dom4j|poi|h2|mysql-connector)
```

然后提取对应的 `<version>` 标签值，与上表比对。

注意：版本可能定义在 `<properties>` 中或父 pom 的 `<dependencyManagement>` 中，需要递归查找。

## 3. Spring Boot 版本与内置依赖

Spring Boot 的 `spring-boot-starter-parent` 管理了大量传递依赖的版本。

**搜索**:
```
Grep: <parent>[\s\S]*?spring-boot-starter-parent[\s\S]*?<version>(.*?)</version>
Grep: spring-boot\.version|spring\.boot\.version
```

Spring Boot 版本与关键依赖版本的对应关系：
| Spring Boot | Spring Framework | Jackson | Tomcat | Log4j2 |
|-------------|-----------------|---------|--------|--------|
| 2.6.x | 5.3.x | 2.13.x | 9.0.x | 2.17.x |
| 2.7.x | 5.3.x | 2.13.x | 9.0.x | 2.17.x |
| 3.0.x | 6.0.x | 2.14.x | 10.1.x | 2.19.x |
| 3.1.x | 6.0.x | 2.15.x | 10.1.x | 2.20.x |
| 3.2.x | 6.1.x | 2.16.x | 10.1.x | 2.21.x |

如果 Spring Boot < 2.6.2，则内置的 Log4j2 可能受 Log4Shell 影响。

## 4. 供应链风险评估

### 4.1 废弃/无人维护的依赖

**标记以下情况**:
- 最后发布时间超过 2 年的库
- 已被官方标记为 EOL（End of Life）的版本
- 已有官方替代品的旧库（如 `commons-lang` → `commons-lang3`）

### 4.2 版本管理风险

**搜索**:
```
Grep: <version>\[|<version>\(|<version>LATEST|<version>RELEASE
```

- 使用版本范围（`[1.0,2.0)`）→ 构建不可重复，可能引入有漏洞的版本
- 使用 `LATEST` 或 `RELEASE` → 同上

### 4.3 非官方仓库

**搜索**:
```
Grep: <repository>|<pluginRepository>|repositories\s*\{
```

检查是否引用了非 Maven Central 的仓库，评估其可信度。

## 5. 输出格式

每个发现包含：
```
- 依赖: groupId:artifactId
- 当前版本: x.y.z
- 受影响版本: < a.b.c
- CVE: CVE-XXXX-XXXXX
- 漏洞类型: [RCE/反序列化/信息泄露/XXE/...]
- 严重程度: [Critical/High/Medium/Low]
- 修复建议: 升级到 >= a.b.c
- 参考链接: NVD/GitHub Advisory URL
```