// Protocols: 'anthropic' (Messages API), 'responses' (OpenAI Responses), 'chat' (OpenAI Chat Completions).
// Each provider lists the base URL for every protocol it speaks natively.
export const PROVIDERS = {
  anthropic: { key: 'ANTHROPIC_API_KEY', anthropic: 'https://api.anthropic.com', chat: 'https://api.anthropic.com/v1' },
  openai: { key: 'OPENAI_API_KEY', responses: 'https://api.openai.com/v1', chat: 'https://api.openai.com/v1', maxKey: 'max_completion_tokens' },
  gemini: { key: 'GEMINI_API_KEY', chat: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  groq: { key: 'GROQ_API_KEY', chat: 'https://api.groq.com/openai/v1' },
  cerebras: { key: 'CEREBRAS_API_KEY', chat: 'https://api.cerebras.ai/v1' },
  openrouter: { key: 'OPENROUTER_API_KEY', chat: 'https://openrouter.ai/api/v1' },
  deepseek: { key: 'DEEPSEEK_API_KEY', anthropic: 'https://api.deepseek.com/anthropic', chat: 'https://api.deepseek.com/v1' },
  mistral: { key: 'MISTRAL_API_KEY', chat: 'https://api.mistral.ai/v1' },
  // Local: the env var is the base URL itself, e.g. OLLAMA_BASE_URL=http://localhost:11434/v1
  ollama: { key: 'OLLAMA_BASE_URL', chat: 'http://localhost:11434/v1', keyIsUrl: true },
}

const m = (id, provider, tier, ctx, input, output, extra = {}) => ({ id, provider, tier, ctx, input, output, tools: true, ...extra })

// tier: 1 fast, 2 smart, 3 frontier. Prices are $/Mtok estimates used only for ranking —
// override or extend with ~/.jev/models.json (local) or the JEV_MODELS secret (cloud).
export const DEFAULT_MODELS = [
  m('claude-haiku-5-5', 'anthropic', 1, 200e3, 1, 5, { vision: true }),
  m('claude-sonnet-5-5', 'anthropic', 2, 200e3, 3, 15, { vision: true }),
  m('claude-opus-5-5', 'anthropic', 3, 200e3, 5, 25, { vision: true }),
  m('gpt-5-mini', 'openai', 1, 400e3, 0.25, 2, { vision: true }),
  m('gpt-5', 'openai', 3, 400e3, 1.25, 10, { vision: true }),
  m('gemini-2.5-flash', 'gemini', 1, 1e6, 0.3, 2.5, { vision: true, free: true }),
  m('gemini-3.5-flash', 'gemini', 2, 1e6, 0.5, 3, { vision: true, free: true }),
  m('gemini-pro-latest', 'gemini', 3, 1e6, 1.25, 10, { vision: true, free: true }),
  m('deepseek-chat', 'deepseek', 2, 128e3, 0.28, 0.42),
  m('openai/gpt-oss-120b', 'groq', 1, 131e3, 0.15, 0.75, { free: true }),
  m('llama-3.3-70b-versatile', 'groq', 1, 131e3, 0.59, 0.79, { free: true }),
  m('gpt-oss-120b', 'cerebras', 1, 131e3, 0.35, 0.75, { free: true }),
  m('qwen/qwen3-coder:free', 'openrouter', 1, 262e3, 0, 0, { free: true }),
  m('codestral-latest', 'mistral', 1, 256e3, 0.3, 0.9),
  m('qwen2.5-coder', 'ollama', 1, 32e3, 0, 0, { free: true }),
]

export function models(env) {
  if (!env.JEV_MODELS) return DEFAULT_MODELS
  const custom = typeof env.JEV_MODELS === 'string' ? JSON.parse(env.JEV_MODELS) : env.JEV_MODELS
  const byId = new Map(DEFAULT_MODELS.map(x => [x.id, x]))
  for (const c of custom) byId.set(c.id, { tools: true, tier: 2, ctx: 128e3, input: 1, output: 1, ...byId.get(c.id), ...c })
  return [...byId.values()]
}

export const available = (env) => models(env).filter(x => PROVIDERS[x.provider] && env[PROVIDERS[x.provider].key])
