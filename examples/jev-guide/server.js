import { serve } from './mcp.js'
import { classify, inspect, ALIASES } from '../../src/router.js'

const CLIENTS = ['claude-code', 'codex', 'cursor']
const DEFAULT_URL = 'http://127.0.0.1:4000'

const setup = {
  'claude-code': (url, key) => `Add to the "env" block of ~/.claude/settings.json (or run \`jev setup\`):

${JSON.stringify({ ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: 'jev-auto', ANTHROPIC_DEFAULT_SONNET_MODEL: 'jev-auto', ANTHROPIC_DEFAULT_OPUS_MODEL: 'jev-smart', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'jev-fast' }, null, 2)}`,
  codex: (url, key) => `Add to ~/.codex/config.toml (or run \`jev setup\`). Top-level keys must come before any [table]:

model = "jev-auto"
model_provider = "jev"

[model_providers.jev]
name = "JEV"
base_url = "${url}/v1"
wire_api = "responses"${key !== '<your JEV key>' ? `\nhttp_headers = { "Authorization" = "Bearer ${key}" }` : ''}`,
  cursor: (url, key) => `Cursor → Settings → Models → API Keys:

OpenAI API Key: ${key}
Override OpenAI Base URL: ${url}/v1
Custom model: jev-auto

Cursor calls custom endpoints from its own servers, so ${url} must be publicly reachable (deploy with \`jev deploy\`). Cursor Tab always uses Cursor's own models.`,
}

const urlSchema = { type: 'string', description: `JEV gateway base URL (default ${DEFAULT_URL})` }

export default serve({
  name: 'jev-guide',
  version: '0.1.0',
  instructions: 'Tools for setting up JEV, the model router for Claude Code, Codex and Cursor, and for installing MCP servers into those clients.',
  tools: [
    {
      name: 'route_prompt',
      description: 'Shows which task class and model tier JEV\'s jev-auto router would pick for a coding prompt. Use to explain or predict routing decisions.',
      inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'The user prompt to classify' } }, required: ['prompt'] },
      annotations: { readOnlyHint: true },
      run: ({ prompt }) => {
        const { task, tier } = classify(inspect({ messages: [{ role: 'user', content: prompt }] }, 'chat'))
        return { task, tier, tier_name: ['fast', 'smart', 'frontier'][tier - 1] }
      },
    },
    {
      name: 'get_client_setup',
      description: 'Returns the exact configuration that points Claude Code, Codex or Cursor at a JEV gateway. Use when a user asks how to connect a coding agent to JEV.',
      inputSchema: {
        type: 'object',
        properties: { client: { type: 'string', enum: CLIENTS, description: 'Which coding agent to configure' }, url: urlSchema, key: { type: 'string', description: 'JEV API key, if the gateway requires one' } },
        required: ['client'],
      },
      annotations: { readOnlyHint: true },
      run: ({ client, url = DEFAULT_URL, key }) => setup[client](url.replace(/\/+$/, ''), key || '<your JEV key>'),
    },
    {
      name: 'get_mcp_install_commands',
      description: 'Returns the commands that install a remote MCP server into Claude Code, Codex and Cursor, plus a one-click Cursor install link. Use when a user wants to add an MCP server URL to their agents.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Short server name, e.g. "weather"' }, url: { type: 'string', description: 'Streamable HTTP MCP URL, e.g. https://example.com/mcp' } },
        required: ['name', 'url'],
      },
      annotations: { readOnlyHint: true },
      run: ({ name, url }) => {
        if (!/^[\w.-]+$/.test(name)) throw new Error('name may only contain letters, digits, ".", "_" and "-"')
        if (!/^https?:\/\//.test(url)) throw new Error('url must start with http:// or https://')
        const link = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${btoa(JSON.stringify({ url }))}`
        return `Claude Code:\n  claude mcp add --transport http --scope user ${name} ${url}\n\nCodex:\n  codex mcp add ${name} --url ${url}\n\nCursor (~/.cursor/mcp.json):\n  ${JSON.stringify({ mcpServers: { [name]: { url } } })}\n\nCursor one-click link:\n  ${link}\n\nAll at once:\n  npx jevrouter mcp install ${name} ${url}`
      },
    },
    {
      name: 'list_model_aliases',
      description: 'Lists the JEV model names (jev-auto, jev-fast, …) and what each one does. Use when choosing which model name to configure.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      run: () => ({
        aliases: ALIASES,
        'jev-auto': 'Classifies each prompt and picks the tier (default)',
        'jev-fast': 'Fast tier only',
        'jev-smart': 'Frontier tier only',
        'jev-cheap': 'Cheapest available model',
        'jev-free': 'Free-tier and local providers only',
      }),
    },
  ],
})
