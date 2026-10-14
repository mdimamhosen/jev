// OpenAI Responses (Codex) ⇄ OpenAI Chat Completions.
import { sseJson, event, rid, packId, restoreSignatures } from './sse.js'

const text = (c) => typeof c === 'string' ? c : (c || []).map(p => p.text ?? '').join('')
const parts = (c) => typeof c === 'string' ? c : c.some(p => p.type === 'input_image')
  ? c.map(p => p.type === 'input_image' ? { type: 'image_url', image_url: { url: p.image_url } } : { type: 'text', text: p.text ?? '' })
  : text(c)

export function toChat(body) {
  const messages = []
  if (body.instructions) messages.push({ role: 'system', content: body.instructions })
  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || []
  const call = (id, name, args) => {
    const last = messages[messages.length - 1]
    const tc = { id, type: 'function', function: { name, arguments: args } }
    if (last?.role === 'assistant') (last.tool_calls ||= []).push(tc)
    else messages.push({ role: 'assistant', content: null, tool_calls: [tc] })
  }
  for (const it of items) {
    const type = it.type || 'message'
    if (type === 'message') {
      const role = it.role === 'developer' ? 'system' : it.role
      messages.push({ role, content: role === 'user' ? parts(it.content) : text(it.content) })
    } else if (type === 'function_call') call(it.call_id, it.name, it.arguments || '{}')
    else if (type === 'custom_tool_call') call(it.call_id, it.name, JSON.stringify({ input: it.input }))
    else if (type === 'function_call_output' || type === 'custom_tool_call_output')
      messages.push({ role: 'tool', tool_call_id: it.call_id, content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output) })
    // reasoning / web_search_call items are provider-specific and dropped.
  }
  const out = { messages: restoreSignatures(messages), stream: !!body.stream }
  if (body.stream) out.stream_options = { include_usage: true }
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens
  const tools = (body.tools || []).flatMap(t =>
    t.type === 'function' ? [{ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object' } } }]
    : t.type === 'custom' ? [{ type: 'function', function: { name: t.name, description: t.description || '', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } }]
    : [])
  if (tools.length) {
    out.tools = tools
    const tc = body.tool_choice
    if (tc) out.tool_choice = typeof tc === 'string' ? tc : { type: 'function', function: { name: tc.name } }
    if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls
  }
  return out
}

// Custom (freeform) tools were sent as {input: string} functions; map calls back.
const customNames = (body) => new Set((body.tools || []).filter(t => t.type === 'custom').map(t => t.name))

function callItem(id, name, args, custom) {
  if (custom.has(name)) {
    let input = args
    try { input = JSON.parse(args).input ?? args } catch {}
    return { type: 'custom_tool_call', id: rid('ctc_'), call_id: id, name, input, status: 'completed' }
  }
  return { type: 'function_call', id: rid('fc_'), call_id: id, name, arguments: args, status: 'completed' }
}

const usageOf = (u = {}) => ({ input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens || 0 })
const shell = (id, model, status, output = [], usage) => ({ id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model, output, ...(usage && { usage }) })
const msgItem = (id, t, status = 'completed') => ({ type: 'message', id, role: 'assistant', status, content: t === null ? [] : [{ type: 'output_text', text: t, annotations: [] }] })

export function fromChat(json, model, req) {
  const c = json.choices?.[0]?.message || {}
  const custom = customNames(req)
  const output = []
  if (c.content) output.push(msgItem(rid('msg_'), c.content))
  for (const t of c.tool_calls || []) output.push(callItem(packId(t.id || rid('call_'), t), t.function.name, t.function.arguments || '{}', custom))
  return shell(rid('resp_'), model, 'completed', output, usageOf(json.usage))
}

export async function* fromChatStream(stream, model, req) {
  const custom = customNames(req)
  const id = rid('resp_')
  let seq = 0
  const ev = (type, data) => event(type, { sequence_number: seq++, ...data })
  yield ev('response.created', { response: shell(id, model, 'in_progress') })
  const output = []
  let msg = null, usage
  const calls = new Map() // chat index → {item, args, oi}
  const closeMsg = function* () {
    if (!msg) return
    yield ev('response.output_text.done', { item_id: msg.id, output_index: msg.oi, content_index: 0, text: msg.text })
    yield ev('response.content_part.done', { item_id: msg.id, output_index: msg.oi, content_index: 0, part: { type: 'output_text', text: msg.text, annotations: [] } })
    const item = msgItem(msg.id, msg.text)
    output[msg.oi] = item
    yield ev('response.output_item.done', { output_index: msg.oi, item })
    msg = null
  }
  for await (const chunk of sseJson(stream)) {
    if (chunk.usage) usage = chunk.usage
    const d = chunk.choices?.[0]?.delta
    if (!d) continue
    if (d.content) {
      if (!msg) {
        msg = { id: rid('msg_'), oi: output.length, text: '' }
        output.push(null)
        yield ev('response.output_item.added', { output_index: msg.oi, item: msgItem(msg.id, null, 'in_progress') })
        yield ev('response.content_part.added', { item_id: msg.id, output_index: msg.oi, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      }
      msg.text += d.content
      yield ev('response.output_text.delta', { item_id: msg.id, output_index: msg.oi, content_index: 0, delta: d.content })
    }
    for (const t of d.tool_calls || []) {
      const ti = t.index ?? 0
      if (!calls.has(ti)) {
        yield* closeMsg()
        const c = { callId: packId(t.id || rid('call_'), t), name: t.function?.name || '', args: '', oi: output.length, fid: rid('fc_') }
        calls.set(ti, c)
        output.push(null)
        yield ev('response.output_item.added', { output_index: c.oi, item: { type: 'function_call', id: c.fid, call_id: c.callId, name: c.name, arguments: '', status: 'in_progress' } })
      }
      const c = calls.get(ti)
      if (t.function?.arguments) {
        c.args += t.function.arguments
        yield ev('response.function_call_arguments.delta', { item_id: c.fid, output_index: c.oi, delta: t.function.arguments })
      }
    }
  }
  yield* closeMsg()
  for (const c of calls.values()) {
    const item = { ...callItem(c.callId, c.name, c.args || '{}', custom), id: c.fid }
    output[c.oi] = item
    if (item.type === 'function_call') yield ev('response.function_call_arguments.done', { item_id: c.fid, output_index: c.oi, arguments: item.arguments })
    yield ev('response.output_item.done', { output_index: c.oi, item })
  }
  yield ev('response.completed', { response: shell(id, model, 'completed', output, usageOf(usage)) })
}
