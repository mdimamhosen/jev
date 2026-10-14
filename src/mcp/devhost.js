// Runs a generated MCP server locally: node --watch devhost.js <server.js> [port]
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { listen } from '../node.js'

const [file, port = '7337'] = process.argv.slice(2)
const server = (await import(pathToFileURL(path.resolve(file)).href)).default
await listen((req) => server.fetch(req, process.env), { port: +port, host: '127.0.0.1' })
console.log(`\n  JEV MCP dev  ${server.name} ${server.version}\n  Server     http://localhost:${port}/mcp\n  Tools      ${server.tools.map(t => t.name).join(', ')}\n  Inspector  npx @modelcontextprotocol/inspector  → http://localhost:${port}/mcp\n`)
