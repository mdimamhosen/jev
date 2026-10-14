import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexText, removeCodex } from '../src/clients.js'
import { toolsFromOpenAPI } from '../src/mcp/openapi.js'
import { scaffold, openapiServer, TEMPLATES } from '../src/mcp/create.js'
import { test as mcpTest, lint } from '../src/mcp/check.js'

test('codex config: setup then undo is byte-identical', () => {
  for (const original of ['', 'model = "o3"\n[profiles.x]\nmodel = "y"\n', 'approval_policy = "never"']) {
    const t = codexText(original, 'http://127.0.0.1:4000', 'k')
    assert.match(t, /^# >>> jev\nmodel = "jev-auto"/)
    if (original.includes('o3')) {
      assert.match(t, /# jev-disabled: model = "o3"/)
      assert.match(t, /\[profiles\.x\]\nmodel = "y"/) // table keys untouched
    }
    assert.equal(removeCodex(t), original)
    assert.equal(removeCodex(codexText(t, 'u', null)), original) // re-running setup is idempotent
  }
})

test('claude settings: setup then undo restores original', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-'))
  const old = process.env.HOME
  process.env.HOME = home
  try {
    const C = await import('../src/clients.js?' + Date.now())
    const file = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(file))
    const original = JSON.stringify({ theme: 'dark', env: { ANTHROPIC_MODEL: 'opus', FOO: '1' } }, null, 2) + '\n'
    fs.writeFileSync(file, original)
    C.setupClaude('http://127.0.0.1:4000', null)
    C.setupClaude('http://127.0.0.1:4000', null) // twice must still restore the true original
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.ANTHROPIC_MODEL, 'jev-auto')
    assert.ok(C.undoClaude())
    assert.equal(fs.readFileSync(file, 'utf8'), original)
    assert.ok(fs.readdirSync(path.join(home, '.jev', 'backups')).length)
  } finally { process.env.HOME = old }
})

const SPEC = {
  info: { title: 'Pets' }, servers: [{ url: 'https://pets.example/v1' }],
  components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } } },
  paths: {
    '/pets': { get: { operationId: 'listPets', summary: 'List pets in the store', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }] },
      post: { operationId: 'createPet', summary: 'Create a pet', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
    '/pets/{id}': { get: { operationId: 'getPet', summary: 'Get a pet by id', parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }] }, delete: { operationId: 'deletePet' } },
    '/admin/reset': { post: { operationId: 'adminReset' } },
  },
}

test('OpenAPI → tools skips destructive and internal endpoints', () => {
  const { tools, skipped } = toolsFromOpenAPI(SPEC)
  assert.deepEqual(tools.map(t => t.name), ['list_pets', 'create_pet', 'get_pet'])
  assert.deepEqual(skipped, ['DELETE /pets/{id}', 'POST /admin/reset'])
  assert.equal(tools[1].inputSchema.properties.body.properties.name.type, 'string')
  assert.deepEqual(tools[2].inputSchema.required, ['id'])
  assert.equal(toolsFromOpenAPI(SPEC, { all: true }).tools.length, 5)
})

test('generated MCP servers pass jev mcp test and lint in-process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-mcp-'))
  scaffold(path.join(dir, 'hello'), 'hello', TEMPLATES.blank())
  const r = await mcpTest(path.join(dir, 'hello'), { log: () => {} })
  assert.equal(r.fail, 0)
  assert.deepEqual(r.tools.map(t => t.name), ['say_hello'])
  assert.equal((await lint(path.join(dir, 'hello'))).score, 100)

  // OpenAPI server: fake the upstream API.
  const real = globalThis.fetch
  globalThis.fetch = async (url) => Response.json({ url: String(url) })
  try {
    scaffold(path.join(dir, 'pets'), 'pets', openapiServer('pets', SPEC, {}).src)
    const p = await mcpTest(path.join(dir, 'pets'), { log: () => {} })
    assert.equal(p.fail, 0)
    const server = (await import(path.join(dir, 'pets', 'server.js'))).default
    const res = await server.fetch(new Request('http://l/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_pet', arguments: { id: 'a b' } } }) }), {})
    assert.match((await res.json()).result.content[0].text, /pets\.example\/v1\/pets\/a%20b/)
  } finally { globalThis.fetch = real }
})

test('mcp server rejects bad args and enforces MCP_TOKEN', async () => {
  const { serve } = await import('../src/mcp/runtime.js')
  const s = serve({ name: 't', tools: [{ name: 'x', inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }, run: ({ n }) => n * 2 }] })
  const call = (args, env = {}, h = {}) => s.fetch(new Request('http://l/mcp', { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: args } }) }), env)
  assert.equal((await (await call({})).json()).result.isError, true)
  assert.equal((await (await call({ n: 'a' })).json()).result.isError, true)
  assert.equal((await (await call({ n: 2 })).json()).result.content[0].text, '4')
  assert.equal((await call({ n: 2 }, { MCP_TOKEN: 's' })).status, 401)
  assert.equal((await call({ n: 2 }, { MCP_TOKEN: 's' }, { authorization: 'Bearer s' })).status, 200)
})

test('GET /mcp: browser gets an install page, SSE clients get 405', async () => {
  const { serve } = await import('../src/mcp/runtime.js')
  const s = serve({ name: 'demo<x>', tools: [{ name: 'a', description: 'b', run: () => 1 }] })
  const html = await s.fetch(new Request('http://l/mcp', { headers: { accept: 'text/html' } }))
  assert.equal(html.status, 200)
  const body = await html.text()
  assert.match(body, /claude mcp add --transport http --scope user demo&lt;x&gt; http:\/\/l\/mcp/)
  assert.equal((await s.fetch(new Request('http://l/mcp', { headers: { accept: 'text/event-stream' } }))).status, 405)
})
