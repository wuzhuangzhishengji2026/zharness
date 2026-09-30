---
name: api-map
description: 让 API 对 Agent 自我描述(Agentic API 规范):把存量 REST API 改造成 data/error/relates 三段响应并生成 /api/llms.txt 发现入口,或按"地图"方式渐进发现与调用这类 API。当用户提到 API 改造、llms.txt、面向 Agent 的 API 设计、API map 时使用。
---

# API Map — Let APIs Speak for Themselves

> Adapted from the Agentic API Spec by tomsun28
> (https://github.com/tomsun28/agentic-api-spec, skill `agentic-api-transformer`).

An API following this spec is a **map**: `GET /api/llms.txt` is the map index
(top-level operations the current user may call), and every response's
`relates` field is turn-by-turn navigation from where the caller currently
stands. The agent never memorizes the whole documentation — it reads the map
once, then lets each response tell it what is reachable next.

**Use this skill when the user wants to:**
- Convert existing REST APIs to the agent-friendly Agentic API format
- Add `relates` fields to API responses for progressive disclosure
- Generate `/api/llms.txt` entry points for API discovery
- Drive/consume an API that already follows this spec
- Validate API compliance with the Agentic API specification

## Core Concepts

Every business API response carries three fields:

- `data` — the current business state (truth, not documentation).
- `error` — a feedback channel with **stable error codes** (`TASK_LOCKED`,
  `INVALID_PARAM`, …) the agent can branch on, instead of parsing prose.
- `relates` — the next-step navigation: related callable APIs with
  `method`, `path`, `desc`, and a `schema` (TypeChat-style TS type literal).

Cold start is solved by one discovery endpoint, `GET /api/llms.txt`, which
returns the top-level operations available to the current user plus a short
system description — nothing else.

Compared with a static Skill document, this delivers capabilities **based on
the current data state** (dynamic, not memorized), keeps token cost at one
`llms.txt` fetch plus on-demand `relates`, and survives backend refactors —
if a path or parameter changes, the agent adapts because the map is re-read
from live responses, not from a stale client-side document.

## Workflow A — Transform an Existing API (Server Side)

### 1. Analyze the existing API
- Parse OpenAPI/Swagger specs if available; otherwise ask for endpoint docs or
  an endpoint list (do not guess endpoints).
- Identify CRUD operations, resource hierarchies and dependencies.
- Extract parameter shapes into TypeChat schemas (TS interface/type literals).

### 2. Transform responses (wrap, never rewrite)
- Add the three core fields: `data`, `error`, `relates`.
- Standardize error codes — stable, documented constants, not free text.
- Generate `relates` from the resource graph (see the reference section).
- Implement as middleware/interceptors so existing business logic is preserved.
  Read-only analysis and generated files are safe; modifying the user's source
  code requires explicit user confirmation first.

### 3. Generate the entry point
- Create `GET /api/llms.txt` listing top-level operations for the current
  user, each with `desc` and `schema`, plus a short usage/auth guide.
- Mind the exposure granularity: the map shows what this user may do, not
  everything the system can do.

### 4. Generate framework code
- Detect the backend framework (Express, FastAPI, Spring Boot, Gin, …) from
  the codebase; if undetectable, ask the user.
- Generate middleware for response wrapping, controller/route examples, and
  dependency install commands for the detected stack.

### 5. Validate compliance
- All responses include `data`, `error`, `relates`.
- Every `relates` entry has `method`, `path`, `desc`, `schema`.
- Error codes are stable and documented.
- Report results with concrete fixes; run the API's own test suite if present.

## Workflow B — Consume an Agentic API (Agent Side)

1. `GET {base_url}/api/llms.txt` to load the map index. Plan from it.
2. Call an entry API with real parameters. Read `data` for state, branch on
   stable `error.code` when present.
3. Choose the next call from the response's `relates` — match `desc` against
   the goal, fill parameters per its `schema`. Never invent endpoints that no
   response or the map offered.
4. Stop when no `relates` entry moves toward the goal; report what the map
   did not cover instead of probing blindly.

## Output Format (after a transformation)

- **Analysis summary**: endpoints analyzed, resource relationships,
  required transformations.
- **Generated code**: middleware for the detected framework, one example
  transformed response, the `/api/llms.txt` content.
- **Validation results**: pass/fail per rule, issues with file/line
  references, recommendations.
- **Next steps**: install commands, integration instructions, test commands.

## Rules

### Critical requirements
- **Always preserve business logic** — wrap responses, never rewrite handlers.
- **Validate before declaring done** — run compliance checks on all
  transformed endpoints.
- **Stable error codes** — `TASK_LOCKED`, not generic messages.
- **Complete relates** — every entry has `method`, `path`, `desc`, `schema`.

### Best practices
- Analyze before editing; transform key endpoints first, then expand.
- Auto-detect the framework from the codebase; ask when ambiguous.
- Generate clear integration instructions for the developers.

### Error handling
- No OpenAPI spec → ask for API docs or an endpoint list.
- Framework undetectable → ask the user which stack they use.
- Validation failure → provide specific fixes with code examples.
- Missing dependencies → provide install commands.

### Security
- Never expose API keys or credentials in generated code.
- Warn if `relates` expose sensitive operations without auth checks.
- Flag hardcoded secrets in validation reports.

## Reference: Response Structure

```json
{
  "data": {},
  "error": { "code": "STABLE_ERROR_CODE", "message": "Human-readable message" },
  "relates": [
    {
      "method": "GET|POST|PUT|DELETE",
      "path": "/path/to/resource",
      "desc": "Brief description of intent and parameters",
      "schema": "type Schema = { param: string; }"
    }
  ]
}
```

## Reference: /api/llms.txt Format

```markdown
# Project Name

Project description, usage guide, and authentication info.

## Entry APIs

### POST /tasks
desc: Create a new task with specified priority
schema: interface CreateTask { title: string; priority: 'low' | 'medium' | 'high'; }

### GET /tasks
desc: List all tasks with pagination
schema: interface ListTasks { page?: number; limit?: number; }
```

## Reference: Middleware Examples

```javascript
// Express.js — wrap every JSON response with the envelope
app.use((req, res, next) => {
  const originalSend = res.send;
  res.send = function (data) {
    const transformed = {
      data: data,
      error: null,
      relates: generateRelates(req.path, req.method),
    };
    originalSend.call(this, transformed);
  };
  next();
});
```

```python
# FastAPI — same envelope via middleware
from fastapi import Request
import json

async def agentic_middleware(request: Request, call_next):
    response = await call_next(request)
    if response.headers.get("content-type", "").startswith("application/json"):
        data = json.loads(response.body)
        transformed = {
            "data": data,
            "error": None,
            "relates": generate_relates(request.url.path, request.method),
        }
        response.body = json.dumps(transformed).encode()
    return response
```

Similar patterns apply to Spring Boot, Go/Gin, and other frameworks.

## Troubleshooting

- **Missing relates** — resource relationship mapping is incomplete; fix the
  relates generation logic so every reachable next step is offered.
- **Invalid TypeChat schemas** — use TS interface/type syntax; keep them
  parseable.
- **Validation errors** — review the report; fix missing fields and unstable
  error codes.

## Advanced: Conditional Relates

For workflows with state-dependent next steps, compute `relates` from current
resource state, user permissions, and workflow stage:

```text
if current_state == 'pending' and user.can_approve:
    relates.append({
        'method': 'POST',
        'path': '/approvals',
        'desc': 'Approve pending request',
        'schema': 'type Approve = { request_id: string; }'
    })
```
