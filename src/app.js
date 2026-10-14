// JEV gateway: one Web-standard fetch handler for Node, Bun, Deno and Cloudflare Workers.
import { PROVIDERS, available } from './providers.js'
import { route, recent, ALIASES } from './router.js'
import * as A from './translate/anthropic.js'
import * as R from './translate/responses.js'
import { toStream } from './translate/sse.js'

export const hooks = { onRoute: (e) => console.log(JSON.stringify(e)) }

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })

const fail = (status, message) => json({ type: 'error', error: { type: 'jev_error', message } }, status)

function sameKey(a, b) {
  if (!a || a.length !== b.length) return false
  let x = 0
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return x === 0
}

function authorized(req, env) {
  if (!env.JEV_API_KEY) return !!env.JEV_LOCAL // never run an open proxy in the cloud
  const got = req.headers.get('x-api-key') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return sameKey(got, env.JEV_API_KEY)
}

const RETRY = (s) => s === 401 || s === 403 || s === 404 || s === 408 || s === 429 || s >= 500

async function upstream(model, proto, body, req, env, search) {
  const p = PROVIDERS[model.provider]
  const key = env[p.key]
  const native = !!p[proto]
  const target = native ? proto : 'chat'
  const base = p.keyIsUrl ? key : p[target]
  let payload, url, headers = { 'content-type': 'application/json' }

  if (native) payload = { ...body, model: model.id }
  else {
    payload = { ...(proto === 'anthropic' ? A.toChat(body) : R.toChat(body)), model: model.id }
    if (p.maxKey && payload.max_tokens) { payload[p.maxKey] = payload.max_tokens; delete payload.max_tokens }
  }
  if (target === 'anthropic') {
    url = `${base}/v1/messages${search}`
    headers['x-api-key'] = key
    headers['anthropic-version'] = req.headers.get('anthropic-version') || '2023-06-01'
    const beta = req.headers.get('anthropic-beta')
    if (beta) headers['anthropic-beta'] = beta
  } else {
    url = `${base}/${target === 'responses' ? 'responses' : 'chat/completions'}`
    if (!p.keyIsUrl) headers.authorization = `Bearer ${key}`
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
  return { res, native }
}

async function proxy(req, env, proto) {
  let body
  try { body = await req.json() } catch { return fail(400, 'Invalid JSON body') }
  const { list, decision, remember } = route(body, proto, req.headers, env)
  if (!list.length) return fail(503, `No model available for "${body.model}". Add a provider key (e.g. GEMINI_API_KEY or GROQ_API_KEY — both have free tiers).`)

  const search = new URL(req.url).search
  const alias = body.model || 'jev-auto'
  let last
  for (const model of list.slice(0, 3)) {
    const t0 = Date.now()
    let res, native
    try { ({ res, native } = await upstream(model, proto, body, req, env, search)) }
    catch (e) { last = fail(502, `${model.provider}: ${e.message}`); continue }
    if (RETRY(res.status) && model !== list[Math.min(2, list.length - 1)]) { last = res; res.body?.cancel(); continue }

    remember?.(model)
    const entry = { ts: new Date().toISOString(), ...decision, model: model.id, provider: model.provider, native, status: res.status, ms: Date.now() - t0, est_cost: +(decision.tokens * model.input / 1e6).toFixed(5) }
    recent.push(entry); if (recent.length > 50) recent.shift()
    try { hooks.onRoute(entry) } catch {}

    const headers = { 'x-jev-route': `${model.provider}/${model.id}; task=${decision.task}; tier=${decision.tier}` }
    const type = res.headers.get('content-type') || 'application/json'
    if (native || !res.ok) return new Response(res.body, { status: res.status, headers: { 'content-type': type, ...headers } })

    const T = proto === 'anthropic' ? A : R
    if (body.stream) return new Response(toStream(T.fromChatStream(res.body, alias, body)), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers } })
    return json(T.fromChat(await res.json(), alias, body), 200, headers)
  }
  return last
}

export async function handle(req, env = {}) {
  const { pathname } = new URL(req.url)
  const path = pathname.replace(/\/+$/, '').replace(/^\/v1(?=\/v1\/)/, '') // tolerate base URLs ending in /v1
  if (path === '' || path === '/health') return json({ ok: true, name: 'jev', models: available(env).length })
  if (!authorized(req, env)) return fail(401, env.JEV_API_KEY ? 'Invalid JEV key' : 'Set the JEV_API_KEY secret before exposing JEV publicly')

  if (path === '/v1/models' && req.method === 'GET') {
    const data = [...ALIASES.map(id => ({ id, owned_by: 'jev' })), ...available(env).map(m => ({ id: m.id, owned_by: m.provider }))]
    return json({ object: 'list', data: data.map(d => ({ ...d, object: 'model', created: 0, type: 'model', display_name: d.id })) })
  }
  if (path === '/jev/why') return json(recent.slice(-10).reverse())
  if (req.method !== 'POST') return fail(405, 'Method not allowed')
  if (path === '/v1/messages/count_tokens') {
    const b = await req.json().catch(() => ({}))
    return json({ input_tokens: Math.ceil(JSON.stringify(b).length / 4) })
  }
  if (path === '/v1/messages') return proxy(req, env, 'anthropic')
  if (path === '/v1/responses') return proxy(req, env, 'responses')
  if (path === '/v1/chat/completions') return proxy(req, env, 'chat')
  return fail(404, `Unknown path ${path}`)
}

export default { fetch: (req, env) => handle(req, env) }
