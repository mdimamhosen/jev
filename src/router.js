import { available, PROVIDERS } from './providers.js'

export const ALIASES = ['jev-auto', 'jev-fast', 'jev-smart', 'jev-cheap', 'jev-free']

// First match wins. Tier-1 rules only apply to short prompts.
const RULES = [
  [/architect|system design|distributed|from scratch/i, 'architecture', 3],
  [/race condition|deadlock|concurren|memory leak|root cause|heisenbug/i, 'hard_debugging', 3],
  [/security|vulnerab|exploit|injection|\bauth(entication|orization)? (flow|bypass)/i, 'security_review', 3],
  [/refactor|migrat|across (the )?(whole |entire )?(repo|codebase|project)/i, 'refactor', 3],
  [/rename|typo|docstring|add (a )?comment|format(ting)?\b|lint|one.?liner|commit message/i, 'simple_edit', 1],
  [/explain|what (does|is)|summar|translate|how do i/i, 'explanation', 1],
  [/debug|fix|bug|error|fail|broken|crash|stack ?trace|exception/i, 'debugging', 2],
  [/\btests?\b|spec|coverage/i, 'tests', 2],
  [/review/i, 'code_review', 2],
  [/implement|build|create|add|write|feature|endpoint|component|function|class|script/i, 'code_generation', 2],
]

const ERRORISH = /\berror\b|exit code:? ?[1-9]|failed|traceback|exception/i

const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(p => p.type === 'text' || p.type === 'input_text' || p.type === 'output_text' ? p.text : '').join('\n') : ''

// Pull routing signals out of any of the three protocols.
export function inspect(body, proto) {
  const msgs = proto === 'responses'
    ? (typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || [])
    : body.messages || []
  const users = msgs.filter(x => x.role === 'user')
  const last = msgs[msgs.length - 1] || {}
  const recent = msgs.slice(-12)
  let toolStep, errors = 0, images = false
  if (proto === 'anthropic') {
    const blocks = Array.isArray(last.content) ? last.content : []
    toolStep = last.role === 'user' && blocks.length > 0 && blocks.every(b => b.type === 'tool_result')
    for (const x of recent) if (Array.isArray(x.content)) for (const b of x.content) {
      if (b.type === 'tool_result' && b.is_error) errors++
      if (b.type === 'image') images = true
    }
  } else if (proto === 'responses') {
    toolStep = /_call_output$/.test(last.type || '')
    for (const x of recent) {
      if (/_call_output$/.test(x.type || '') && ERRORISH.test(typeof x.output === 'string' ? x.output : JSON.stringify(x.output))) errors++
      if (Array.isArray(x.content) && x.content.some(p => p.type === 'input_image')) images = true
    }
  } else {
    toolStep = last.role === 'tool'
    for (const x of recent) {
      if (x.role === 'tool' && ERRORISH.test(textOf(x.content))) errors++
      if (Array.isArray(x.content) && x.content.some(p => p.type === 'image_url')) images = true
    }
  }
  // Claude Code injects <system-reminder> blocks into user turns; they are not the user's request.
  const clean = (c) => textOf(c).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  return {
    text: clean(users[users.length - 1]?.content),
    first: textOf(users[0]?.content).slice(0, 500),
    toolStep, errors, images,
    tools: (body.tools || []).length,
    tokens: Math.ceil(JSON.stringify(body).length / 4),
  }
}

export function classify(info) {
  if (info.toolStep) return { task: 'agent_step', tier: 2 }
  const t = info.text
  for (const [re, task, tier] of RULES) {
    if (tier === 1 && t.length > 600) continue
    if (re.test(t)) return { task, tier: t.length > 6000 ? Math.max(tier, 2) : tier }
  }
  return { task: 'general', tier: 2 }
}

export function detectClient(headers, proto) {
  const h = headers.get('x-jev-client')
  if (h) return h
  const ua = headers.get('user-agent') || ''
  if (/claude-cli|claude-code/i.test(ua)) return 'claude-code'
  if (/codex/i.test(ua)) return 'codex'
  if (/cursor/i.test(ua)) return 'cursor'
  return { anthropic: 'claude-code', responses: 'codex', chat: 'openai-compatible' }[proto]
}

const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36) }

// shortcut: in-memory per process/isolate; move to KV/Redis when running multiple instances.
const sessions = new Map()
export const recent = []

function sessionKey(body, headers, client, info) {
  const id = headers.get('x-session-id') || headers.get('session_id') || headers.get('conversation_id') || body.metadata?.user_id
  return id ? `${client}:${id}` : `${client}:h${fnv(info.first)}`
}

const price = (x) => x.input + x.output / 4

export function route(body, proto, headers, env) {
  const all = available(env)
  const client = detectClient(headers, proto)
  const want = body.model || 'jev-auto'
  const info = inspect(body, proto)

  // Explicit model ("gpt-5" or "openai/gpt-5") skips classification.
  if (!ALIASES.includes(want)) {
    const hit = all.filter(x => x.id === want || `${x.provider}/${x.id}` === want)
    return { list: hit, decision: { client, task: 'explicit', tier: hit[0]?.tier, alias: want, reason: 'explicit model' } }
  }

  let { task, tier } = classify(info)
  if (want === 'jev-fast') tier = 1
  if (want === 'jev-smart') tier = 3
  const key = sessionKey(body, headers, client, info)
  const sticky = sessions.get(key)
  // Tool-loop turns continue on the session's tier; a fresh user prompt is re-classified.
  if (sticky && task === 'agent_step' && want === 'jev-auto') tier = sticky.tier
  let reason = `${task} → tier ${tier}`
  if (info.errors >= 2 && tier < 3) { tier++; reason += `, escalated (${info.errors} tool errors)` }

  const allowed = all.filter(x => want !== 'jev-free' || x.free)
  let fits = allowed.filter(x => x.ctx >= info.tokens && (!info.images || x.vision) && (!info.tools || x.tools))
  // Token count is a chars/4 estimate: if nothing "fits", try the largest windows and let the provider decide.
  if (!fits.length && allowed.length) { fits = allowed; reason += `, no model passed constraints (~${info.tokens} tokens)` }
  const dist = (x) => x.tier >= tier ? x.tier - tier : 10 + tier - x.tier
  const nonNative = (x) => PROVIDERS[x.provider][proto] ? 0 : 1
  const list = fits.sort(want === 'jev-cheap'
    ? (a, b) => price(a) - price(b) || dist(a) - dist(b)
    : (a, b) => dist(a) - dist(b) || nonNative(a) - nonNative(b) || price(a) - price(b))

  // Same tier → same model as last turn: consistent behaviour and warm provider caches.
  if (sticky && sticky.tier === tier) {
    const i = list.findIndex(x => x.id === sticky.model)
    if (i > 0) list.unshift(...list.splice(i, 1))
  }
  return { list, decision: { client, task, tier, alias: want, session: key, reason, tokens: info.tokens }, remember: (model) => {
    if (sessions.size > 5000) sessions.delete(sessions.keys().next().value)
    sessions.set(key, { model: model.id, tier })
  } }
}
