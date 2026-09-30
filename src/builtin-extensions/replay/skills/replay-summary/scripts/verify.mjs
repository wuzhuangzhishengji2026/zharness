#!/usr/bin/env node
/**
 * replay-summary skill — verify a generated replay-summary.json in place.
 *
 * Usage:
 *   node verify.mjs <回放目录>
 *
 * Checks (see SKILL.md §9 quality gates), schema 2.0:
 *   - JSON parses, UTF-8 intact, schemaVersion "2.0"
 *   - phases / timeline well-formed; every timeline[].phaseId resolves
 *   - run type ∈ normal|rollback|reentry
 *   - step status ∈ success|confirmed|failed; artifacts ≤3, metrics ≤4 per run
 *   - every steps[].artifactIds[] reference resolves within the same run
 *     (no orphans, no dangles)
 *   - every non-empty artifact path stays inside the replay dir and exists
 *   - actualDuration > 0 when set
 *
 * Exit code 0 = OK (warnings allowed), 1 = errors found.
 *
 * @module replay-summary/scripts/verify
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

function fail(msg) {
  console.error(`[verify] ${msg}`)
  process.exit(1)
}

const arg = process.argv[2]
if (!arg) fail('usage: node verify.mjs <回放目录>')
const dir = resolve(arg)

const file = join(dir, 'replay-summary.json')
let raw
try {
  raw = readFileSync(file, 'utf8')
} catch {
  fail(`replay-summary.json not found in ${dir}`)
}

if (raw.includes('�')) {
  fail('文件包含替换符 U+FFFD，疑似非 UTF-8 编码问题')
}

let summary
try {
  summary = JSON.parse(raw)
} catch (error) {
  fail(`JSON 解析失败: ${error.message}`)
}

const errors = []
const warnings = []
/** hard failure when `ok` is false */
const err = (ok, msg) => { if (!ok) errors.push(msg) }
/** soft warning when `ok` is false */
const warn = (ok, msg) => { if (!ok) warnings.push(msg) }

// ---- shape ----
err(typeof summary === 'object' && summary !== null, 'summary 必须是 JSON 对象')
if (typeof summary !== 'object' || summary === null) fail('无法继续：顶层不是对象')

warn(summary.schemaVersion === '2.0',
  `schemaVersion 应为 "2.0"（当前 ${JSON.stringify(summary.schemaVersion)}）——旧版 schema 1.x 已不兼容「回放」`)
err(typeof summary.task?.name === 'string' && summary.task.name.length > 0, 'task.name 必填')
warn(typeof summary.task?.result === 'string' && summary.task.result.length > 0, 'task.result 建议为字符串徽标（completed/failed 等）')

// conversationId ↔ dir name（回放目录名即 sessionId）
const dirName = basename(dir)
if (typeof summary.conversationId === 'string' && summary.conversationId.length > 0) {
  warn(summary.conversationId === dirName,
    `conversationId (${summary.conversationId}) 与回放目录名 (${dirName}) 不一致，建议一致便于追溯`)
}

// ---- phases ----
const phases = Array.isArray(summary.phases) ? summary.phases : []
err(phases.length > 0, 'phases 至少 1 个')
const phaseIds = new Set()
for (let i = 0; i < phases.length; i += 1) {
  const p = phases[i]
  const tag = `phases[${i}]`
  err(p !== null && typeof p === 'object', `${tag} 必须是对象`)
  if (p === null || typeof p !== 'object') continue
  err(typeof p.id === 'string' && p.id.length > 0, `${tag}.id 必填`)
  if (typeof p.id === 'string' && p.id.length > 0) {
    if (phaseIds.has(p.id)) err(false, `phase id 重复: ${p.id}`)
    phaseIds.add(p.id)
  }
  err(typeof p.name === 'string' && p.name.length > 0, `${tag}.name 必填`)
  if (p.actualDuration !== undefined) {
    warn(Number.isFinite(p.actualDuration) && p.actualDuration > 0,
      `${tag}.actualDuration 建议为正数毫秒（当前 ${JSON.stringify(p.actualDuration)}）——等于该阶段所有轮次真实耗时之和`)
  }
}

// ---- timeline ----
const timeline = Array.isArray(summary.timeline) ? summary.timeline : []
err(timeline.length > 0, 'timeline 至少 1 轮（暂无可回放过程）')
const TYPES = new Set(['normal', 'rollback', 'reentry'])
const STATUSES = new Set(['success', 'confirmed', 'failed'])
let runCount = 0
let stepCount = 0
const allArtifactIds = new Set()
const referenced = new Set()
for (let i = 0; i < timeline.length; i += 1) {
  const r = timeline[i]
  const tag = `timeline[${i}]`
  runCount += 1
  err(r !== null && typeof r === 'object', `${tag} 必须是对象`)
  if (r === null || typeof r !== 'object') continue
  err(typeof r.phaseId === 'string' && phaseIds.has(r.phaseId),
    `${tag}.phaseId 必须能在 phases 中找到（当前 ${JSON.stringify(r.phaseId)}）`)
  warn(typeof r.type === 'string' && TYPES.has(r.type),
    `${tag}.type 应 ∈ normal/rollback/reentry（当前 ${JSON.stringify(r.type)}）`)
  if (r.type === 'rollback' || r.type === 'reentry') {
    warn(typeof r.transitionMessage === 'string' && r.transitionMessage.length > 0,
      `${tag}(${r.type}) 建议给 transitionMessage 提示语（如「测试发现3个问题，返回开发修改」）`)
  }
  // per-run artifacts & metrics caps
  const artifacts = Array.isArray(r.artifacts) ? r.artifacts : []
  warn(artifacts.length <= 3, `${tag}.artifacts 建议 ≤3（当前 ${artifacts.length}，前端最多展示 3 个核心产出）`)
  const metrics = Array.isArray(r.metrics) ? r.metrics : []
  warn(metrics.length <= 4, `${tag}.metrics 建议 ≤4（当前 ${metrics.length}，前端最多展示 4 项）`)

  // artifacts
  const runArtifactIds = new Set()
  for (let k = 0; k < artifacts.length; k += 1) {
    const a = artifacts[k]
    const at = `${tag}.artifacts[${k}]`
    err(a !== null && typeof a === 'object', `${at} 必须是对象`)
    if (a === null || typeof a !== 'object') continue
    err(typeof a.id === 'string' && a.id.length > 0, `${at}.id 必填`)
    if (typeof a.id === 'string' && a.id.length > 0) {
      if (runArtifactIds.has(a.id)) err(false, `${tag} 内 artifact id 重复: ${a.id}`)
      runArtifactIds.add(a.id)
      allArtifactIds.add(a.id)
    }
    err(typeof a.name === 'string' && a.name.length > 0, `${at}.name 必填`)
    warn(['document', 'code', 'diff', 'report', 'log', 'image', 'other'].includes(a.type),
      `${at}.type 建议 ∈ document/code/diff/report/log/image/other（当前 ${JSON.stringify(a.type)}）`)
  }

  // steps
  const steps = Array.isArray(r.steps) ? r.steps : []
  err(steps.length > 0, `${tag}.steps 非空（每轮需有步骤才有播放内容）`)
  for (let j = 0; j < steps.length; j += 1) {
    const s = steps[j]
    stepCount += 1
    const st = `${tag}.steps[${j}]`
    err(s !== null && typeof s === 'object', `${st} 必须是对象`)
    if (s === null || typeof s !== 'object') continue
    err(typeof s.name === 'string' && s.name.length > 0, `${st}.name 必填`)
    warn(typeof s.id === 'string' && s.id.length > 0, `${st}.id 建议非空`)
    if (s.status !== undefined) {
      err(typeof s.status === 'string' && STATUSES.has(s.status),
        `${st}.status 应为 success|confirmed|failed（当前 ${JSON.stringify(s.status)}；confirmed=人工确认，failed=失败）`)
    }
    if (s.replayDuration !== undefined) {
      warn(Number.isFinite(s.replayDuration) && s.replayDuration > 0,
        `${st}.replayDuration 应为正数毫秒（动画用，非真实耗时）`)
    }
    warn(Array.isArray(s.inputs) && Array.isArray(s.calls) && Array.isArray(s.outputs),
      `${st}.inputs/.calls/.outputs 建议为数组（可为空）`)
    if (!Array.isArray(s.artifactIds)) continue
    for (const id of s.artifactIds) {
      if (typeof id !== 'string') {
        err(false, `${st}.artifactIds 含非字符串 ${JSON.stringify(id)}`)
        continue
      }
      referenced.add(id)
      err(runArtifactIds.has(id), `${st}.artifactIds[${JSON.stringify(id)}] 必须能在本轮 artifacts 找到（回放右侧按轮展示，不跨轮引用）`)
    }
  }

  // metrics
  for (let k = 0; k < metrics.length; k += 1) {
    const m = metrics[k]
    const mt = `${tag}.metrics[${k}]`
    err(m !== null && typeof m === 'object' && typeof m.name === 'string' && m.name.length > 0 && m.value !== undefined && m.value !== '',
      `${mt} 需含 name 与非空 value`)
  }
}
err(runCount > 0, `执行轮次 ${runCount}，需 > 0 才有可播放内容`)
err(stepCount > 0, `步骤总数 ${stepCount}，需 > 0`)

// ---- path containment & existence (replay dir level; paths are relative to replay-summary.json) ----
const artifactsByPath = new Set()
const walkArtifacts = (arr, prefix) => {
  if (!Array.isArray(arr)) return
  for (const a of arr) {
    if (a === null || typeof a !== 'object') continue
    if (a.path === undefined || a.path === null || a.path === '') {
      warnings.push(`${prefix} 中 artifact ${JSON.stringify(a.id)} 未关联文件（path 为空）——卡片仍显示但点击提示不存在`)
      continue
    }
    err(typeof a.path === 'string', `${prefix} artifact ${JSON.stringify(a.id)}.path 必须是字符串`)
    if (typeof a.path !== 'string') continue
    artifactsByPath.add(a.path)
  }
}
timeline.forEach((r, i) => walkArtifacts(r?.artifacts, `timeline[${i}]`))

for (const rel of artifactsByPath) {
  if (rel !== 'artifacts' && !rel.startsWith('artifacts/')) {
    warnings.push(`artifact path 建议以 artifacts/ 开头（当前 ${rel}）`)
  }
  const target = resolve(dir, rel)
  const inside = target === dir || target.startsWith(dir + sep)
  err(inside, `artifact path 越出回放目录: ${rel}`)
  if (!inside) continue
  try {
    const st = statSync(target)
    if (rel.endsWith('/')) {
      err(st.isDirectory(), `artifact path 以 / 结尾但并非目录: ${rel}`)
    } else if (!st.isFile() && !st.isDirectory()) {
      err(false, `artifact path 既不是文件也不是目录: ${rel}`)
    }
  } catch {
    err(false, `artifact path 文件/目录不存在（卡片会保留但点击提示缺失）: ${rel}`)
  }
}

// ---- report ----
console.log(`\n校验报告 — ${file}`)
console.log(`phases: ${phases.length} | timeline runs: ${runCount} | steps: ${stepCount}`)
console.log(`错误 ${errors.length} 项，警告 ${warnings.length} 项`)
for (const e of errors) console.log(`  ✖ ${e}`)
for (const w of warnings) console.log(`  ⚠ ${w}`)
if (errors.length > 0) {
  console.log('\n[verify] FAILED —— 请按 SKILL.md §9 修正后重跑')
  process.exit(1)
}
console.log('[verify] OK —— 可在「回放」页中播放')
