// Parse an OpenAI-style SSE stream into JSON chunks.
export async function* sseJson(stream) {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try { yield JSON.parse(data) } catch { /* ignore keep-alive junk */ }
    }
  }
}

export const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

// Turn an async generator of strings into a byte stream.
export function toStream(gen) {
  const enc = new TextEncoder()
  return new ReadableStream({
    async pull(c) {
      try {
        const { done, value } = await gen.next()
        done ? c.close() : c.enqueue(enc.encode(value))
      } catch (e) { c.error(e) }
    },
    cancel() { gen.return?.() },
  })
}

export const rid = (p) => p + Math.random().toString(36).slice(2, 14) + Date.now().toString(36)

// Gemini 3 returns a thought_signature with each tool call and rejects the next turn without it.
// Carry it inside the tool-call id (clients echo ids verbatim) so routing stays stateless.
const SIG = '__jevsig__'
const b64url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); return s + '='.repeat((4 - s.length % 4) % 4) }

export function packId(id, tc) {
  const sig = tc?.extra_content?.google?.thought_signature
  return sig ? `${id}${SIG}${b64url(sig)}` : id
}

export function unpackId(id = '') {
  const i = id.indexOf(SIG)
  return i < 0 ? { id } : { id: id.slice(0, i), sig: unb64url(id.slice(i + SIG.length)) }
}

// Apply to an outgoing chat request: restore real ids + signatures.
export function restoreSignatures(messages) {
  for (const m of messages) {
    for (const tc of m.tool_calls || []) {
      const { id, sig } = unpackId(tc.id)
      tc.id = id
      if (sig) tc.extra_content = { google: { thought_signature: sig } }
    }
    if (m.tool_call_id) m.tool_call_id = unpackId(m.tool_call_id).id
  }
  return messages
}
