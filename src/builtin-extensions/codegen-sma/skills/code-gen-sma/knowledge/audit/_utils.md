# 审计知识库共享工具

## 共享数据结构

### Finding 结构

```json
{
  "id": "VULN-001",
  "title": "漏洞标题",
  "severity": "critical|high|medium|low|info",
  "cwe_id": "CWE-89",
  "category": "漏洞分类",
  "file_path": "path/to/file",
  "line_start": 42,
  "line_end": 45,
  "description": "漏洞描述",
  "data_flow": "数据流向",
  "code_snippet": "代码片段",
  "remediation": "修复建议",
  "confidence": "high|medium|low",
  "reviewed": false,
  "review_status": "pending|confirmed|false_positive|needs_investigation",
  "review_detail": ""
}
```

### 严重程度中文映射

| 英文 | 中文 |
|------|------|
| critical | 致命 |
| high | 高危 |
| medium | 中危 |
| low | 低危 |
| info | 信息 |

### 过滤跳过目录

- node_modules
- target
- .git
- build
- dist
- .idea
- .vscode
- test/
- tests/
- t/