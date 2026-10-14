#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { handle, hooks } from '../src/app.js'
import { available, PROVIDERS } from '../src/providers.js'
import { listen } from '../src/node.js'
import * as C from '../src/clients.js'
import { scaffold, openapiServer, TEMPLATES } from '../src/mcp/create.js'
import { test as mcpTest, lint as mcpLint } from '../src/mcp/check.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const JEV = C.jevDir()
const CONFIG = path.join(JEV, 'config.json')
const config = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } catch { return {} } }
const saveConfig = (c) => { fs.mkdirSync(JEV, { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)) }
const die = (m) => { console.error(`✗ ${m}`); process.exit(1) }
const yes = (q) => { process.stdout.write(`${q} [Y/n] `); const b = Buffer.alloc(16); let n = 0; try { n = fs.readSync(0, b) } catch {} return !/^n/i.test(b.toString('utf8', 0, n).trim()) }

// Load ~/.jev/.env and ./.env into process.env (provider keys).
for (const f of [path.join(JEV, '.env'), '.env']) try { process.loadEnvFile(f) } catch {}

function env() {
  const e = { ...process.env }
  const models = path.join(JEV, 'models.json')
  if (fs.existsSync(models)) e.JEV_MODELS = fs.readFileSync(models, 'utf8')
  return e
}

const { values: o, positionals: args } = parseArgs({
  allowPositionals: true, strict: false,
  options: {
    port: { type: 'string', short: 'p' }, host: { type: 'string' }, url: { type: 'string' }, key: { type: 'string' },
    template: { type: 'string', short: 't' }, all: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' },
    token: { type: 'string' }, 'no-call': { type: 'boolean' }, claude: { type: 'boolean' }, codex: { type: 'boolean' }, cursor: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})
const [cmd, sub, ...rest] = args
const gatewayUrl = () => (o.url || config().url || `http://127.0.0.1:${o.port || 4000}`).replace(/\/+$/, '')
const gatewayKey = () => o.key ?? config().key ?? process.env.JEV_API_KEY

const HELP = `JEV — one endpoint for every model, one CLI for every MCP.

ROUTER
  jev serve [-p 4000] [--host 127.0.0.1]   start the gateway
  jev setup [--url URL] [--key KEY]        point Claude Code / Codex / Cursor at JEV
  jev uninstall-config                     restore the original client configs
  jev doctor                               test endpoints, streaming, tools, configs
  jev models                               models available with your keys
  jev why                                  last routing decisions
  jev usage                                requests / est. cost by model and client
  jev deploy                               deploy the gateway free to Cloudflare Workers

MCP
  jev mcp create <name> [-t blank|rest-api]  new MCP server project
  jev mcp import <openapi.json> [name] [--all]
  jev mcp dev [dir] [-p 7337]                run locally with reload
  jev mcp test <dir|url> [--token T]         protocol + tool checks
  jev mcp lint <dir|url>                     tool quality & safety score
  jev mcp deploy [dir]                       free deploy to Cloudflare Workers
  jev mcp install <name> <url> [--claude --codex --cursor] [--token T]
  jev mcp uninstall <name>
  jev mcp publish [dir]                      validate server.json, publish to the MCP Registry`

const commands = {
  async serve() {
    const port = +(o.port || 4000), host = o.host || '127.0.0.1'
    const e = env()
    if (['127.0.0.1', 'localhost', '::1'].includes(host)) e.JEV_LOCAL = '1'
    else if (!e.JEV_API_KEY) die('Set JEV_API_KEY before binding to a public interface.')
    const log = path.join(JEV, 'usage.jsonl')
    fs.mkdirSync(JEV, { recursive: true })
    hooks.onRoute = (x) => {
      fs.appendFile(log, JSON.stringify(x) + '\n', () => {})
      console.log(`  ${x.client.padEnd(12)} ${x.task.padEnd(16)} → ${x.provider}/${x.model}  ${x.status} ${x.ms}ms`)
    }
    await listen((req) => handle(req, e), { port, host })
    const n = available(e).length
    console.log(`\n  JEV router  http://${host}:${port}\n  Models      ${n} available${n ? '' : '  ← add a key, e.g. echo GEMINI_API_KEY=... >> ~/.jev/.env'}\n  Aliases     jev-auto  jev-fast  jev-smart  jev-cheap  jev-free\n`)
  },

  async setup() {
    const url = gatewayUrl(), key = gatewayKey()
    const found = C.detect()
    console.log(`\n  JEV setup → ${url}\n`)
    for (const [k, v] of Object.entries(found)) console.log(`  ${v ? '✓' : '·'} ${k}${v ? ' detected' : ' not found'}`)
    if (!o.yes && !yes('\n  Configure detected clients? (backups go to ~/.jev/backups)')) return
    saveConfig({ ...config(), url, ...(key && { key }) })
    if (found.claude) { C.setupClaude(url, key); console.log('  ✓ Claude Code  ~/.claude/settings.json (env: ANTHROPIC_BASE_URL, ANTHROPIC_MODEL=jev-auto)') }
    if (found.codex) { C.setupCodex(url, key); console.log('  ✓ Codex        ~/.codex/config.toml (model_provider = "jev", wire_api = "responses")') }
    if (found.cursor) {
      const text = `OpenAI API Key: ${key || '(set JEV_API_KEY)'}\nOverride OpenAI Base URL: ${url}/v1\nModel: jev-auto`
      console.log(`  ✓ Cursor       Settings → Models → API Keys:\n${text.replace(/^/gm, '                 ')}`)
      if (C.copy(text)) console.log('                 (copied to clipboard)')
      if (/127\.0\.0\.1|localhost/.test(url)) console.log('  ⚠ Cursor calls custom endpoints from its servers, so it needs a public URL: run `jev deploy` and `jev setup --url <workers.dev url> --key <key>`.')
    }
    console.log('\n  Done. Start the router with `jev serve`, then run `claude` or `codex`. Undo: `jev uninstall-config`.\n')
  },

  async 'uninstall-config'() {
    console.log(C.undoClaude() ? '  ✓ Claude Code restored' : '  · Claude Code: nothing to restore')
    console.log(C.undoCodex() ? '  ✓ Codex restored' : '  · Codex: nothing to restore')
    console.log('  · Cursor: remove the base URL override in Settings → Models')
  },

  async models() {
    const e = env(), have = available(e)
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const list = have.filter(m => m.provider === id)
      console.log(`  ${list.length ? '✓' : '·'} ${id.padEnd(11)} ${list.length ? list.map(m => `${m.id} (t${m.tier}${m.free ? ', free' : ''})`).join(', ') : `set ${p.key}`}`)
    }
  },

  async why() {
    const res = await fetch(`${gatewayUrl()}/jev/why`, { headers: { authorization: `Bearer ${gatewayKey() || ''}` } }).catch(() => die(`JEV is not running at ${gatewayUrl()}`))
    const list = await res.json()
    if (!list.length) return console.log('  No requests routed yet.')
    for (const x of list) console.log(`\n  ${x.ts}\n  Client   ${x.client}\n  Task     ${x.task} (tier ${x.tier}, alias ${x.alias})\n  Model    ${x.provider}/${x.model}${x.native ? '' : '  (translated)'}\n  Reason   ${x.reason}\n  Status   ${x.status} in ${x.ms} ms, est. input $${x.est_cost}`)
  },

  async usage() {
    const file = path.join(JEV, 'usage.jsonl')
    if (!fs.existsSync(file)) return console.log('  No usage yet.')
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const group = (k) => Object.entries(rows.reduce((a, r) => ((a[r[k]] ||= { n: 0, cost: 0 }), a[r[k]].n++, a[r[k]].cost += r.est_cost || 0, a), {})).sort((a, b) => b[1].n - a[1].n)
    console.log(`\n  ${rows.length} requests, est. input cost $${rows.reduce((a, r) => a + (r.est_cost || 0), 0).toFixed(4)} (output tokens not counted)\n`)
    for (const k of ['model', 'client', 'task']) {
      console.log(`  ${k.toUpperCase()}`)
      for (const [name, v] of group(k)) console.log(`    ${String(name).padEnd(28)} ${String(v.n).padStart(6)}  ${Math.round(100 * v.n / rows.length)}%`)
    }
  },

  async doctor() {
    const url = gatewayUrl(), key = gatewayKey()
    const H = { 'content-type': 'application/json', authorization: `Bearer ${key || 'jev-local'}`, 'x-api-key': key || 'jev-local', 'anthropic-version': '2023-06-01' }
    const line = (ok, m, soft) => console.log(`  ${ok ? '✓' : soft ? '·' : '✗'} ${m}`)
    let bad = 0
    const check = async (name, fn) => { try { const r = await fn(); line(true, `${name}${r ? ` — ${r}` : ''}`) } catch (e) { bad++; line(false, `${name} — ${e.message}`) } }
    const post = async (p, body) => {
      const r = await fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(body) })
      const t = await r.text()
      if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`)
      return { t, route: r.headers.get('x-jev-route') }
    }
    console.log(`\n  JEV doctor → ${url}\n`)
    await check('health', async () => { const r = await fetch(url + '/health'); if (!r.ok) throw new Error(r.status); return `${(await r.json()).models} models` })
    await check('/v1/models', async () => { const r = await fetch(url + '/v1/models', { headers: H }); if (!r.ok) throw new Error(r.status) })
    const tool = { name: 'get_weather', description: 'Get weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }
    await check('/v1/messages', async () => (await post('/v1/messages', { model: 'jev-fast', max_tokens: 20, messages: [{ role: 'user', content: 'Say hi' }] })).route)
    await check('/v1/messages stream', async () => { const r = await post('/v1/messages', { model: 'jev-fast', max_tokens: 20, stream: true, messages: [{ role: 'user', content: 'Say hi' }] }); if (!r.t.includes('message_stop')) throw new Error('no message_stop') })
    await check('/v1/messages tool call', async () => { const r = await post('/v1/messages', { model: 'jev-fast', max_tokens: 200, tools: [tool], tool_choice: { type: 'any' }, messages: [{ role: 'user', content: 'Weather in Paris?' }] }); if (!r.t.includes('tool_use')) throw new Error('no tool_use') })
    await check('/v1/responses', async () => (await post('/v1/responses', { model: 'jev-fast', input: 'Say hi', max_output_tokens: 50 })).route)
    await check('/v1/responses stream', async () => { const r = await post('/v1/responses', { model: 'jev-fast', input: 'Say hi', stream: true }); if (!r.t.includes('response.completed')) throw new Error('no response.completed') })
    await check('/v1/chat/completions', async () => (await post('/v1/chat/completions', { model: 'jev-fast', messages: [{ role: 'user', content: 'Say hi' }] })).route)
    const home = C.home()
    const claude = (() => { try { return JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')).env?.ANTHROPIC_BASE_URL } catch {} })()
    line(claude === url, `Claude Code config ${claude ? `→ ${claude}` : 'not set (run jev setup)'}`, true)
    const codex = (() => { try { return fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), 'utf8').includes('# >>> jev') } catch {} })()
    line(codex, `Codex config ${codex ? 'has jev provider' : 'not set (run jev setup)'}`, true)
    console.log(bad ? `\n  ${bad} check(s) failed.\n` : '\n  JEV is ready.\n')
    process.exitCode = bad ? 1 : 0
  },

  async deploy() {
    const key = o.key || process.env.JEV_API_KEY || `jev_${crypto.randomUUID().replace(/-/g, '')}`
    console.log('  Deploying the JEV gateway to Cloudflare Workers (free plan)…')
    if (spawnSync('npx', ['-y', 'wrangler@4', 'deploy'], { cwd: ROOT, stdio: 'inherit' }).status) die('wrangler deploy failed (run `npx wrangler login` first)')
    spawnSync('npx', ['-y', 'wrangler@4', 'secret', 'put', 'JEV_API_KEY'], { cwd: ROOT, input: key, stdio: ['pipe', 'inherit', 'inherit'] })
    console.log(`\n  JEV_API_KEY = ${key}\n  Add provider keys:  npx wrangler secret put GEMINI_API_KEY   (etc.)\n  Then: jev setup --url https://jev.<your-subdomain>.workers.dev --key ${key}\n`)
  },

  async mcp() {
    const m = mcpCommands[sub]
    if (!m) { console.log(HELP); return }
    await m(...rest)
  },
}

const mcpCommands = {
  async create(name) {
    if (!name) die('usage: jev mcp create <name> [-t blank|rest-api]')
    const tpl = o.template || 'blank'
    if (!TEMPLATES[tpl]) die(`unknown template "${tpl}" (blank, rest-api)`)
    const files = scaffold(path.resolve(name), name, TEMPLATES[tpl]())
    console.log(`\n  ✓ Created ${name}/ (${files.join(', ')})\n\n  cd ${name}\n  jev mcp dev      # run locally\n  jev mcp test .   # check it\n  jev mcp deploy   # free hosting on Cloudflare Workers\n`)
  },

  async import(file, name) {
    if (!file) die('usage: jev mcp import <openapi.json> [name] [--all]')
    let text = fs.readFileSync(file, 'utf8')
    if (/\.ya?ml$/i.test(file)) {
      const r = spawnSync('npx', ['-y', 'js-yaml@4', file], { encoding: 'utf8' })
      if (r.status) die('could not convert YAML; convert to JSON first')
      text = r.stdout
    }
    const spec = JSON.parse(text)
    name ||= (spec.info?.title || 'api').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-mcp'
    const { src, tools, skipped } = openapiServer(name, spec, { all: o.all })
    console.log(`\n  ${tools.length + skipped.length} endpoints → ${tools.length} tools`)
    for (const t of tools) console.log(`  [x] ${t.name.padEnd(32)} ${t.method} ${t.path}`)
    for (const s of skipped) console.log(`  [ ] ${s}  (skipped: destructive/internal — use --all to include)`)
    scaffold(path.resolve(name), name, src, { description: spec.info?.description?.split('\n')[0] || `${spec.info?.title} MCP server` })
    console.log(`\n  ✓ Created ${name}/ — review server.js, then: cd ${name} && jev mcp test .\n`)
  },

  async dev(dir = '.') {
    const file = path.resolve(dir, 'server.js')
    if (!fs.existsSync(file)) die(`no server.js in ${dir}`)
    spawn(process.execPath, ['--watch', path.join(ROOT, 'src/mcp/devhost.js'), file, o.port || '7337'], { stdio: 'inherit' })
  },

  async test(target = '.') {
    console.log(`\n  JEV MCP test → ${target}\n`)
    const r = await mcpTest(target, { token: o.token, call: !o['no-call'] })
    process.exitCode = r.fail ? 1 : 0
  },

  async lint(target = '.') {
    const r = await mcpLint(target, { token: o.token })
    console.log(`\n  MCP tool quality: ${r.score}/100\n`)
    for (const t of r.results) {
      console.log(`  ${t.score === 100 ? '✓' : '⚠'} ${t.name.padEnd(30)} ${t.kind.padEnd(12)} ${t.score}`)
      for (const i of t.issues) console.log(`      - ${i}`)
    }
    for (const f of r.secrets) console.log(`  ✗ possible secret committed in ${f}`)
    console.log()
    process.exitCode = r.secrets.length ? 1 : 0
  },

  async deploy(dir = '.') {
    console.log('  Checking before deploy…')
    const r = await mcpTest(dir, { call: false, log: () => {} })
    if (r.fail) die('mcp test failed — run `jev mcp test .`')
    const l = await mcpLint(dir)
    if (l.secrets.length) die(`secrets found in ${l.secrets.join(', ')} — move them to Worker secrets`)
    if (spawnSync('npx', ['-y', 'wrangler@4', 'deploy'], { cwd: dir, stdio: 'inherit' }).status) die('wrangler deploy failed (run `npx wrangler login` first)')
    console.log('\n  ✓ Deployed. Your MCP URL is the workers.dev URL above + /mcp\n  Install it everywhere: jev mcp install <name> <url>\n')
  },

  async install(name, url) {
    if (!name || !url) die('usage: jev mcp install <name> <url> [--claude --codex --cursor] [--token T]')
    if (!/^https?:\/\//.test(url)) die('url must start with http(s)://')
    if (!/^[\w.-]+$/.test(name)) die('name may only contain letters, digits, ".", "_" and "-"')
    const found = C.detect()
    const pick = o.claude || o.codex || o.cursor ? { claude: o.claude, codex: o.codex, cursor: o.cursor } : found
    const header = o.token ? `Authorization: Bearer ${o.token}` : null
    if (pick.claude) {
      const a = ['mcp', 'add', '--transport', 'http', '--scope', 'user', name, url, ...(header ? ['--header', header] : [])]
      C.has('claude') && spawnSync('claude', a, { stdio: 'inherit' }).status === 0 ? console.log('  ✓ Claude Code') : console.log(`  · Claude Code: claude ${a.join(' ')}`)
    }
    if (pick.codex) {
      const a = ['mcp', 'add', name, '--url', url, ...(o.token ? ['--bearer-token-env-var', 'JEV_MCP_TOKEN'] : [])]
      C.has('codex') && spawnSync('codex', a, { stdio: 'inherit' }).status === 0 ? console.log(`  ✓ Codex${o.token ? ' (export JEV_MCP_TOKEN=<token>)' : ''}`) : console.log(`  · Codex: codex ${a.join(' ')}`)
    }
    const entry = { url, ...(o.token && { headers: { Authorization: `Bearer ${o.token}` } }) }
    if (pick.cursor) { C.mergeCursorMcp(name, entry); console.log('  ✓ Cursor       ~/.cursor/mcp.json') }
    console.log(`\n  Cursor one-click link:\n  cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${Buffer.from(JSON.stringify({ url })).toString('base64')}\n`)
  },

  async uninstall(name) {
    if (!name) die('usage: jev mcp uninstall <name>')
    if (C.has('claude')) spawnSync('claude', ['mcp', 'remove', name, '-s', 'user'], { stdio: 'inherit' })
    if (C.has('codex')) spawnSync('codex', ['mcp', 'remove', name], { stdio: 'inherit' })
    if (fs.existsSync(C.cursorMcpPath())) C.mergeCursorMcp(name, null)
    console.log(`  ✓ Removed ${name}`)
  },

  async publish(dir = '.') {
    const file = path.join(dir, 'server.json')
    if (!fs.existsSync(file)) die('no server.json')
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    const problems = []
    if (!/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(s.name || '')) problems.push('name must look like io.github.<user>/<server>')
    if (s.name?.includes('your-github-user')) problems.push('replace "your-github-user" in name with your GitHub username')
    if (!/^\d+\.\d+\.\d+/.test(s.version || '')) problems.push('version must be semver')
    if (!s.description || s.description.length > 100) problems.push('description is required, max 100 chars')
    for (const r of s.remotes || []) if (!/^https:\/\//.test(r.url) || r.url.includes('<')) problems.push(`remote url "${r.url}" must be your real https URL (deploy first)`)
    if (!s.remotes?.length && !s.packages?.length) problems.push('needs remotes[] or packages[]')
    if (problems.length) { for (const p of problems) console.log(`  ✗ ${p}`); process.exit(1) }
    console.log(`  ✓ server.json valid (${s.name}@${s.version})`)
    if (!C.has('mcp-publisher')) return console.log('\n  Install the registry CLI, then run this again:\n    brew install mcp-publisher   # or see github.com/modelcontextprotocol/registry\n')
    // Registry tokens are short-lived; reuse the GitHub CLI login when there is one.
    const gh = C.has('gh') && spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim()
    const login = spawnSync('mcp-publisher', ['login', 'github', ...(gh ? ['-token', gh] : [])], { stdio: 'inherit' })
    if (login.status) die('registry login failed')
    if (spawnSync('mcp-publisher', ['publish'], { cwd: dir, stdio: 'inherit' }).status) die('publish failed')
    console.log(`\n  ✓ Listed: https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(s.name)}\n`)
  },
}

if (!cmd || o.help || !commands[cmd]) console.log(HELP)
else await commands[cmd]()
