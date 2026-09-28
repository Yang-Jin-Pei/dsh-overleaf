/**
 * Registration smoke test: call the plugin's apply() with stub services.
 *
 * A DSH restart is the only way to load a new bundle, so every failure that can
 * be caught without one should be caught here first — otherwise a crash costs a
 * full restart cycle to discover.
 */
import { apply, name, inject, Config } from './index.js'

const registered = []
const flows = []
const routes = []
let effectDisposers = 0
const warnings = []

const ctx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  credentials: {
    async readRecord() { return undefined },
    async describeRecord() { return { configured: false, writable: true } },
    async modifyRecord() { return undefined },
    async deleteRecord() {},
    async listRecords() { return [] },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  get(serviceName) {
    if (serviceName === 'authorization') {
      return {
        registerFlow(flow) {
          flows.push(flow)
          return () => {}
        },
      }
    }
    return undefined
  },
  effect(callback, label) {
    effectDisposers += 1
    const disposer = callback()
    if (typeof disposer !== 'function') {
      warnings.push(`effect "${label}" did not return a disposer`)
    }
    return () => {}
  },
  logger: { warn: (m) => warnings.push(m), info() {}, error() {} },
}

const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)

// --- the module's own contract -------------------------------------------------
ok('exports name', typeof name === 'string' && name.length > 0, name)
ok('exports inject', Array.isArray(inject), JSON.stringify(inject))
ok('inject covers tools + credentials + webServer',
  inject.includes('tools') && inject.includes('credentials') && inject.includes('webServer'))
ok('Config is callable', typeof Config === 'function', typeof Config)

// --- apply() must not throw ----------------------------------------------------
let config
try {
  config = Config({})
} catch (error) {
  console.log('FAIL  Config({}) threw: ' + error.message)
  process.exit(1)
}
ok('Config({}) yields a default baseUrl',
  typeof config?.baseUrl === 'string' && config.baseUrl.startsWith('http'), config?.baseUrl)

try {
  apply(ctx, config)
  ok('apply(ctx, config) did not throw', true)
} catch (error) {
  ok('apply(ctx, config) did not throw', false)
  console.log('      ' + error.stack)
  process.exit(1)
}

// --- what it registered --------------------------------------------------------
const names = registered.map((t) => t.name).sort()
console.log('\nregistered tools: ' + names.join(', '))
const expected = ['ovl_compile', 'ovl_download', 'ovl_files', 'ovl_login', 'ovl_logout', 'ovl_projects', 'ovl_status']
ok('registered the expected tool set',
  expected.every((n) => names.includes(n)), `missing: ${expected.filter((n) => !names.includes(n)).join(', ') || 'none'}`)

// every tool must satisfy the registry's shape requirements
for (const tool of registered) {
  const problems = []
  if (typeof tool.name !== 'string' || !tool.name) problems.push('name')
  if (typeof tool.description !== 'string' || !tool.description) problems.push('description')
  if (typeof tool.execute !== 'function') problems.push('execute')
  if (!tool.output || typeof tool.output.render !== 'function') problems.push('output.render')
  if (!tool.output?.schema) problems.push('output.schema')
  ok(`tool ${tool.name} is well-formed`, problems.length === 0, problems.join(', '))
}

// `defineTool` normalizes `parameters` into a JSON Schema object; accept either
// that normalized form or the raw `{ name: node }` map a definition is written in.
for (const tool of registered) {
  const params = tool.parameters ?? {}
  const normalized = params.type === 'object' && params.properties && typeof params.properties === 'object'
  const entries = normalized ? Object.entries(params.properties) : Object.entries(params)
  const bad = entries.filter(([, node]) => !node || typeof node !== 'object' || typeof node.type !== 'string')
  const declaredRequired = new Set(
    Array.isArray(params.required) ? params.required : entries.filter(([, node]) => node.required).map(([k]) => k),
  )
  ok(`tool ${tool.name} parameters parse`, bad.length === 0,
    `${entries.length} params, required: [${[...declaredRequired].join(', ')}]`)
}

// --- authorization flow --------------------------------------------------------
ok('registered an authorization flow', flows.length === 1, `${flows.length} flow(s)`)
if (flows[0]) {
  const flow = flows[0]
  ok('flow key is the session record',
    String(flow.key) === 'dsh-plugin-overleaf/overleaf-session', String(flow.key))
  ok('flow has a label', typeof flow.label === 'string', flow.label)
  ok('flow declares methods', Array.isArray(flow.methods) && flow.methods.length > 0,
    JSON.stringify(flow.methods))
  ok('flow.run is a function', typeof flow.run === 'function')
}

ok('registered an effect disposer', effectDisposers === 2, `${effectDisposers} effect(s)`)
ok('no warnings during registration', warnings.length === 0, warnings.join(' | '))

// --- the panel RPC route --------------------------------------------------------
console.log('\n--- panel RPC route ---')
ok('registered one RPC route', routes.length === 1, `${routes.length} route(s)`)
const route = routes[0]
if (route) {
  ok('route is an exact match on /overleaf/rpc',
    route.kind === 'exact' && route.path === '/overleaf/rpc', `${route.kind} ${route.path}`)
  ok('route has an async handler', typeof route.handler === 'function')

  // Drive the handler with fake req/res to prove the transport, not just the shape.
  const { Readable } = await import('node:stream')
  const callRpc = async (method, args) => {
    const request = Readable.from([Buffer.from(JSON.stringify({ method, args }), 'utf8')])
    request.method = 'POST'
    let status = 0
    let body = ''
    const response = {
      writeHead(code) { status = code },
      end(text) { body = String(text ?? '') },
    }
    await route.handler(request, response)
    return { status, payload: body ? JSON.parse(body) : undefined }
  }

  const wrong = await callRpc('nope')
  ok('unknown method answers 404', wrong.status === 404, JSON.stringify(wrong.payload))

  // No stored session in the stub, so this exercises the real code path and must
  // report a missing session rather than throwing.
  const overview = await callRpc('overview')
  ok('overview answers 200', overview.status === 200, JSON.stringify(overview.payload))
  ok('overview reports the session as unconfigured',
    overview.payload?.configured === false, JSON.stringify(overview.payload))

  const guarded = await callRpc('files')
  ok('files without projectId reports an error, not a crash',
    typeof guarded.payload?.error === 'string', JSON.stringify(guarded.payload))
}

// --- render() must not throw on plausible values --------------------------------
console.log('\n--- render smoke ---')
const samples = {
  ovl_login: { ok: true, cookieNames: ['a'], message: 'stored' },
  ovl_status: { configured: true, live: true, cookieNames: ['a'], message: 'live' },
  ovl_logout: 'removed',
  ovl_projects: { count: 1, projects: [{ id: 'x', name: 'n', accessLevel: 'owner', archived: false, trashed: false }] },
  ovl_files: { projectId: 'x', count: 1, entities: [{ path: '/a.tex', type: 'doc' }] },
  ovl_download: { destination: 'C:/x.zip', message: 'done' },
  ovl_compile: { status: 'success', outputFiles: ['output.pdf'], message: 'ok' },
}
for (const tool of registered) {
  try {
    const blocks = tool.output.render(undefined, samples[tool.name])
    const isBlocks = Array.isArray(blocks) && blocks.every((b) => b && typeof b.type === 'string')
    ok(`${tool.name}.render returns content blocks`, isBlocks, JSON.stringify(blocks).slice(0, 70))
  } catch (error) {
    ok(`${tool.name}.render returns content blocks`, false, error.message)
  }
}
