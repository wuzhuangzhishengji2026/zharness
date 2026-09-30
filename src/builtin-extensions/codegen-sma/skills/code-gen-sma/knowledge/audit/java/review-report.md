# 阶段五：复核与报告生成（Java）

## 1. 漏洞复核与误报排除

对所有发现的漏洞进行二次验证，排除误报。

### 1.1 安全防护检查

| 安全防护 | 说明 | 误报可能 |
|----------|------|----------|
| MyBatis `#{}` 参数化 | SQL 注入 | 确认 Mapper XML 中使用 `#{}` 而非 `${}` |
| Spring `@RequestBody` + Jackson | XSS | JSON 响应通常不需要 HTML 编码 |
| Thymeleaf `th:text` | XSS | 自动 HTML 编码，只有 `th:utext` 不编码 |
| Spring Security CSRF Filter | CSRF | 确认未被 `csrf().disable()` 禁用 |
| PreparedStatement | SQL 注入 | `?` 参数化绑定安全 |
| JPA Criteria API | SQL 注入 | 类型安全的查询构建 |

### 1.2 全局过滤器/拦截器

检查是否存在全局安全过滤器：
```
Grep: implements Filter|extends OncePerRequestFilter|@WebFilter
Grep: implements HandlerInterceptor|extends HandlerInterceptorAdapter
Grep: @ControllerAdvice|@RestControllerAdvice
Grep: XssFilter|SqlInjectionFilter|XSSFilter|SqlFilter
```

如果存在 XSS/SQL 注入的全局过滤器，需要验证：
- 过滤器的覆盖范围是否完整
- 过滤规则是否足够严格
- 是否存在绕过路径

### 1.3 不可利用场景

以下情况可标记为误报：
- 参数经过类型转换（`@PathVariable` 为 `Integer` 类型，无法注入字符串）
- 参数在 Controller 层就被校验为合法枚举值（`Integer.parseInt` 后与枚举比较）
- 漏洞在测试代码中（`src/test/` 目录）
- 示例代码中的 API Key 标记为 info 级别
- 已废弃的代码（`@Deprecated` 注解），标记为 info

## 2. 严重程度判定标准

| 等级 | 条件 | 攻击效果 |
|------|------|----------|
| 致命（Critical） | 远程代码执行/权限提升 | 服务器完全控制 |
| 高危（High） | 信息泄露/认证绕过 | 绕过安全机制 |
| 中危（Medium） | 拒绝服务/资源耗尽 | 服务不可用 |
| 低危（Low） | 信息泄露（低风险） | 有限信息泄露 |
| 信息（Info） | 最佳实践建议 | 无直接风险 |

### 致命（Critical）判定条件:
- 远程 RCE（未认证可利用）
- 远程 SQL 注入（可读取敏感数据/执行命令）
- 未认证反序列化且有可用 gadget 链
- 未认证 JNDI 注入
- 未认证 Actuator heapdump/env 暴露

### 高危（High）判定条件:
- 认证后 RCE
- 认证后 SQL 注入
- 认证绕过/越权访问
- 未认证 SSRF 可访问内网
- 未认证 SSRF 可读文件
- 硬编码 JWT 密钥/高权限 Token/API Key
- 未认证文件上传可写 Web 目录

### 中危（Medium）判定条件:
- 存储型 XSS
- 未认证的路径遍历（文件读取）
- CSRF 影响关键操作
- 未限制的文件上传大小
- 不安全的加密算法（MD5/SHA1）
- 开放重定向
- 未认证的缓存攻击/资源耗尽

### 低危（Low）判定条件:
- 反射型 XSS（前后端分离场景）
- 信息泄露（调试信息暴露）
- 缺少安全头（如 HSTS）
- 不安全的 CORS 配置（无 credentials）
- 使用已废弃的安全 API

### 信息（Info）:
- 代码质量建议
- 安全最佳实践建议
- 废弃 API 使用
- 缺少安全头文件
- 已知 CVE 的依赖库（未确认受影响）

## 3. 漏洞报告格式

每个确认的漏洞使用以下格式：

```markdown
### [等级] 漏洞标题

- **严重程度**: Critical / High / Medium / Low / Info
- **漏洞类型**: SQL 注入 / 命令注入 / XSS / ...
- **CWE**: CWE-89 / CWE-78 / CWE-79 / ...
- **文件**: path/to/File.java:行号
- **方法**: className.methodName()

**漏洞描述**:
详细描述漏洞成因和影响

**数据流**:
Source: [外部输入来源 @RequestParam("name")]
  → [中间处理 service.process(name)]
  → Sink: [危险操作 statement.execute("SELECT * FROM users WHERE name='" + name + "'")]

**修复建议**:
具体的修复方案和代码示例

**验证状态**:
已确认 / 误报 / 待调查，附验证说明
```

## 4. 汇总报告

```markdown
## 审计汇总

### 统计
| 严重程度 | 数量 |
|----------|------|
| 致命 | x |
| 高危 | x |
| 中危 | x |
| 低危 | x |
| 信息 | x |

### 优先修复 Top 5
1. [漏洞标题]
2. [漏洞标题]
...

### 修复优先级建议
1. 立即修复所有致命和高危漏洞
2. 尽快修复中危漏洞
3. 计划修复低危和信息漏洞

### 整体安全评估
根据审计结果给出项目的整体安全评分和建议
```

## 5. 覆盖率检查

确保所有 `entry_points` 都被审计：

1. 对比侦察结果中的入口点列表
2. 确认每个入口点都被审计
3. 对遗漏的入口点进行补充审计（通过 Grep 搜索 Sink 补充）

覆盖率要求：`audited / total_entries >= 95%`

```json
{
  "coverage_report": {
    "total_entries": "来自 recon-result.json 的入口点总数",
    "audited": "已审计数",
    "skipped": "跳过数",
    "skipped_reasons": [
      {"entry": "文件:方法", "reason": "测试代码/已废弃/不可达"}
    ],
    "newly_discovered": [
      {"file": "新发现文件", "method": "方法名", "reason": "审计过程中发现的新入口点"}
    ]
  }
}
```

如果覆盖率不达标，需要重新审计遗漏的入口点直到达标。