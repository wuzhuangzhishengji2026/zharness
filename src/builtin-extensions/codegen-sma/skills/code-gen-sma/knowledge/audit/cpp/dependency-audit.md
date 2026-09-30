# 阶段六：依赖与供应链审计

## 1. 依赖文件定位与解析

### 1.1 包管理器配置

```
Glob: **/vcpkg.json
Glob: **/conanfile.txt / **/conanfile.py
Glob: **/CMakeLists.txt
Glob: **/Makefile / **/Makefile.am / **/Makefile.in
Glob: **/configure.ac / **/configure.in
Glob: **/meson.build
Glob: **/SConstruct / **/SConscript
Glob: **/pkg-config/*.pc / **/*.pc.in
Glob: **/subprojects/*.wrap    ← Meson wrap 依赖
```

从这些文件中提取：
- vcpkg.json: `dependencies` 数组中的库名和版本约束
- conanfile: `requires` 中的 `库名/版本` 格式依赖
- CMakeLists.txt: `find_package()`, `pkg_check_modules()`, `FetchContent_Declare()` 中的库名和版本
- Makefile: `-l` 链接选项、`pkg-config` 调用
- configure.ac: `AC_CHECK_LIB`, `PKG_CHECK_MODULES` 中的库名

### 1.2 源码内嵌依赖（vendored）

```
Glob: **/third_party/**/*.[ch] / **/third_party/**/*.cpp
Glob: **/vendor/**/*.[ch] / **/vendor/**/*.cpp
Glob: **/extern/**/*.[ch] / **/extern/**/*.cpp
Glob: **/deps/**/*.[ch] / **/deps/**/*.cpp
Glob: **/lib/**/*.[ch]    ← 需区分项目自身代码和第三方代码
```

对于内嵌的第三方库，需要识别库名和版本：
- 搜索版本宏定义：`#define.*VERSION`、`#define.*MAJOR`
- 搜索版权声明和许可证头部
- 搜索 CHANGES/CHANGELOG/NEWS 文件

### 1.3 Git 子模块

```
Glob: .gitmodules
Glob: **/.git    ← 子模块目录
```

## 2. 高危组件速查表

### 2.1 已知 CVE 漏洞组件

| 组件 | 危险版本 | CVE | 漏洞类型 |
|------|----------|-----|----------|
| OpenSSL | < 1.1.1w / < 3.0.12 / < 3.1.4 | 多个 CVE | 缓冲区溢出/信息泄露/DoS |
| OpenSSL | 3.0.0-3.0.6 | CVE-2022-3602/3786 | X.509 缓冲区溢出 |
| libxml2 | < 2.10.4 | 多个 CVE | XXE/缓冲区溢出/UAF |
| expat | < 2.5.0 | CVE-2022-25235 等 | 整数溢出/缓冲区溢出 |
| zlib | < 1.2.13 | CVE-2022-37434 | 堆缓冲区溢出 |
| curl/libcurl | < 8.4.0 | 多个 CVE | SSRF/缓冲区溢出/信息泄露 |
| sqlite3 | < 3.43.2 | 多个 CVE | 缓冲区溢出/类型混淆 |
| libpng | < 1.6.40 | 多个 CVE | 缓冲区溢出/整数溢出 |
| libjpeg/libjpeg-turbo | < 3.0.1 | 多个 CVE | 缓冲区溢出 |
| protobuf-c | < 1.4.1 | CVE-2022-33070 | 整数溢出 |
| cJSON | < 1.7.16 | CVE-2023-50471/50472 | 空指针解引用/段错误 |
| libssh/libssh2 | < 0.10.6 / < 1.11.0 | 多个 CVE | 认证绕过/缓冲区溢出 |
| gRPC | < 1.56.2 | 多个 CVE | DoS/信息泄露 |
| mbedTLS | < 3.5.1 | 多个 CVE | 侧信道/缓冲区溢出 |
| wolfSSL | < 5.6.4 | 多个 CVE | 缓冲区溢出/侧信道 |
| libevent | < 2.1.12 | CVE-2016-10195 等 | 缓冲区溢出/整数溢出 |
| jansson | < 2.14 | CVE-2020-36325 | 哈希碰撞 DoS |
| pcre/pcre2 | < 10.42 | 多个 CVE | 缓冲区溢出/ReDoS |
| libpq (PostgreSQL) | < 16.1 | 多个 CVE | SQL 注入/缓冲区溢出 |
| hiredis | < 1.1.0 | CVE-2021-32765 | 整数溢出/缓冲区溢出 |

### 2.2 搜索方法

在构建文件和源码中搜索依赖引用：
```
Grep (在 CMakeLists.txt/Makefile/conanfile/vcpkg.json 中):
  find_package\((OpenSSL|ZLIB|CURL|LibXml2|EXPAT|SQLite3|Protobuf|PNG|JPEG)
  pkg_check_modules\(.*openssl|pkg_check_modules\(.*libxml|pkg_check_modules\(.*libcurl
  -l(ssl|crypto|xml2|expat|z|curl|sqlite3|png|jpeg|pcre|event|hiredis|pq)
```

在源码中搜索版本宏：
```
Grep: #define\s+(OPENSSL_VERSION|ZLIB_VERSION|CURL_VERSION|LIBXML_VERSION|SQLITE_VERSION|PCRE2_MAJOR)
Grep: #define\s+\w+_VERSION_MAJOR|#define\s+\w+_VERSION_STRING
```

然后提取版本号，与上表比对。

## 3. 内嵌第三方代码审计

### 3.1 版本识别

**搜索**:
```
Grep (在 third_party/vendor/extern/deps 目录中):
  #define.*VERSION|version\s*=|Version:
  Copyright|LICENSE|COPYING
```

### 3.2 修改检测

检查内嵌的第三方代码是否被项目修改过：
- 是否有 `.patch` 文件或 `patches/` 目录
- 源码中是否有 `// MODIFIED` 或 `/* CUSTOM */` 等标记
- 修改可能引入新的安全问题或阻止安全更新

### 3.3 过时检测

对于内嵌的第三方库：
- 对比当前版本与最新稳定版
- 检查是否有已知 CVE 影响当前版本
- 评估更新的难度和风险

## 4. 供应链风险评估

### 4.1 废弃/无人维护的依赖

标记以下情况:
- 最后发布时间超过 2 年的库
- 已被官方标记为 EOL 的版本
- 已有官方替代品的旧库（如 `OpenSSL 1.0.x` → `OpenSSL 3.x`）

### 4.2 构建系统安全

**搜索**:
```
Grep: curl.*\|.*sh|wget.*\|.*sh|curl.*\|.*bash    ← 从网络下载并执行脚本
Grep: FetchContent_Declare\(.*GIT_REPOSITORY       ← CMake 运行时拉取代码
Grep: ExternalProject_Add\(.*URL                    ← CMake 外部项目
```

检查：
- 下载的依赖是否验证了校验和/签名
- FetchContent 是否固定了 GIT_TAG（而非 master/main）
- 是否使用了 HTTPS 而非 HTTP 下载

### 4.3 链接库安全

**搜索**:
```
Grep: -Wl,-rpath|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH
Grep: dlopen\(|LoadLibrary\(
```

检查：
- 是否使用了相对 rpath（可能被劫持）
- `dlopen()` 的路径是否用户可控
- 是否依赖了 `LD_LIBRARY_PATH`（不安全的库搜索路径）

## 5. 输出格式

每个发现包含：
```
- 依赖: 库名
- 当前版本: x.y.z
- 受影响版本: < a.b.c
- CVE: CVE-XXXX-XXXXX
- 漏洞类型: [缓冲区溢出/整数溢出/UAF/信息泄露/DoS/...]
- 严重程度: [Critical/High/Medium/Low]
- 修复建议: 升级到 >= a.b.c
- 参考链接: NVD/GitHub Advisory URL
```