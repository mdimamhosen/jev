# JEV

**One endpoint for every model. One CLI for every MCP tool.**
A zero-dependency model router and MCP toolkit for **Claude Code**, **Codex** and **Cursor**.

- One key, one model name, `jev-auto`, works the same way in every client.
- JEV picks a model for each request: cheap and fast for "rename this", frontier models for "debug this race condition".
- Build, test, deploy and install MCP servers in four commands.
- About 1,400 lines of plain JavaScript with **no dependencies**. It starts in roughly 30 ms and runs on Node, Bun, Deno and **Cloudflare Workers (free)**.

```
Claude Code ──/v1/messages──┐                      ┌── Anthropic · DeepSeek
Codex ───────/v1/responses──┼──▶  JEV  ──route──▶  ├── OpenAI
Cursor ──/v1/chat/completions┘   (jev-auto)        ├── Gemini · Groq · Cerebras · OpenRouter · Mistral
                                                   └── Ollama (local)
```

---

## 60-second setup

Requires Node 20.12 or newer.

```sh
npm install -g jevrouter                    # installs the `jev` command (or: npx jevrouter <command>)

echo "GEMINI_API_KEY=..." >> ~/.jev/.env    # any provider key works; Gemini and Groq have free tiers
jev serve                                   # http://127.0.0.1:4000
jev setup                                   # configures Claude Code, Codex and Cursor (with backups)
```

Then use your tools as usual:

```sh
claude      # Claude Code now runs through JEV
codex       # so does Codex
```

`jev doctor` checks every endpoint, streaming, tool calls and client config.
`jev uninstall-config` puts everything back exactly as it was.

## Free cloud deploy (Cloudflare Workers, about 2 minutes)

The same code runs on Cloudflare's free plan (100k requests a day, no cold starts). Cursor needs this, because it calls custom endpoints from Cursor's servers rather than from your machine.

```sh
npx wrangler login
jev deploy                                  # deploys and sets a generated JEV_API_KEY
npx wrangler secret put GEMINI_API_KEY      # add each provider key as a secret
jev setup --url https://jev.<you>.workers.dev --key <your JEV key>
```

In the cloud, JEV refuses every request until `JEV_API_KEY` is set, so it never runs as an open proxy.

### Other free options

| Need | Free option |
|---|---|
| Host JEV or MCP servers | Cloudflare Workers (recommended); the same code also runs on Deno Deploy and Vercel Edge |
| Always-on VM for local models | Oracle Cloud Always Free ARM VM running Ollama (small models, CPU only) |
| Free model APIs (`jev-free`) | Gemini API free tier, Groq, Cerebras, OpenRouter `:free` models, plus Ollama locally |
| Free GPU | There's no reliable free GPU for *serving* models (Colab and Kaggle forbid it). Use the free APIs above. |

Free tiers are rate-limited and change often, so check each provider's pricing page.

---

## Clients

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| Protocol | Anthropic Messages | OpenAI Responses | OpenAI Chat |
| Setup | automatic | automatic | 3 values to paste (copied for you) |
| Streaming | ✅ | ✅ | ✅ |
| Tool calls | ✅ | ✅ | ✅ |
| Smart routing and fallback | ✅ | ✅ | ✅ |
| Works with local `jev serve` | ✅ | ✅ | ❌ needs a public URL |
| Tab completion | — | — | ❌ handled by Cursor itself* |

\* Cursor sends custom-key traffic only for chat and agent models. Tab and other Cursor-owned features always use Cursor's own infrastructure.

### Claude Code

`jev setup` adds this to the `env` block of `~/.claude/settings.json`:

```json
"ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
"ANTHROPIC_AUTH_TOKEN": "<JEV key>",
"ANTHROPIC_MODEL": "jev-auto",
"ANTHROPIC_DEFAULT_SONNET_MODEL": "jev-auto",
"ANTHROPIC_DEFAULT_OPUS_MODEL": "jev-smart",
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "jev-fast"
```

Claude Code shows a one-time notice that `jev-auto` isn't in its model catalog. That's expected. Because JEV supplies the auth token, claude.ai connectors are switched off for that session.

### Codex

`jev setup` adds marked blocks to `~/.codex/config.toml`. Any existing top-level `model` is commented out, and the uninstall command restores it.

```toml
model = "jev-auto"
model_provider = "jev"

[model_providers.jev]
name = "JEV"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
```

When you pass `--key`, it's stored as an `http_headers` Authorization line in this file, so keep the file private.

### Cursor

Go to **Settings → Models → API Keys**:

- OpenAI API Key: your JEV key
- Override OpenAI Base URL: `https://jev.<you>.workers.dev/v1`
- Add a custom model named `jev-auto`

### Anything else

Any OpenAI- or Anthropic-compatible client works. Point it at the JEV URL and use `jev-auto` as the model.

---

## Models and routing

| Model name | Behaviour |
|---|---|
| `jev-auto` | Classifies the task and picks the tier (default) |
| `jev-fast` | Tier 1: fastest and cheapest |
| `jev-smart` | Tier 3: frontier models |
| `jev-cheap` | Cheapest model that's available |
| `jev-free` | Free-tier and local providers only |
| `gpt-5`, `openai/gpt-5`, … | Calls that exact model directly |

**How `jev-auto` decides.** No extra LLM call is involved; routing takes microseconds.

1. **Hard constraints.** It keeps only models whose provider key is set and that have a big enough context window, plus vision or tool support if the request needs them.
2. **Task class.** Simple keyword and request-shape rules sort the request into a task class and a tier:

   | Task | Tier | Example prompts |
   |---|---|---|
   | simple_edit, explanation | 1 | rename, typo, explain, docstring |
   | debugging, tests, review, code_generation | 2 | fix, implement, review |
   | architecture, hard_debugging, security_review, refactor | 3 | race condition, migrate, vulnerability |

3. **Ranking.** Candidates are sorted by closest tier, then by whether they speak the client's protocol natively (no translation, so faster), then by price.
4. **Session stickiness.** Tool-loop turns stay on the same model, which keeps behaviour consistent and provider caches warm. A new prompt is classified again.
5. **Fallback.** On 429, 5xx, a network error or a bad key, JEV tries the next candidate (up to 3 attempts).
6. **Escalation.** Two or more failed tool calls in recent turns bump the task one tier up.

Every response carries an `x-jev-route` header. `jev why` shows the recent decisions:

```
Client   claude-code
Task     hard_debugging (tier 3, alias jev-auto)
Model    anthropic/claude-opus-5-5
Reason   hard_debugging → tier 3
Status   200 in 1290 ms, est. input $0.0412
```

**Fast path.** When the chosen model speaks the client's protocol natively (Claude Code → Anthropic or DeepSeek, Codex → OpenAI, Cursor → any provider), JEV only rewrites `model` and the key, then streams the bytes straight through. Otherwise it translates between protocols, including streaming events and tool calls.

### Providers

Put keys in `~/.jev/.env` (local) or Worker secrets (cloud):

`ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `GEMINI_API_KEY` · `GROQ_API_KEY` · `CEREBRAS_API_KEY` · `OPENROUTER_API_KEY` · `DEEPSEEK_API_KEY` · `MISTRAL_API_KEY` · `OLLAMA_BASE_URL` (for example `http://localhost:11434/v1`)

`jev models` shows what's active.

### Your own model list

Create `~/.jev/models.json` locally, or set the `JEV_MODELS` secret in the cloud. Entries are merged by `id`:

```json
[
  { "id": "qwen3-coder:30b", "provider": "ollama", "tier": 2, "ctx": 128000, "input": 0, "output": 0, "free": true },
  { "id": "gpt-5", "tier": 2 }
]
```

The fields are `tier` (1 to 3), `ctx` (context tokens), `input`/`output` ($ per million tokens, used for ranking), `vision`, `tools` and `free`.

---

## MCP: create, test, deploy, install

```sh
jev mcp create weather -t rest-api   # or: jev mcp import openapi.json
cd weather
jev mcp dev                          # http://localhost:7337/mcp, reloads on save
jev mcp test .                       # protocol and tool checks
jev mcp lint .                       # tool quality and safety score
jev mcp deploy                       # free on Cloudflare Workers
jev mcp install weather https://weather.<you>.workers.dev/mcp
```

`jev mcp install` adds the server to every detected client at once:

| Client | What JEV does |
|---|---|
| Claude Code | `claude mcp add --transport http --scope user <name> <url>` |
| Codex | `codex mcp add <name> --url <url>` |
| Cursor | merges into `~/.cursor/mcp.json` and prints a one-click `cursor://` install link |

**Generated servers** have zero dependencies and are stateless Streamable HTTP, running on Workers, Node, Bun and Deno. You edit one file:

```js
import { serve } from './mcp.js'

export default serve({
  name: 'weather',
  tools: [{
    name: 'get_forecast',
    description: 'Gets the 3-day forecast for a city. Use when the user asks about upcoming weather.',
    inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
    annotations: { readOnlyHint: true },
    run: async ({ city }, env) => fetch(`https://api.example.com/forecast?q=${city}&key=${env.API_KEY}`).then(r => r.json()),
  }],
})
```

Resources (`resources: [{ uri, name, read }]`) and prompts (`prompts: [{ name, description, get }]`) are supported too.

**OpenAPI import** turns each operation into a tool, resolves `$ref`s, and **skips DELETE, admin, internal, debug and deprecated endpoints** unless you pass `--all`.

**`jev mcp test`** runs initialize, lists tools, resources and prompts, validates the schemas, checks unknown-tool errors, and calls every read-only tool with sample arguments. It works against a local folder with no server running, or against any URL, including third-party MCP servers.

**`jev mcp lint`** checks for generic tool names, thin descriptions, undocumented parameters, destructive tools without `destructiveHint`, duplicate descriptions and secrets in the source. It classifies each tool as READ_ONLY, WRITE or DESTRUCTIVE.

**Auth.** Set the `MCP_TOKEN` secret to require `Authorization: Bearer <token>`, then install with `--token <token>`.

**Publishing to the official MCP Registry.** `jev mcp publish` validates `server.json` and prints the `mcp-publisher` steps.

---

## Privacy

- JEV never stores prompts or responses. It logs only routing metadata (client, task, model, latency, estimated cost) to `~/.jev/usage.jsonl` locally, or to `wrangler tail` in the cloud.
- Provider keys stay in your env file or Worker secrets. JEV keys are compared in constant time.
- For local-only use, set only `OLLAMA_BASE_URL` and use `jev-free`.

## CLI reference

```
jev serve [-p 4000] [--host 127.0.0.1]     jev mcp create <name> [-t blank|rest-api]
jev setup [--url URL] [--key KEY] [-y]     jev mcp import <openapi.json|yaml> [name] [--all]
jev uninstall-config                       jev mcp dev [dir] [-p 7337]
jev doctor [--url URL]                     jev mcp test <dir|url> [--token T] [--no-call]
jev models                                 jev mcp lint <dir|url>
jev why                                    jev mcp deploy [dir]
jev usage                                  jev mcp install <name> <url> [--claude --codex --cursor] [--token T]
jev deploy                                 jev mcp uninstall <name>
                                           jev mcp publish [dir]
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `503 No model available` | No provider key is set. Run `jev models` and add one to `~/.jev/.env`. |
| `401 Set the JEV_API_KEY secret` | Cloud deploy without a key: `npx wrangler secret put JEV_API_KEY`. |
| Cursor can't connect | Cursor needs a public URL. Use `jev deploy`. |
| Codex says "model metadata not found" | Expected for `jev-auto`; it's harmless. |
| Something else | Run `jev doctor`, then `jev why`. |

## Architecture

```
src/app.js                 fetch handler: auth, endpoints, fallback loop      (runs on Workers as-is)
src/router.js              inspect → classify → constraints → rank → sticky sessions
src/providers.js           provider table + default model catalogue
src/translate/*.js         Messages ⇄ Chat and Responses ⇄ Chat, including SSE streams
src/node.js                node:http bridge for `jev serve`
src/clients.js             reversible Claude Code / Codex / Cursor config
src/mcp/runtime.js         ~100-line MCP server, copied into generated projects
src/mcp/{create,openapi,check}.js   scaffold, OpenAPI import, test + lint
bin/jev.js                 CLI
```

Run the tests with `npm test`. They use the built-in `node:test`, so there's nothing to install.

## Roadmap

Accounts and a hosted dashboard · encrypted BYOK vault · OAuth broker for MCP · a public MCP directory with trust scores · outcome-aware routing (cost per *successful* task) and a learned router · `jev-bench` · MCP composition and workflows · tunnels · Windows installer.

## License

MIT
