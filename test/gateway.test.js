import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { handle, hooks } from '../src/app.js'
import { classify, inspect } from '../src/router.js'

hooks.onRoute = () => {}
let calls
const sse = (chunks) => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
const mock = (fn) => { calls = []; globalThis.fetch = async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, body, headers: init.headers }); return fn(url, body, calls.length) } }
const post = (path, body, env, headers = {}) => handle(new Request('http://x' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env)
const GROQ = { JEV_LOCAL: '1', GROQ_API_KEY: 'g' }

const chatReply = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
const toolStream = [
  { choices: [{ delta: { content: 'Let me check.' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"ci' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]
const events = async (res) => (await res.text()).split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)))

beforeEach(() => mock(() => Response.json(chatReply)))

test('classifier picks tiers by task', () => {
  const c = (text) => classify(inspect({ messages: [{ role: 'user', content: text }] }, 'chat'))
  assert.equal(c('Explain this function').tier, 1)
  assert.equal(c('Rename these variables').tier, 1)
  assert.equal(c('Fix the failing test in parser.ts').tier, 2)
  assert.equal(c('Debug this race condition across the repository').tier, 3)
  assert.equal(classify(inspect({ messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>fix the error</system-reminder>' }, { type: 'text', text: 'Explain this' }] }] }, 'anthropic')).task, 'explanation')
  assert.equal(c('Review this authentication implementation for security vulnerabilities').task, 'security_review')
})

test('refuses to run open in the cloud, accepts the right key', async () => {
  assert.equal((await post('/v1/chat/completions', {}, {})).status, 401)
  assert.equal((await post('/v1/chat/completions', { messages: [] }, { JEV_API_KEY: 'k', GROQ_API_KEY: 'g' }, { authorization: 'Bearer nope' })).status, 401)
  assert.equal((await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { JEV_API_KEY: 'k', GROQ_API_KEY: 'g' }, { authorization: 'Bearer k' })).status, 200)
})

test('Claude Code → non-Anthropic model: Messages translated to chat and back', async () => {
  const res = await post('/v1/messages', {
    model: 'jev-auto', max_tokens: 100, system: [{ type: 'text', text: 'be brief' }],
    tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: 'Weather in Paris?' }],
  }, GROQ)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('x-jev-route'), /^groq\//)
  const sent = calls[0].body
  assert.equal(sent.messages[0].role, 'system')
  assert.equal(sent.tools.length, 1)
  const out = await res.json()
  assert.equal(out.stop_reason, 'tool_use')
  assert.deepEqual(out.content[0], { type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'Paris' } })
})

test('Claude Code tool results become chat tool messages', async () => {
  await post('/v1/messages', { model: 'jev-fast', max_tokens: 10, messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'ls', input: { p: '.' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }, { type: 'text', text: 'continue' }] },
  ] }, GROQ)
  const m = calls[0].body.messages
  assert.deepEqual(m[1].tool_calls[0], { id: 't1', type: 'function', function: { name: 'ls', arguments: '{"p":"."}' } })
  assert.deepEqual(m[2], { role: 'tool', tool_call_id: 't1', content: 'a.txt' })
  assert.deepEqual(m[3], { role: 'user', content: 'continue' })
})

test('Anthropic stream translation emits valid event sequence', async () => {
  mock(() => sse(toolStream))
  const ev = await events(await post('/v1/messages', { model: 'jev-auto', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, GROQ))
  assert.deepEqual(ev.map(e => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
  assert.equal(ev[4].content_block.name, 'get_weather')
  assert.equal(ev[5].delta.partial_json + ev[6].delta.partial_json, '{"city":"Paris"}')
  assert.equal(ev[8].delta.stop_reason, 'tool_use')
  assert.equal(ev[8].usage.output_tokens, 5)
})

test('Codex → chat model: Responses stream translation', async () => {
  mock(() => sse(toolStream))
  const ev = await events(await post('/v1/responses', {
    model: 'jev-auto', stream: true, instructions: 'sys',
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'function_call', call_id: 'a', name: 'shell', arguments: '{}' }, { type: 'function_call_output', call_id: 'a', output: 'ok' }],
  }, GROQ))
  const sent = calls[0].body.messages
  assert.deepEqual(sent.map(m => m.role), ['system', 'user', 'assistant', 'tool'])
  const done = ev.filter(e => e.type === 'response.output_item.done').map(e => e.item)
  assert.equal(done[0].content[0].text, 'Let me check.')
  assert.deepEqual([done[1].type, done[1].name, done[1].arguments], ['function_call', 'get_weather', '{"city":"Paris"}'])
  const last = ev[ev.length - 1]
  assert.equal(last.type, 'response.completed')
  assert.equal(last.response.output.length, 2)
  assert.equal(last.response.usage.input_tokens, 10)
})

test('native passthrough: Claude Code → Anthropic keeps body and headers', async () => {
  mock(() => Response.json({ id: 'msg', content: [] }))
  const body = { model: 'jev-auto', max_tokens: 5, messages: [{ role: 'user', content: 'Explain this' }] }
  const res = await post('/v1/messages?beta=true', body, { JEV_LOCAL: '1', ANTHROPIC_API_KEY: 'a' }, { 'anthropic-beta': 'x' })
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages?beta=true')
  assert.equal(calls[0].body.model, 'claude-haiku-5-5')
  assert.equal(calls[0].headers['anthropic-beta'], 'x')
  assert.equal(calls[0].headers['x-api-key'], 'a')
  assert.deepEqual(await res.json(), { id: 'msg', content: [] })
})

test('falls back to the next model on 429/5xx', async () => {
  mock((url, body, n) => n === 1 ? new Response('busy', { status: 503 }) : Response.json(chatReply))
  const res = await post('/v1/chat/completions', { model: 'jev-fast', messages: [{ role: 'user', content: 'Explain x' }] }, { ...GROQ, CEREBRAS_API_KEY: 'c' })
  assert.equal(res.status, 200)
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].body.model, calls[1].body.model)
})

test('escalates a tier after repeated tool errors', () => {
  const body = { messages: [{ role: 'user', content: 'Explain x' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', is_error: true, content: 'boom' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '2', is_error: true, content: 'boom' }] }] }
  assert.equal(inspect(body, 'anthropic').errors, 2)
})

test('no keys → helpful 503', async () => {
  const res = await post('/v1/chat/completions', { model: 'jev-auto', messages: [] }, { JEV_LOCAL: '1' })
  assert.equal(res.status, 503)
  assert.match((await res.json()).error.message, /GEMINI_API_KEY/)
})
