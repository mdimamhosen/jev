// Anthropic Messages (Claude Code) ⇄ OpenAI Chat Completions.
import { sseJson, event, rid, packId, restoreSignatures } from './sse.js'

const str = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text ?? '').join('\n') : JSON.stringify(c ?? '')

const image = (b) => ({
  type: 'image_url',
  image_url: { url: b.source?.type === 'url' ? b.source.url : `data:${b.source?.media_type};base64,${b.source?.data}` },
})

export function toChat(body) {
  const messages = []
  if (body.system) messages.push({ role: 'system', content: str(body.system) })
  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') { messages.push({ role: msg.role, content: msg.content }); continue }
    if (msg.role === 'assistant') {
      const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('')
      const calls = msg.content.filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
      messages.push({ role: 'assistant', content: text || null, ...(calls.length && { tool_calls: calls }) })
      continue
    }
    // Tool results must directly follow the assistant tool_calls, so emit them first.
    for (const b of msg.content) if (b.type === 'tool_result')
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? '[error] ' : '') + str(b.content) })
    const parts = msg.content.filter(b => b.type === 'text' || b.type === 'image')
      .map(b => b.type === 'text' ? { type: 'text', text: b.text } : image(b))
    if (parts.length) messages.push({ role: 'user', content: parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n') : parts })
  }
  const out = { messages: restoreSignatures(messages), stream: !!body.stream }
  if (body.stream) out.stream_options = { include_usage: true }
  if (body.max_tokens) out.max_tokens = body.max_tokens
  // Server tools (web_search_…, etc.) have a dated `type`; only client tools translate.
  const tools = (body.tools || []).filter(t => !t.type || t.type === 'custom')
  if (tools.length) {
    out.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object' } } }))
    const tc = body.tool_choice
    if (tc) out.tool_choice = tc.type === 'any' ? 'required' : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } } : tc.type
  }
  return out
}

const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use' }
const parse = (s) => { try { return JSON.parse(s || '{}') } catch { return {} } }

export function fromChat(json, model) {
  const c = json.choices?.[0] || {}
  const content = []
  if (c.message?.content) content.push({ type: 'text', text: c.message.content })
  for (const t of c.message?.tool_calls || [])
    content.push({ type: 'tool_use', id: packId(t.id || rid('toolu_'), t), name: t.function.name, input: parse(t.function.arguments) })
  return {
    id: rid('msg_'), type: 'message', role: 'assistant', model, content,
    stop_reason: STOP[c.finish_reason] || 'end_turn', stop_sequence: null,
    usage: { input_tokens: json.usage?.prompt_tokens || 0, output_tokens: json.usage?.completion_tokens || 0 },
  }
}

export async function* fromChatStream(stream, model) {
  yield event('message_start', { message: { id: rid('msg_'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
  let idx = -1, open = null, stop = 'end_turn', usage = {}
  const tools = new Map() // chat tool index → anthropic block index
  const close = function* () { if (open) { yield event('content_block_stop', { index: idx }); open = null } }
  for await (const chunk of sseJson(stream)) {
    if (chunk.usage) usage = chunk.usage
    const c = chunk.choices?.[0]
    if (!c) continue
    const d = c.delta || {}
    if (d.content) {
      if (open !== 'text') { yield* close(); idx++; open = 'text'; yield event('content_block_start', { index: idx, content_block: { type: 'text', text: '' } }) }
      yield event('content_block_delta', { index: idx, delta: { type: 'text_delta', text: d.content } })
    }
    for (const t of d.tool_calls || []) {
      const ti = t.index ?? 0
      if (!tools.has(ti)) {
        yield* close(); idx++; open = 'tool'; tools.set(ti, idx)
        yield event('content_block_start', { index: idx, content_block: { type: 'tool_use', id: packId(t.id || rid('toolu_'), t), name: t.function?.name, input: {} } })
      }
      if (t.function?.arguments) yield event('content_block_delta', { index: tools.get(ti), delta: { type: 'input_json_delta', partial_json: t.function.arguments } })
    }
    if (c.finish_reason) stop = STOP[c.finish_reason] || 'end_turn'
  }
  yield* close()
  yield event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } })
  yield event('message_stop', {})
}
