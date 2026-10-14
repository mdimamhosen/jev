// Minimal node:http → fetch-handler bridge (no Express, no deps).
import http from 'node:http'
import { Readable } from 'node:stream'

export function listen(handler, { port, host }) {
  const server = http.createServer(async (req, res) => {
    try {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const request = new Request(`http://${req.headers.host || host}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: 'half',
      })
      const r = await handler(request)
      res.writeHead(r.status, Object.fromEntries(r.headers))
      if (r.body) {
        const reader = r.body.getReader()
        res.on('close', () => reader.cancel().catch(() => {}))
        for (let c; !(c = await reader.read()).done;) res.write(c.value)
      }
      res.end()
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(e?.message || e) } }))
    }
  })
  server.keepAliveTimeout = 65_000
  return new Promise((ok) => server.listen(port, host, () => ok(server)))
}
