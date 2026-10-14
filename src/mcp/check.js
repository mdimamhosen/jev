// `jev mcp test` and `jev mcp lint`: talk to a server by URL, or load a project in-process.
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { validate } from './runtime.js'

export async function connect(target, token) {
  let send
  if (/^https?:\/\//.test(target)) {
    let session
    send = async (body) => {
      const res = await fetch(target, {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(session && { 'mcp-session-id': session }), ...(token && { authorization: `Bearer ${token}` }) },
      })
      session ||= res.headers.get('mcp-session-id')
      if (res.status === 202) return null
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
      // SSE response: take the first JSON-RPC message carrying our id.
      if ((res.headers.get('content-type') || '').includes('text/event-stream'))
        return text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))).find(m => m.id === body.id)
      return JSON.parse(text)
    }
  } else {
    const file = fs.statSync(target).isDirectory() ? path.join(target, 'server.js') : target
    const server = (await import(pathToFileURL(path.resolve(file)).href)).default
    send = async (body) => {
      const res = await server.fetch(new Request('http://local/mcp', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), process.env)
      return res.status === 202 ? null : res.json()
    }
  }
  let id = 0
  return async (method, params) => {
    const r = await send({ jsonrpc: '2.0', id: ++id, method, params })
    if (r?.error) throw Object.assign(new Error(r.error.message), { code: r.error.code })
    return r?.result
  }
}

export function sample(schema = {}) {
  const out = {}
  for (const k of schema.required || []) {
    const s = schema.properties?.[k] || {}
    out[k] = s.enum ? s.enum[0] : s.default ?? ({ string: 'test', number: 1, integer: 1, boolean: true, array: [], object: {} }[s.type] ?? 'test')
  }
  return out
}

export const isReadOnly = (t) => t.annotations?.readOnlyHint ?? /^(get|list|search|find|read|fetch|lookup|query|describe|count)_?/i.test(t.name)

export async function test(target, { token, call = true, log = console.log } = {}) {
  let pass = 0, fail = 0, warn = 0
  const ok = (m) => { pass++; log(`  ✓ ${m}`) }
  const bad = (m) => { fail++; log(`  ✗ ${m}`) }
  const meh = (m) => { warn++; log(`  ⚠ ${m}`) }
  const rpc = await connect(target, token)
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jev-test', version: '1' } })
  ok(`initialize → ${init.serverInfo?.name} ${init.serverInfo?.version} (protocol ${init.protocolVersion})`)
  await rpc('notifications/initialized').catch(() => {})
  const { tools = [] } = await rpc('tools/list', {})
  tools.length ? ok(`tools/list → ${tools.length} tools`) : meh('no tools exposed')
  for (const m of ['resources/list', 'prompts/list']) {
    try { const r = await rpc(m, {}); ok(`${m} → ${(r.resources || r.prompts || []).length}`) }
    catch (e) { e.code === -32601 ? ok(`${m} not supported (fine)`) : bad(`${m}: ${e.message}`) }
  }
  for (const t of tools) {
    if (t.inputSchema?.type !== 'object') bad(`${t.name}: inputSchema.type must be "object"`)
    else ok(`${t.name}: schema valid`)
  }
  try { await rpc('tools/call', { name: '__jev_missing__', arguments: {} }); bad('unknown tool should return an error') }
  catch { ok('unknown tool → JSON-RPC error') }
  if (call) for (const t of tools.filter(isReadOnly)) {
    const args = sample(t.inputSchema)
    if (validate(t.inputSchema, args)) { meh(`${t.name}: could not build sample args`); continue }
    const t0 = Date.now()
    try {
      const r = await rpc('tools/call', { name: t.name, arguments: args })
      r.isError ? meh(`${t.name}(${JSON.stringify(args)}) → tool error: ${r.content?.[0]?.text?.slice(0, 120)}`) : ok(`${t.name}(${JSON.stringify(args)}) → ${Date.now() - t0} ms`)
    } catch (e) { bad(`${t.name}: ${e.message}`) }
  }
  log(`\n  ${pass} passed, ${warn} warnings, ${fail} failed`)
  return { pass, warn, fail, tools }
}

const GENERIC = /^(search|query|run|get|do|execute|tool|call|data|fetch|process|handle|action)$/i
const DESTRUCTIVE = /delete|remove|drop|destroy|purge|truncate|kill|wipe|reset|revoke/i
const WRITE = /create|update|set|add|post|put|patch|send|write|upload|insert|move|rename|publish|deploy/i
const SECRET = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

export const classify = (t) => t.annotations?.destructiveHint || DESTRUCTIVE.test(t.name) ? 'DESTRUCTIVE'
  : t.annotations?.readOnlyHint || !WRITE.test(t.name) ? 'READ_ONLY' : 'WRITE'

export function lintTool(t) {
  const issues = []
  let score = 100
  const hit = (n, m) => { score -= n; issues.push(m) }
  if (GENERIC.test(t.name)) hit(15, `name "${t.name}" is too generic — say what it acts on (e.g. search_customer_orders)`)
  if (!/^[a-z][a-z0-9_]*$/.test(t.name)) hit(5, 'use snake_case names')
  if (!t.description) hit(30, 'missing description')
  else if (t.description.length < 25) hit(15, 'description is too short — say what it does and when to use it')
  const props = Object.entries(t.inputSchema?.properties || {})
  const undocumented = props.filter(([, s]) => !s.description).map(([k]) => k)
  if (undocumented.length) hit(Math.min(15, 3 * undocumented.length), `parameters without description: ${undocumented.join(', ')}`)
  const kind = classify(t)
  if (kind === 'DESTRUCTIVE' && !t.annotations?.destructiveHint) hit(15, 'destructive tool should set annotations.destructiveHint = true so clients ask for confirmation')
  return { name: t.name, kind, score: Math.max(0, score), issues }
}

export async function lint(target, { token } = {}) {
  const rpc = await connect(target, token)
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jev-lint', version: '1' } })
  const { tools = [] } = await rpc('tools/list', {})
  const results = tools.map(lintTool)
  // Near-duplicate descriptions confuse tool selection.
  for (let i = 0; i < tools.length; i++) for (let j = i + 1; j < tools.length; j++)
    if (tools[i].description && tools[i].description === tools[j].description) results[j].issues.push(`same description as ${tools[i].name}`), results[j].score -= 10
  const secrets = []
  if (!/^https?:/.test(target)) {
    const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target)
    for (const f of fs.readdirSync(dir).filter(f => /\.(m?[jt]s|json|toml)$/.test(f)))
      if (SECRET.test(fs.readFileSync(path.join(dir, f), 'utf8'))) secrets.push(f)
  }
  const score = results.length ? Math.round(results.reduce((a, r) => a + r.score, 0) / results.length) - secrets.length * 30 : 0
  return { score: Math.max(0, score), results, secrets }
}
