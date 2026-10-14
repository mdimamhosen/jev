// Detect, configure and restore Claude Code, Codex and Cursor. Every change is reversible.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

export const home = () => os.homedir()
export const jevDir = () => path.join(home(), '.jev')
const claudePath = () => path.join(home(), '.claude', 'settings.json')
const codexPath = () => path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'config.toml')
export const cursorMcpPath = () => path.join(home(), '.cursor', 'mcp.json')
const statePath = () => path.join(jevDir(), 'state.json')

const read = (p, d = '') => { try { return fs.readFileSync(p, 'utf8') } catch { return d } }
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const state = () => JSON.parse(read(statePath(), '{}'))
const saveState = (s) => write(statePath(), JSON.stringify(s, null, 2))

export const has = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]).status === 0

export function detect() {
  return {
    claude: has('claude') || fs.existsSync(path.join(home(), '.claude')),
    codex: has('codex') || fs.existsSync(path.dirname(codexPath())),
    cursor: fs.existsSync('/Applications/Cursor.app') || fs.existsSync(path.join(home(), '.cursor')) || has('cursor'),
  }
}

// Snapshot a file before the first change (belt and braces next to the surgical undo).
export function backup(file) {
  if (!fs.existsSync(file)) return
  const dir = path.join(jevDir(), 'backups', new Date().toISOString().replace(/[:.]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(file, path.join(dir, path.basename(path.dirname(file)) + '__' + path.basename(file)))
}

// ---------- Claude Code: ~/.claude/settings.json "env" ----------
export function setupClaude(url, key) {
  const file = claudePath()
  const raw = read(file)
  const cfg = raw ? JSON.parse(raw) : {}
  backup(file)
  const want = {
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_AUTH_TOKEN: key || 'jev-local',
    ANTHROPIC_MODEL: 'jev-auto',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'jev-auto',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'jev-smart',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'jev-fast',
  }
  const s = state()
  const prev = s.claude?.prev || {}
  cfg.env ||= {}
  for (const k of Object.keys(want)) {
    if (!(k in prev)) prev[k] = k in cfg.env ? cfg.env[k] : null
    cfg.env[k] = want[k]
  }
  s.claude = { prev, existed: s.claude ? s.claude.existed : !!raw }
  saveState(s)
  write(file, JSON.stringify(cfg, null, 2) + '\n')
}

export function undoClaude() {
  const s = state()
  if (!s.claude) return false
  const file = claudePath()
  const cfg = JSON.parse(read(file, '{}'))
  for (const [k, v] of Object.entries(s.claude.prev)) v === null ? delete cfg.env?.[k] : (cfg.env[k] = v)
  if (cfg.env && !Object.keys(cfg.env).length) delete cfg.env
  if (!s.claude.existed && !Object.keys(cfg).length) fs.rmSync(file, { force: true })
  else write(file, JSON.stringify(cfg, null, 2) + '\n')
  delete s.claude
  saveState(s)
  return true
}

// ---------- Codex: ~/.codex/config.toml (marked blocks) ----------
const BLOCK = /\n?# >>> jev\n[\s\S]*?# <<< jev\n/g
const DISABLED = '# jev-disabled: '

export function codexText(text, url, key) {
  text = removeCodex(text)
  const lines = text.split('\n')
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l))
  for (let i = 0; i < (firstTable < 0 ? lines.length : firstTable); i++)
    if (/^\s*(model|model_provider)\s*=/.test(lines[i])) lines[i] = DISABLED + lines[i]
  const top = '# >>> jev\nmodel = "jev-auto"\nmodel_provider = "jev"\n# <<< jev\n'
  const table = '\n# >>> jev\n[model_providers.jev]\nname = "JEV"\n' +
    `base_url = "${url}/v1"\nwire_api = "responses"\n` +
    (key ? `http_headers = { "Authorization" = "Bearer ${key}" }\n` : '') + '# <<< jev\n'
  return top + lines.join('\n') + table
}

export const removeCodex = (text) => text.replace(BLOCK, '').split('\n').map(l => l.startsWith(DISABLED) ? l.slice(DISABLED.length) : l).join('\n')

export function setupCodex(url, key) {
  const file = codexPath()
  backup(file)
  const s = state()
  if (!s.codex) { s.codex = { existed: fs.existsSync(file) }; saveState(s) }
  write(file, codexText(read(file), url, key))
}

export function undoCodex() {
  const s = state()
  if (!s.codex) return false
  const file = codexPath()
  const text = removeCodex(read(file))
  if (!s.codex.existed && !text.trim()) fs.rmSync(file, { force: true })
  else write(file, text)
  delete s.codex
  saveState(s)
  return true
}

// ---------- Cursor ----------
export function copy(text) {
  const cmd = process.platform === 'darwin' ? ['pbcopy'] : process.platform === 'win32' ? ['clip'] : ['xclip', '-selection', 'clipboard']
  return spawnSync(cmd[0], cmd.slice(1), { input: text }).status === 0
}

export function mergeCursorMcp(name, entry) {
  const file = cursorMcpPath()
  backup(file)
  const cfg = JSON.parse(read(file, '{}') || '{}')
  cfg.mcpServers ||= {}
  if (entry) cfg.mcpServers[name] = entry
  else delete cfg.mcpServers[name]
  write(file, JSON.stringify(cfg, null, 2) + '\n')
}
