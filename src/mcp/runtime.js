// Tiny stateless MCP server over Streamable HTTP (JSON responses). Zero dependencies.
// Runs on Cloudflare Workers, Deno, Bun and Node (via `jev mcp dev`).
//
//   export default serve({ name, version, tools: [{ name, description, inputSchema, annotations, run }] })

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const TYPES = { string: v => typeof v === 'string', number: v => typeof v === 'number', integer: Number.isInteger, boolean: v => typeof v === 'boolean', array: Array.isArray, object: v => v && typeof v === 'object' && !Array.isArray(v) }

export function validate(schema = {}, args = {}) {
  for (const k of schema.required || []) if (args[k] === undefined) return `Missing required argument "${k}"`
  for (const [k, v] of Object.entries(args)) {
    const s = schema.properties?.[k]
    if (!s) continue
    if (s.type && TYPES[s.type] && !TYPES[s.type](v)) return `Argument "${k}" must be ${s.type}`
    if (s.enum && !s.enum.includes(v)) return `Argument "${k}" must be one of ${s.enum.join(', ')}`
  }
  return null
}

export function serve({ name, version = '0.1.0', instructions, tools = [], resources = [], prompts = [] }) {
  const byName = new Map(tools.map(t => [t.name, t]))
  const rpc = async (msg, env) => {
    const p = msg.params || {}
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0],
          capabilities: { tools: {}, ...(resources.length && { resources: {} }), ...(prompts.length && { prompts: {} }) },
          serverInfo: { name, version }, ...(instructions && { instructions }),
        }
      case 'ping': return {}
      case 'tools/list': return { tools: tools.map(({ run, ...t }) => ({ inputSchema: { type: 'object' }, ...t })) }
      case 'tools/call': {
        const tool = byName.get(p.name)
        if (!tool) throw Object.assign(new Error(`Unknown tool ${p.name}`), { code: -32602 })
        const bad = validate(tool.inputSchema, p.arguments)
        if (bad) return { content: [{ type: 'text', text: bad }], isError: true }
        try {
          const out = await tool.run(p.arguments || {}, env)
          return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] }
        } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } }
      }
      case 'resources/list': return { resources: resources.map(({ read, ...r }) => r) }
      case 'resources/read': {
        const r = resources.find(r => r.uri === p.uri)
        if (!r) throw Object.assign(new Error(`Unknown resource ${p.uri}`), { code: -32602 })
        return { contents: [{ uri: r.uri, mimeType: r.mimeType || 'text/plain', text: await r.read(env) }] }
      }
      case 'prompts/list': return { prompts: prompts.map(({ get, ...x }) => x) }
      case 'prompts/get': {
        const x = prompts.find(x => x.name === p.name)
        if (!x) throw Object.assign(new Error(`Unknown prompt ${p.name}`), { code: -32602 })
        return { messages: [{ role: 'user', content: { type: 'text', text: await x.get(p.arguments || {}, env) } }] }
      }
      default: throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 })
    }
  }
  const one = async (msg, env) => {
    if (msg.id === undefined) return null // notification
    try { return { jsonrpc: '2.0', id: msg.id, result: await rpc(msg, env) } }
    catch (e) { return { jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } } }
  }
  async function fetch(req, env = {}) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    const { pathname } = new URL(req.url)
    if (pathname !== '/mcp') return Response.json({ name, version, mcp: '/mcp', tools: tools.map(t => t.name) }, { headers: cors })
    if (env.MCP_TOKEN && (req.headers.get('authorization') || '') !== `Bearer ${env.MCP_TOKEN}`)
      return Response.json({ error: 'unauthorized' }, { status: 401, headers: { ...cors, 'www-authenticate': 'Bearer' } })
    if (req.method === 'GET' && !(req.headers.get('accept') || '').includes('text/event-stream')) return new Response(page(name, version, tools, req.url), { headers: { ...cors, 'content-type': 'text/html; charset=utf-8' } })
    // Stateless server: no server-initiated stream. 405 is the spec's answer and clients fall back to POST.
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { ...cors, allow: 'POST' } })
    let body
    try { body = await req.json() } catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400, headers: cors }) }
    const out = Array.isArray(body) ? (await Promise.all(body.map(m => one(m, env)))).filter(Boolean) : await one(body, env)
    if (!out || (Array.isArray(out) && !out.length)) return new Response(null, { status: 202, headers: cors })
    return Response.json(out, { headers: cors })
  }
  return { fetch, name, version, tools }
}

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const page = (name, version, tools, url) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name)} MCP</title>
<style>:root{color-scheme:light dark;--bg:#f2f3ef;--fg:#15171a;--mut:#5b6168;--line:#d6d9d2;--code:#1b1e23}@media(prefers-color-scheme:dark){:root{--bg:#0f1114;--fg:#e8eaed;--mut:#9aa2ab;--line:#2a3038;--code:#0b0d10}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:48px max(16px,env(safe-area-inset-left))}
h1{font-size:28px;margin:0 0 4px}p{color:var(--mut);margin:0 0 24px}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:28px 0 8px}
pre{background:var(--code);color:#dfe3e8;padding:12px 14px;border-radius:8px;overflow-x:auto;font:13px/1.6 ui-monospace,Menlo,monospace;margin:0 0 8px}li{margin:4px 0}code{font-family:ui-monospace,Menlo,monospace}</style>
<main><h1>${esc(name)}</h1><p>MCP server v${esc(version)} · Streamable HTTP · this URL is meant for MCP clients, not browsers.</p>
<h2>Claude Code</h2><pre>claude mcp add --transport http --scope user ${esc(name)} ${esc(url)}</pre>
<h2>Codex</h2><pre>codex mcp add ${esc(name)} --url ${esc(url)}</pre>
<h2>Cursor (~/.cursor/mcp.json)</h2><pre>{ "mcpServers": { "${esc(name)}": { "url": "${esc(url)}" } } }</pre>
<h2>Tools</h2><ul>${tools.map(t => `<li><code>${esc(t.name)}</code> — ${esc(t.description || '')}</li>`).join('')}</ul></main>`

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'mcp-session-id' }
