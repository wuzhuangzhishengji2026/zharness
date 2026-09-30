#!/usr/bin/env node
/**
 * replay-summary skill (ZHarness) — session events → compact trajectory draft.
 *
 * Reads ONE ZHarness session from the workspace SQLite event store
 * (<agentDir>/workspaces/<workspace_id>/events.sqlite) and prints a condensed,
 * human-skimable draft:
 *   - session identity (id / name / workspace / createdAt)
 *   - user requests
 *   - per-turn rows: tool calls (+ outcome) and assistant text (thinking omitted)
 *   - end-of-session stats (turns/tool histogram, errors)
 *   - candidate artifact file paths (for building artifacts/)
 *   - the replay output directory to write replay-summary.json into
 *
 * Usage:
 *   node extract-log.mjs --cwd <workspaceDir> [--session <sessionId>] [options]
 *   node extract-log.mjs --db <events.sqlite路径> [--session <sessionId>] [options]
 *
 * Options: --agent-dir <dir>  ZHarness agent dir (default: ZHARNESS_CODING_AGENT_DIR
 *                             env, else ~/.zharness/agent)
 *          --max-events N     cap events read (default 4000)
 *          --text N           per-row text cap (default 220)
 *          --no-paths         skip candidate path section
 *
 * Requires Node.js >= 22.5 (node:sqlite). Nothing is written anywhere.
 *
 * @module replay-summary/scripts/extract-log
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function fail(msg) {
  console.error(`[extract-log] ${msg}`)
  process.exit(1)
}

function defaultAgentDir() {
  const envDir = process.env.ZHARNESS_CODING_AGENT_DIR
  if (envDir && envDir.length > 0) {
    if (envDir === '~') return homedir()
    if (envDir.startsWith('~/')) return homedir() + envDir.slice(1)
    return envDir
  }
  return join(homedir(), '.zharness', 'agent')
}

/** workspace_id = ws_<sha256(canonical cwd) 前 12 位>（与 ZHarness 内核一致） */
function deriveWorkspaceId(cwd) {
  const canonical = resolve(cwd).replace(/\\/g, '/')
  return `ws_${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`
}

function parseArgs(argv) {
  const out = { cwd: null, db: null, session: null, agentDir: null, maxEvents: 4000, text: 220, paths: true }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--db') out.db = argv[++i]
    else if (a === '--session') out.session = argv[++i]
    else if (a === '--agent-dir') out.agentDir = argv[++i]
    else if (a === '--max-events') out.maxEvents = Number(argv[++i])
    else if (a === '--text') out.text = Number(argv[++i])
    else if (a === '--no-paths') out.paths = false
    else fail(`unknown option ${a}`)
  }
  if (!out.cwd && !out.db) fail('usage: node extract-log.mjs --cwd <workspaceDir> | --db <events.sqlite> [--session <id>] [options]')
  return out
}

async function openDb(dbPath) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    fail('node:sqlite 不可用：请用 Node.js >= 22.5 运行本脚本（node --version 检查）')
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    fail(`无法打开事件库 ${dbPath}: ${error.message}`)
  }
}

/** sessions 表行 → 事件区间（start/end event_id 转 sequence 边界）。 */
function resolveRange(db, session) {
  let afterSeq = null
  let beforeSeq = null
  if (session.start_event_id && session.start_event_id !== 'ORIGIN') {
    const row = db.prepare('select sequence from events where event_id = ?').get(session.start_event_id)
    if (row) afterSeq = row.sequence
  }
  if (session.end_event_id && session.end_event_id !== 'HEAD') {
    const row = db.prepare('select sequence from events where event_id = ?').get(session.end_event_id)
    if (row) beforeSeq = row.sequence
  }
  return { afterSeq, beforeSeq }
}

function loadEvents(db, range, maxEvents) {
  const clauses = []
  const params = []
  if (range.afterSeq !== null) { clauses.push('sequence > ?'); params.push(range.afterSeq) }
  if (range.beforeSeq !== null) { clauses.push('sequence <= ?'); params.push(range.beforeSeq) }
  const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''
  const rows = db
    .prepare(`select sequence, event_id, timestamp, type, payload_json from events ${where} order by sequence asc limit ?`)
    .all(...params, maxEvents)
  const events = []
  for (const row of rows) {
    let payload = null
    try { payload = JSON.parse(row.payload_json) } catch { /* skip corrupt payload */ }
    events.push({ seq: row.sequence, id: row.event_id, time: row.timestamp, type: row.type, data: payload })
  }
  return events
}

/** Extract plain text out of a content[] array (skip thinking). */
function contentText(content, limit) {
  if (typeof content === 'string') {
    const t = content.replace(/\s+/g, ' ').trim()
    return t.length > limit ? `${t.slice(0, limit)}…` : t
  }
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const c of content) {
    if (c === null || typeof c !== 'object') continue
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
  }
  const joined = parts.join('\n').replace(/\s+/g, ' ').trim()
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined
}

function compactArgs(args, limit) {
  if (args === undefined || args === null) return ''
  let str
  if (typeof args === 'string') str = args
  else {
    try { str = JSON.stringify(args) } catch { str = String(args) }
  }
  str = str.replace(/\s+/g, ' ').trim()
  return str.length > limit ? `${str.slice(0, limit)}…` : str
}

const PATH_RE = /(?:^|["'\s([{,<])((?:\/[\w@.\-]+)+\.(?:md|markdown|diff|patch|log|html?|txt|jsonc?|ya?ml|toml|csv|png|jpe?g|webp|gif|pdf|zip|js|ts|jsx|tsx|css|cs|java|cpp|c|h|py|go|rs|sh|ps1|bat|sql))(?:["'\s)\]},>]|$)/g
const WIN_PATH_RE = /(?:^|["'\s([{,<])(([A-Za-z]:\\(?:[\w@.\-]+\\?)+)\.(?:md|markdown|diff|patch|log|html?|txt|jsonc?|ya?ml|toml|csv|png|jpe?g|webp|gif|pdf|zip|js|ts|jsx|tsx|css|cs|java|cpp|c|h|py|go|rs|sh|ps1|bat|sql))(?:["'\s)\]},>]|$)/g

/** Heuristic candidate artifact paths seen across the session. */
function candidatePaths(events, cwd, limit, fileMutationPaths) {
  const seen = new Map()
  const bump = p => { seen.set(p, (seen.get(p) ?? 0) + 1) }
  for (const p of fileMutationPaths) bump(p)
  const sniff = str => {
    if (typeof str !== 'string') return
    for (const re of [PATH_RE, WIN_PATH_RE]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(str)) !== null) {
        const p = m[1]
        if (!p.includes('/') && !p.includes('\\')) continue
        if (cwd && p.startsWith(cwd)) { bump(p); continue }
        if (p.includes('/node_modules/') || p.includes('\\node_modules\\') || p.includes('/.git/') || p.includes('\\.git\\')) continue
        if (p.startsWith('/Users/') || p.startsWith('/private/')) continue
        if (p.startsWith('.')) continue
        bump(p)
      }
    }
  }
  for (const e of events) {
    const d = e.data
    if (d === null || typeof d !== 'object') continue
    if (d.arguments !== undefined) sniff(typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments))
    sniff(JSON.stringify(d).slice(0, 20000))
  }
  const ranked = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
  return ranked.slice(0, limit)
}

const SYSTEM_HINTS = [
  'Current runtime context',
  '<system-reminder>',
  'The approval policy changed',
  '<goal_round>',
  '<available_skills>',
  '<user_input>',
]

function looksSystemish(text) {
  return SYSTEM_HINTS.some(h => text.startsWith(h) || text.includes(h))
}

const pad = (s, n) => String(s).padStart(n)

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const agentDir = opts.agentDir ? resolve(opts.agentDir) : defaultAgentDir()
  let dbPath = opts.db ? resolve(opts.db) : null
  let workspaceId = null
  let workspaceCwd = opts.cwd ? resolve(opts.cwd) : null
  if (workspaceCwd) {
    workspaceId = deriveWorkspaceId(workspaceCwd)
    if (dbPath === null) dbPath = join(agentDir, 'workspaces', workspaceId, 'events.sqlite')
  }
  if (!existsSync(dbPath)) fail(`事件库不存在: ${dbPath}`)
  if (workspaceId === null) {
    // --db 模式：从路径 …/workspaces/<ws_id>/events.sqlite 反推
    const m = dbPath.replace(/\\/g, '/').match(/\/workspaces\/(ws_[0-9a-f]+)\/events\.sqlite$/)
    workspaceId = m ? m[1] : null
  }

  const db = await openDb(dbPath)

  // ---- pick session ----
  let sessions = []
  try {
    sessions = db.prepare('select session_id, name, created_at, start_event_id, end_event_id from sessions order by created_at desc').all()
  } catch { /* sessions table missing → treat whole db as one session */ }

  let session = null
  if (opts.session) {
    session = sessions.find(s => s.session_id === opts.session) ?? null
    if (!session) fail(`sessions 表中找不到 session: ${opts.session}（共 ${sessions.length} 个）`)
  } else if (sessions.length > 0) {
    session = sessions[0] // 最近一个
  }

  const range = session ? resolveRange(db, session) : { afterSeq: null, beforeSeq: null }
  const events = loadEvents(db, range, opts.maxEvents)
  const sessionId = session ? session.session_id : '(whole-db)'
  const fmtTime = t => (Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) : '')

  const userAsks = []
  const rows = [] // {seq, turn, time, kind, text}
  const toolCount = new Map()
  const toolEnds = new Map() // tool_call_id → { is_error, duration_ms }
  const turnEnds = []
  const fileMutationPaths = []
  let turnNo = 0
  let toolFail = 0

  for (const e of events) {
    const t = e.type
    const d = e.data
    if (t === 'AGENT_TURN_START') { turnNo += 1; continue }
    if (t === 'USER_MESSAGE') {
      const text = contentText(d?.content, 240)
      if (text.length > 0 && !looksSystemish(text) && userAsks[userAsks.length - 1] !== text) userAsks.push(text)
      continue
    }
    if (t === 'USER_INTERRUPT') { rows.push({ seq: e.seq, turn: turnNo, time: fmtTime(e.time), kind: 'assistant', text: '[用户打断]' }); continue }
    if (t === 'TOOL_EXECUTION_START') {
      const name = d?.tool_name ?? '?'
      toolCount.set(name, (toolCount.get(name) ?? 0) + 1)
      rows.push({ seq: e.seq, turn: turnNo, time: fmtTime(e.time), kind: 'tool', callId: d?.tool_call_id, text: `${name} ${compactArgs(d?.arguments, 160)}` })
      continue
    }
    if (t === 'TOOL_EXECUTION_END') {
      if (d?.tool_call_id) toolEnds.set(d.tool_call_id, { is_error: d.is_error === true, duration_ms: d.duration_ms })
      if (d?.is_error === true) toolFail += 1
      continue
    }
    if (t === 'AGENT_MESSAGE_END') {
      const text = contentText(d?.content, opts.text)
      if (text.length > 0) rows.push({ seq: e.seq, turn: turnNo, time: fmtTime(e.time), kind: 'assistant', text })
      if (d?.stop_reason === 'error') rows.push({ seq: e.seq, turn: turnNo, time: fmtTime(e.time), kind: 'assistant', text: `[模型出错] ${d?.error_message ?? ''}` })
      continue
    }
    if (t === 'BASH_EXECUTION' || t === 'COMMAND_EXECUTED') {
      const cmd = compactArgs(d?.command, 120)
      const exit = d?.exit_code
      rows.push({ seq: e.seq, turn: turnNo, time: fmtTime(e.time), kind: 'tool', text: `$ ${cmd}${Number.isFinite(exit) ? `  (exit ${exit})` : ''}` })
      continue
    }
    if (t === 'FILE_MUTATION_APPLIED') {
      const p = d?.path ?? d?.mutation?.path
      if (typeof p === 'string' && p.length > 0) fileMutationPaths.push(p)
      continue
    }
    if (t === 'AGENT_TURN_COMPLETED') turnEnds.push(d?.reason ?? '?')
    if (t === 'COMPACTION_END') rows.push({ seq: e.seq, turn: turnNo, time: fmtTime(e.time), kind: 'assistant', text: '[上下文压缩]' })
    // 其余事件（chunks/intent/模型切换等）有意跳过
  }

  // 把 TOOL_EXECUTION_END 的结果回填到对应 start 行
  for (const r of rows) {
    if (r.kind !== 'tool' || !r.callId) continue
    const end = toolEnds.get(r.callId)
    if (!end) continue
    r.text += end.is_error ? '  ✗ failed' : '  ✓'
    if (Number.isFinite(end.duration_ms)) r.text += ` (${Math.round(end.duration_ms / 100) / 10}s)`
  }

  // ---- replay output dir ----
  let replayDir = null
  if (workspaceId && session) {
    replayDir = join(agentDir, 'workspaces', workspaceId, 'replay', session.session_id)
  }

  // -------- print --------
  console.log('── session ──────────────────────────────────────────────')
  console.log(`id       : ${sessionId}`)
  if (session?.name) console.log(`name     : ${session.name}`)
  console.log(`db       : ${dbPath}`)
  if (workspaceId) console.log(`workspace: ${workspaceId}`)
  if (workspaceCwd) console.log(`cwd      : ${workspaceCwd}`)
  console.log(`created  : ${Number.isFinite(session?.created_at) ? new Date(session.created_at).toISOString() : '?'}`)
  if (replayDir) console.log(`replaydir: ${replayDir}   ← replay-summary.json 与 artifacts/ 写到这个目录`)
  if (!opts.session && sessions.length > 1) {
    console.log(`\n(未指定 --session，已选最新会话；全部 ${sessions.length} 个会话：)`)
    for (const s of sessions.slice(0, 20)) {
      console.log(`  ${s.session_id}  ${s.name ?? ''}  ${Number.isFinite(s.created_at) ? new Date(s.created_at).toISOString().slice(0, 16) : ''}`)
    }
    console.log('  需要其他会话时重跑：--session <id>')
  }

  console.log('\n── user requests ───────────────────────────────────────')
  userAsks.forEach((u, i) => console.log(`[${i + 1}] ${u}`))

  console.log('\n── trajectory (turn) ───────────────────────────────────')
  if (rows.length === 0) console.log('(no tool/assistant rows within the event window)')
  for (const r of rows) {
    console.log(`${pad(r.turn > 0 ? r.turn : '', 4)} ${r.time ? `[${r.time}] ` : ''}${r.kind === 'tool' ? '⚙ ' : '💬 '}${r.text}`)
  }

  console.log('\n── end state ───────────────────────────────────────────')
  console.log(`events: ${events.length} | rows: ${rows.length} | turns: ${turnNo} | turn ends: ${turnEnds.join(', ') || '?'} | tool errors: ${toolFail}`)
  console.log(`tool histogram: ${[...toolCount.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)

  if (opts.paths) {
    console.log('\n── candidate artifact paths (verify & filter) ───────────')
    for (const p of candidatePaths(events, workspaceCwd, 60, fileMutationPaths)) console.log(p)
  }
  console.log('\n(tip) 用 SKILL.md 的 references/phase-templates.md 把上面内容组织为 phases/timeline；')
  console.log('       真实产物文件从工作区复制到 <replaydir>/artifacts/ 后引用。')
  db.close()
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
