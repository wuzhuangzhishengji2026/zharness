#!/usr/bin/env node
// build.mjs — compile wiki/*.md into a single-file HTML site (wiki/index.html)
// Usage: node wiki/build.mjs   (paths resolved relative to this file)
// Page list comes from wiki/pages.json: { "brand": "...", "pages": [{"file","nav","group"}] }
// No external dependencies. Mermaid renders via CDN at view time with graceful
// fallback to source blocks when offline.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WIKI = dirname(fileURLToPath(import.meta.url))

const CONFIG = JSON.parse(readFileSync(join(WIKI, 'pages.json'), 'utf8'))
const BRAND = CONFIG.brand || 'Wiki'
const PAGES = CONFIG.pages

const warnings = []

// GitHub-style slug: lowercase, whitespace -> '-', drop other punctuation entirely
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

function esc(s) {
  return s
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// file -> Map<headingSlug, domId>, pre-scanned so forward links resolve
const pageHeadings = new Map()

function resolveHref(href, ctxFile) {
  let hashPart = ''
  let filePart = href
  const h = href.indexOf('#')
  if (h >= 0) {
    filePart = href.slice(0, h)
    hashPart = href.slice(h + 1)
  }
  if (/^https?:\/\//i.test(filePart)) return { url: href, external: true }
  if (!hashPart && !filePart.endsWith('.md') && !href.startsWith('#')) {
    return { url: href, external: false }
  }
  if (filePart.endsWith('.md')) {
    const idx = PAGES.findIndex((p) => p.file === decodeURIComponent(filePart))
    if (idx < 0) {
      warnings.push(`[${ctxFile}] 链接目标未找到: ${href}`)
      return { url: '#', external: false }
    }
    if (hashPart) {
      const heads = pageHeadings.get(filePart)
      const slug = slugify(decodeURIComponent(hashPart))
      if (heads?.has(slug)) return { url: `#p${idx}-${slug}`, external: false }
      warnings.push(`[${ctxFile}] 锚点未命中，回退页首: ${href}`)
    }
    return { url: `#p${idx}`, external: false }
  }
  // in-page anchor (#slug)
  const slug = slugify(decodeURIComponent(hashPart))
  const heads = pageHeadings.get(ctxFile)
  if (heads?.has(slug)) return { url: `#p${PAGES.findIndex((p) => p.file === ctxFile)}-${slug}`, external: false }
  warnings.push(`[${ctxFile}] 锚点未命中: ${href}`)
  return { url: '#', external: false }
}

// ---------- inline ----------
function renderInline(src, ctx) {
  let out = ''
  let rest = src
  const CODE_RE = /(`+)([^`]+?)\1/
  const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/
  const AUTO_RE = /<(https?:\/\/[^>\s]+)>/
  while (rest.length) {
    const cands = [
      rest.match(CODE_RE) && { t: 'code', m: rest.match(CODE_RE) },
      rest.match(LINK_RE) && { t: 'link', m: rest.match(LINK_RE) },
      rest.match(AUTO_RE) && { t: 'auto', m: rest.match(AUTO_RE) },
    ].filter(Boolean)
    cands.sort((a, b) => a.m.index - b.m.index)
    const p = cands[0]
    if (!p) break
    out += renderEmphasis(rest.slice(0, p.m.index))
    if (p.t === 'code') {
      out += `<code>${esc(p.m[2])}</code>`
    } else if (p.t === 'link') {
      const label = p.m[1]
      const hrefRaw = p.m[2].replace(/\\([(|!)])/g, '$1')
      const { url, external } = resolveHref(hrefRaw, ctx.file)
      out += `<a href="${esc(url)}"${
        external ? ' target="_blank" rel="noopener noreferrer" class="ext"' : ''
      }>${renderEmphasis(label)}</a>`
    } else {
      // autolink <https://…>
      const raw = p.m[1]
      out += `<a href="${esc(raw)}" target="_blank" rel="noopener noreferrer" class="ext">${renderEmphasis(
        raw
      )}</a>`
    }
    rest = rest.slice(p.m.index + p.m[0].length)
  }
  return out + renderEmphasis(rest)
}

function renderEmphasis(src) {
  let out = ''
  let rest = src
  const BOLD_RE = /\*\*(.+?)\*\*/s
  const STRIKE_RE = /~~(.+?)~~/s
  const ITALIC_RE = /(^|[^*\w])\*([^*\n]+)\*(?!\*)/
  while (rest.length) {
    const cands = []
    const mb = rest.match(BOLD_RE)
    if (mb) cands.push({ t: 'b', start: mb.index, tok: mb[0], inner: mb[1] })
    const ms = rest.match(STRIKE_RE)
    if (ms) cands.push({ t: 's', start: ms.index, tok: ms[0], inner: ms[1] })
    const mi = rest.match(ITALIC_RE)
    if (mi)
      cands.push({
        t: 'i',
        start: mi.index + mi[1].length,
        tok: mi[0].slice(mi[1].length),
        inner: mi[2],
      })
    cands.sort((a, b) => a.start - b.start)
    const p = cands[0]
    if (!p) break
    out += esc(rest.slice(0, p.start))
    const tag = p.t === 'b' ? 'strong' : p.t === 's' ? 'del' : 'em'
    out += `<${tag}>${renderEmphasis(p.inner)}</${tag}>`
    rest = rest.slice(p.start + p.tok.length)
  }
  return out + esc(rest)
}

// ---------- table cells (protect code spans & escaped pipes) ----------
function parseTableCells(line) {
  const codes = []
  let s = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  s = s.replace(/(`+)([^`]+?)\1/g, (m) => {
    codes.push(m)
    return `${codes.length - 1}`
  })
  s = s.replace(/\\\|/g, '')
  return s
    .split('|')
    .map((c) =>
      c
        .replace(/(?:)/g, '|')
        .replace(/(\d+)/g, (_, i) => codes[Number(i)] ?? `\`${i}\``)
        .trim()
    )
}

function isTableSeparator(line) {
  const cells = parseTableCells(line)
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))
}

// ---------- lists ----------
function consumeList(lines, i, baseIndent, ctx) {
  const ordered = /\d/.test(lines[i].trim()[0])
  const items = []
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (!m || m[1].length < baseIndent) break
    if (m[1].length > baseIndent) {
      const sub = consumeList(lines, i, m[1].length, ctx)
      if (!items.length) break
      items[items.length - 1] += sub.html
      i = sub.next
      continue
    }
    if (/\d/.test(m[2][0]) !== ordered) break
    const parts = [m[3]]
    i++
    while (i < lines.length) {
      const l = lines[i]
      const nested = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
      if (nested) {
        if (nested[1].length > baseIndent) {
          const sub = consumeList(lines, i, nested[1].length, ctx)
          parts.push({ html: sub.html })
          i = sub.next
          continue
        }
        break
      }
      if (!l.trim()) {
        const cont =
          i + 1 < lines.length &&
          new RegExp(`^\\s{${baseIndent + 2},}\\S`).test(lines[i + 1]) &&
          !lines[i + 1].match(/^\s*(?:[-*+]|\d+[.)])\s/)
        if (cont) {
          parts.push('')
          i++
          continue
        }
        break
      }
      if (new RegExp(`^\\s{${baseIndent + 2},}\\S`).test(l)) {
        parts.push(l.trim())
        i++
        continue
      }
      break
    }
    let subHtml = ''
    let textLines = []
    for (const p of parts) {
      if (typeof p === 'object') subHtml += p.html
      else textLines.push(p)
    }
    let content = textLines.join('\n')
    let cb = ''
    const task = content.match(/^\[( |x|X)\]\s+(.*)$/s)
    if (task) {
      cb = `<input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> `
      content = task[2]
    }
    const paras = content.split('\n')
    let itemHtml =
      cb +
      paras
        .map((t) => (t ? `<p>${renderInline(t, ctx)}</p>` : ''))
        .join('')
        .replace(/<\/p><p>/g, '<br>')
    if (itemHtml.startsWith('<p>')) itemHtml = itemHtml.slice(3, -4)
    items.push(`<li>${itemHtml}${subHtml}</li>`)
  }
  return { html: `<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`, next: i }
}

// ---------- page renderer ----------
function renderPage(md, pageIndex) {
  const page = PAGES[pageIndex]
  const ctx = { file: page.file }
  const lines = md.split(/\r?\n/)
  const toc = []
  let body = ''
  let title = page.nav

  const paraBuf = []
  const flushPara = () => {
    if (!paraBuf.length) return
    body += `<p>${paraBuf.map((l) => renderInline(l.trim(), ctx)).join('<br>')}</p>\n`
    paraBuf.length = 0
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(/^```\s*([\w+-]*)\s*$/)
    if (fence) {
      flushPara()
      const lang = fence[1] || ''
      const buf = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++])
      i++
      const raw = buf.join('\n')
      if (lang === 'mermaid') {
        body += `<div class="codeblock mermaid-src"><div class="code-lang">mermaid</div><pre><code>${esc(
          raw
        )}</code></pre></div>\n`
      } else {
        body += `<div class="codeblock">${
          lang ? `<div class="code-lang">${esc(lang)}</div>` : ''
        }<pre><code>${esc(raw)}</code></pre></div>\n`
      }
      continue
    }

    if (!line.trim()) {
      flushPara()
      i++
      continue
    }

    const hm = line.match(/^(#{1,6})\s+(.*)$/)
    if (hm) {
      flushPara()
      const level = hm[1].length
      const text = hm[2].trim()
      if (level === 1) {
        title = text
        i++
        continue
      }
      const slug = slugify(text.replace(/`/g, ''))
      const taken = toc.filter((t) => t.slug === slug).length
      const finalSlug = taken ? `${slug}-${taken + 1}` : slug
      const id = `p${pageIndex}-${finalSlug}`
      toc.push({ level, slug: finalSlug, id, text })
      body += `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${renderInline(
        text,
        ctx
      )}</h${level}>\n`
      i++
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) && !paraBuf.length) {
      body += '<hr>\n'
      i++
      continue
    }

    if (
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      flushPara()
      const aligns = parseTableCells(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':')
          ? 'center'
          : c.endsWith(':')
            ? 'right'
            : 'left'
      )
      const style = (k) => (aligns[k] && aligns[k] !== 'left' ? ` style="text-align:${aligns[k]}"` : '')
      let t = `<div class="tablewrap"><table><thead><tr>${parseTableCells(line)
        .map((c, k) => `<th${style(k)}>${renderInline(c, ctx)}</th>`)
        .join('')}</tr></thead><tbody>`
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        t += `<tr>${parseTableCells(lines[i])
          .map((c, k) => `<td${style(k)}>${renderInline(c, ctx)}</td>`)
          .join('')}</tr>`
        i++
      }
      body += t + '</tbody></table></div>\n'
      continue
    }

    if (line.match(/^(\s*)([-*+]|\d+[.)])\s+/)) {
      flushPara()
      const res = consumeList(lines, i, line.match(/^\s*/)[0].length, ctx)
      body += res.html + '\n'
      i = res.next
      continue
    }

    paraBuf.push(line)
    i++
  }
  flushPara()

  if (!pageHeadings.has(page.file)) pageHeadings.set(page.file, new Map())
  for (const t of toc) pageHeadings.get(page.file).set(t.slug, t.id)

  return { body, toc, title }
}

// ---------- build ----------
// Pass 1 walks every page once purely to register heading slugs into pageHeadings;
// pass 2 renders bodies with the complete map so in-page and cross-page anchors hit.
const sources = PAGES.map((p) => readFileSync(join(WIKI, p.file), 'utf8'))

for (let idx = 0; idx < PAGES.length; idx++) renderPage(sources[idx], idx)
warnings.length = 0 // drop link warnings emitted during the collection pass
const rendered = PAGES.map((_, idx) => renderPage(sources[idx], idx))

const sections = rendered
  .map(
    (r, idx) =>
      `<section class="page" id="p${idx}"><h1 class="page-title">${esc(r.title)}</h1>${r.body}</section>`
  )
  .join('\n')

const groups = []
for (const p of PAGES) {
  let g = groups.find((x) => x.name === p.group)
  if (!g) groups.push((g = { name: p.group, pages: [] }))
  g.pages.push(p)
}
const navHtml = groups
  .map(
    (g) =>
      `<div class="nav-group"><div class="nav-group-name">${esc(g.name)}</div>${g.pages
        .map((p) => {
          const idx = PAGES.indexOf(p)
          const r = rendered[idx]
          const sub = r.toc
            .filter((t) => t.level <= 3)
            .map(
              (t) =>
                `<a class="toc-l${t.level}" data-page="p${idx}" href="#${t.id}">${esc(
                  t.text.replace(/`/g, '')
                )}</a>`
            )
            .join('')
          return `<a class="nav-link" data-page="p${idx}" href="#p${idx}"><span class="num">${String(idx).padStart(
            2,
            '0'
          )}</span>${esc(p.nav)}</a><nav class="page-toc" data-for="p${idx}">${sub}</nav>`
        })
        .join('')}</div>`
  )
  .join('\n')

const generatedAt = new Date().toISOString().slice(0, 10)

const head = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${BRAND} Wiki</title>
<style>
:root{
  --bg:#ffffff;--bg2:#f6f7f9;--bg-code:#f2f3f5;--fg:#1c2128;--fg2:#57606a;
  --border:#e3e6ea;--accent:#4f46e5;--mark:#ffe27a;
  --sidebar-w:288px;--topbar-h:52px;
  --shadow:0 1px 3px rgba(0,0,0,.06);
}
html[data-theme=dark]{
  --bg:#14171c;--bg2:#191d23;--bg-code:#1e232b;--fg:#dbe1e8;--fg2:#8b949e;
  --border:#2b313a;--accent:#818cf8;--mark:#7a5c00;
  --shadow:0 1px 3px rgba(0,0,0,.4);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:15px;line-height:1.78;}
#sidebar{position:fixed;inset:0 auto 0 0;width:var(--sidebar-w);background:var(--bg2);
  border-right:1px solid var(--border);overflow-y:auto;z-index:40;padding:14px 10px 40px;
  transition:transform .18s ease;}
#sidebar .brand{font-weight:700;font-size:15.5px;padding:6px 10px 12px;color:var(--fg);
  letter-spacing:.2px;border-bottom:1px solid var(--border);margin-bottom:10px;}
#sidebar .brand small{display:block;font-weight:400;color:var(--fg2);font-size:11.5px;margin-top:2px}
.nav-group-name{font-size:11.5px;font-weight:600;color:var(--fg2);text-transform:uppercase;
  letter-spacing:.8px;padding:14px 10px 5px;}
.nav-link{display:flex;gap:8px;align-items:center;padding:5.5px 10px;border-radius:7px;
  color:var(--fg);text-decoration:none;font-size:13.8px;}
.nav-link:hover{background:rgba(128,128,128,.12)}
.nav-link.active{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);font-weight:600}
.nav-link .num{font-size:10.5px;color:var(--fg2);font-family:ui-monospace,Consolas,monospace;min-width:18px}
.page-toc{display:none;margin:1px 0 4px 20px;border-left:1.5px solid var(--border);padding-left:6px}
.page-toc.open{display:block}
.page-toc a{display:block;padding:2.5px 8px;font-size:12.3px;color:var(--fg2);text-decoration:none;
  border-radius:5px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:238px}
.page-toc a:hover{color:var(--accent)}
.page-toc a.cur{color:var(--accent);font-weight:500}
.toc-l3{padding-left:16px!important}
#topbar{position:fixed;top:0;left:0;right:0;height:var(--topbar-h);display:flex;align-items:center;
  gap:10px;padding:0 14px;background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:blur(8px);border-bottom:1px solid var(--border);z-index:50;}
#menu-btn{display:none;background:none;border:1px solid var(--border);border-radius:7px;
  font-size:16px;padding:3px 10px;cursor:pointer;color:var(--fg)}
#search-wrap{flex:1;max-width:430px;display:flex;align-items:center;gap:6px}
#search{flex:1;background:var(--bg-code);border:1px solid var(--border);border-radius:8px;
  padding:6px 12px;font-size:13.5px;color:var(--fg);outline:none}
#search:focus{border-color:var(--accent)}
#search-count{font-size:11.5px;color:var(--fg2);min-width:56px;text-align:right}
#theme-btn{background:var(--bg-code);border:1px solid var(--border);border-radius:8px;
  padding:5px 11px;cursor:pointer;color:var(--fg);font-size:12.5px}
#main{margin-left:var(--sidebar-w);padding:calc(var(--topbar-h) + 26px) 34px 80px;}
.page{max-width:900px;margin:0 auto;padding-bottom:44px}
.page:not(:last-child){border-bottom:1px dashed var(--border);margin-bottom:30px}
h1,h2,h3,h4,h5,h6{line-height:1.35;font-weight:650;scroll-margin-top:calc(var(--topbar-h) + 14px)}
h1.page-title{font-size:27px;margin:8px 0 22px;padding-bottom:10px;border-bottom:2px solid var(--border)}
h2{font-size:21px;margin:34px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
h3{font-size:17.5px;margin:26px 0 10px}
h4{font-size:15.5px;margin:20px 0 8px}
.anchor{opacity:0;margin-right:6px;color:var(--accent);text-decoration:none;font-weight:400}
h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{opacity:.55}
p{margin:9px 0}
a{color:var(--accent)}
a.ext::after{content:"\\2197";font-size:.78em;vertical-align:super;opacity:.65;margin-left:1px}
strong{font-weight:660}
code{font-family:ui-monospace,"Cascadia Code",Consolas,Menlo,monospace;font-size:.875em;
  background:var(--bg-code);border:1px solid var(--border);border-radius:5px;padding:.09em .38em;}
.codeblock{position:relative;margin:13px 0}
.codeblock pre{margin:0;padding:13px 15px;overflow-x:auto;background:var(--bg-code);
  border:1px solid var(--border);border-radius:9px;font-size:13px;line-height:1.6}
.codeblock pre code{background:none;border:none;padding:0;font-size:inherit}
.code-lang{position:absolute;top:0;right:0;font-size:10.5px;color:var(--fg2);
  background:color-mix(in srgb,var(--bg) 80%,transparent);padding:2px 9px;border-radius:0 9px 0 7px;
  border-left:1px solid var(--border);border-bottom:1px solid var(--border);z-index:1}
.tablewrap{overflow-x:auto;margin:13px 0;border:1px solid var(--border);border-radius:9px;box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;font-size:13.6px}
th,td{padding:7.5px 12px;border-bottom:1px solid var(--border);vertical-align:top}
th{background:var(--bg2);font-weight:640;white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
tbody tr:nth-child(even){background:color-mix(in srgb,var(--bg2) 55%,transparent)}
blockquote{margin:12px 0;padding:6px 16px;border-left:3px solid var(--accent);
  background:var(--bg2);border-radius:0 8px 8px 0;color:var(--fg2)}
hr{border:none;border-top:1px dashed var(--border);margin:26px 0}
ul,ol{padding-left:26px;margin:9px 0}
li{margin:4px 0}
li p{margin:5px 0}
mark{background:var(--mark);color:inherit;border-radius:2px;padding:0 1px}
.mermaid-out{background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:16px;overflow-x:auto;margin:-6px 0 13px}
footer{max-width:900px;margin:30px auto 0;color:var(--fg2);font-size:12.3px;
  border-top:1px solid var(--border);padding-top:14px}
#overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:35}
@media (max-width:1020px){
  #menu-btn{display:block}
  #sidebar{transform:translateX(-105%)}
  #sidebar.open{transform:none;box-shadow:0 0 24px rgba(0,0,0,.25)}
  #main{margin-left:0;padding-left:16px;padding-right:16px}
  body.nav-open #overlay{display:block}
}
@media print{
  #sidebar,#topbar,#overlay{display:none!important}
  #main{margin:0;padding:0}
  .page{break-before:page}
  .page:first-child{break-before:auto}
}
</style>
</head>
<body>
<div id="topbar">
  <button id="menu-btn" aria-label="目录">&#9776;</button>
  <div id="search-wrap">
    <input id="search" type="search" placeholder="搜索全文…（Enter 跳转，Esc 清除）" autocomplete="off">
    <span id="search-count"></span>
  </div>
  <button id="theme-btn" title="切换主题">主题：自动</button>
</div>
<div id="overlay"></div>
<div id="sidebar">
  <div class="brand">${BRAND}<small>源码学习 wiki · 共 ${PAGES.length} 页 · 由 wiki/build.mjs 编译</small></div>
  ${navHtml}
</div>
<div id="main">
${sections}
<footer>
  本页由 <code>wiki/*.md</code> 经 <code>wiki/build.mjs</code> 编译生成（${generatedAt}）。Markdown 源文件为内容权威，修改后重新运行 <code>node wiki/build.mjs</code> 即可。
</footer>
</div>
<script type="module">
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)]
/* theme */
const KEY='pi-wiki-theme';let mode=localStorage.getItem(KEY)||'auto'
const mq=matchMedia('(prefers-color-scheme: dark)')
function applyTheme(){document.documentElement.dataset.theme=mode==='auto'?(mq.matches?'dark':'light'):mode
  $('#theme-btn').textContent='主题：'+(mode==='auto'?'自动':mode==='dark'?'深色':'浅色')}
$('#theme-btn').onclick=()=>{mode=mode==='auto'?'dark':mode==='dark'?'light':'auto';localStorage.setItem(KEY,mode);applyTheme();rerenderMermaid()}
mq.addEventListener('change',()=>{if(mode==='auto'){applyTheme();rerenderMermaid()}})
applyTheme()
/* mermaid */
let mm=null,mmOk=false
function hash(s){let h=0;for(let i=0;i<s.length;i++){h=(h<<5)-h+s.charCodeAt(i);h|=0}return h}
async function rerenderMermaid(){
  if(!mmOk)return
  const dark=document.documentElement.dataset.theme==='dark'
  try{
    mm.initialize({startOnLoad:false,securityLevel:'loose',theme:dark?'dark':'default',fontFamily:'inherit'})
    for(const blk of $$('.mermaid-src')){
      const src=$('code',blk).textContent
      const{svg}=await mm.render('mmd-'+Math.abs(hash(src+(dark?'d':'l'))),src)
      let out=blk.nextElementSibling
      if(!out||!out.classList.contains('mermaid-out')){
        out=document.createElement('div');out.className='mermaid-out';blk.insertAdjacentElement('afterend',out)}
      out.innerHTML=svg;blk.style.display='none'
    }
  }catch(e){}
}
try{
  mm=(await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')).default
  mmOk=true;await rerenderMermaid()
}catch(e){}
/* nav / scrollspy */
const navLinks=$$('.nav-link'),tocLinks=$$('.page-toc a')
function setActive(hash){
  const id=(hash||location.hash||'#p0').slice(1)
  const el=document.getElementById(id)
  if(!el)return
  const page=el.classList.contains('page')?el:el.closest('.page')
  if(!page)return
  navLinks.forEach(a=>a.classList.toggle('active',a.dataset.page===page.id))
  $$('.page-toc').forEach(t=>t.classList.toggle('open',t.dataset.for===page.id))
  tocLinks.forEach(a=>a.classList.toggle('cur',a.getAttribute('href')==='#'+id))
  if(innerWidth<=1020&&document.body.classList.contains('nav-open'))toggleNav(false)
}
addEventListener('hashchange',()=>setActive(location.hash))
const headObs=new IntersectionObserver(es=>{
  for(const e of es)if(e.isIntersecting){history.replaceState(null,'','#'+e.target.id);setActive('#'+e.target.id);break}
},{rootMargin:'-55px 0px -75% 0px'})
$$('.page h2[id],.page h3[id]').forEach(h=>headObs.observe(h))
/* mobile sidebar */
function toggleNav(open){const b=document.body;b.classList.toggle('nav-open',open??!b.classList.contains('nav-open'))
  $('#sidebar').classList.toggle('open',b.classList.contains('nav-open'))}
$('#menu-btn').onclick=()=>toggleNav()
$('#overlay').onclick=()=>toggleNav(false)
$$('.nav-link').forEach(a=>a.addEventListener('click',()=>{if(innerWidth<=1020)toggleNav(false)}))
/* search */
const input=$('#search'),count=$('#search-count');let marks=[],cur=-1
function clearMarks(){for(const m of marks)m.replaceWith(document.createTextNode(m.textContent));marks=[];count.textContent=''}
function search(q){
  clearMarks();if(!q||q.length<2)return
  const walker=document.createTreeWalker($('#main'),NodeFilter.SHOW_TEXT,{
    acceptNode:n=>n.parentElement.closest('script,style,mark')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT})
  const hits=[];let n;const ql=q.toLowerCase()
  while(n=walker.nextNode()){
    const t=n.textContent.toLowerCase();let idx=t.indexOf(ql)
    while(idx>=0){hits.push([n,idx,idx+q.length]);idx=t.indexOf(ql,idx+q.length)}
  }
  for(let k=hits.length-1;k>=0;k--){
    const[node,s,e]=hits[k];const m=document.createElement('mark')
    m.textContent=node.textContent.slice(s,e)
    node.splitText(e).splitText(0)
    node.parentElement.insertBefore(m,node.nextSibling)
    marks.push(m)
  }
  marks.reverse();cur=-1;count.textContent=''
  if(marks.length)jump();else count.textContent='无结果'
}
function jump(){if(!marks.length)return;cur=(cur+1)%marks.length
  marks.forEach(m=>m.style.outline='');const m=marks[cur]
  m.style.outline='2px solid var(--accent)';m.scrollIntoView({behavior:'smooth',block:'center'})
  count.textContent=(cur+1)+'/'+marks.length+' 处'}
let deb;input.addEventListener('input',()=>{clearTimeout(deb);deb=setTimeout(()=>search(input.value.trim()),220)})
input.addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();jump()}
  if(e.key==='Escape'){input.value='';clearMarks()}})
setActive(location.hash)
</script>
</body>
</html>
`

writeFileSync(join(WIKI, 'index.html'), head, 'utf8')
console.log(`OK wiki/index.html (${(head.length / 1024).toFixed(1)} KB), ${PAGES.length} pages`)
if (warnings.length) {
  console.log(`WARNINGS (${warnings.length}):`)
  for (const w of warnings) console.log('  - ' + w)
} else console.log('no link warnings')
