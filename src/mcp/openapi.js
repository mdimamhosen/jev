// OpenAPI 3.x (JSON) → MCP tool specs. Risky endpoints are skipped unless --all.
const RISKY = /admin|internal|debug|_?private|sudo|impersonat/i
const METHODS = ['get', 'post', 'put', 'patch', 'delete']

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase()

function deref(spec, s, depth = 0) {
  if (!s || depth > 4) return s || {}
  if (s.$ref) return deref(spec, s.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], spec), depth + 1)
  if (s.properties) return { ...s, properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, deref(spec, v, depth + 1)])) }
  return s
}

export function toolsFromOpenAPI(spec, { all = false } = {}) {
  const tools = [], skipped = []
  for (const [p, item] of Object.entries(spec.paths || {})) for (const method of METHODS) {
    const op = item[method]
    if (!op) continue
    const name = snake(op.operationId || `${method}_${p.replace(/\{(\w+)\}/g, 'by_$1')}`).slice(0, 64)
    if (!all && (method === 'delete' || RISKY.test(p) || RISKY.test(op.operationId || '') || op.deprecated)) { skipped.push(`${method.toUpperCase()} ${p}`); continue }
    const properties = {}, required = [], params = []
    for (const prm of [...(item.parameters || []), ...(op.parameters || [])].map(x => deref(spec, x))) {
      if (!['path', 'query'].includes(prm.in)) continue
      properties[prm.name] = { ...deref(spec, prm.schema || { type: 'string' }), description: prm.description || '' }
      if (prm.required || prm.in === 'path') required.push(prm.name)
      params.push({ name: prm.name, in: prm.in })
    }
    const bodySchema = op.requestBody?.content?.['application/json']?.schema
    if (bodySchema) {
      properties.body = { ...deref(spec, bodySchema), description: 'JSON request body' }
      if (op.requestBody.required) required.push('body')
    }
    tools.push({
      name, method: method.toUpperCase(), path: p, params, hasBody: !!bodySchema,
      description: (op.summary || op.description || `${method.toUpperCase()} ${p}`).trim().slice(0, 500),
      inputSchema: { type: 'object', properties, ...(required.length && { required: [...new Set(required)] }) },
      annotations: { readOnlyHint: method === 'get', destructiveHint: method === 'delete' },
    })
  }
  return { tools, skipped, baseUrl: spec.servers?.[0]?.url || '' }
}
