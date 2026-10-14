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
