/**
 * Overleaf for DeepSeek Harness — host half.
 *
 * This plugin owns no authentication of its own. `latex.cstcloud.cn` is
 * OIDC/AAI-only (no password form), so the session cookie is produced
 * elsewhere — a browser session, or the VS Code Overleaf Workshop extension —
 * and handed to `ovl_login`. From then on the cookie lives in the credential
 * seam and every request re-reads it, so re-logging in reaches the next call
 * without a restart.
 *
 * @module dsh-plugin-overleaf
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { OverleafClient, OverleafError, cookieFingerprint } from './lib/overleaf.js'
import {
  clearSession,
  describeSession,
  readSession,
  writeSession,
} from './lib/session-store.js'

export const name = 'dsh-plugin-overleaf'
/**
 * `credentials` and `tools` are the seams the tools use; `webServer` carries the
 * browser panel's RPC. A static plugin cannot use `harness.handle` — that is the
 * dynamic-package sandbox's private channel — and the typed `Remote` seam needs
 * build-time code generation, so the client half talks to this plugin over a
 * same-origin HTTP route registered below.
 */
export const inject = ['credentials', 'tools', 'webServer']

/** Route the browser panel posts to. */
const RPC_PATH = '/overleaf/rpc'

const DEFAULT_BASE_URL = 'https://latex.cstcloud.cn/'

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
})

/**
 * Resolve the client for the current session, or throw a message a model can act on.
 * The cookie is re-read on every call — never cached — so a fresh login applies
 * to the very next request.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
async function requireClient(ctx) {
  const session = await readSession(ctx)
  if (!session?.cookie) {
    throw new OverleafError(
      'No Overleaf session is stored. Call ovl_login with the session cookie first.',
      'NOT_CONFIGURED',
    )
  }
  return new OverleafClient({ baseUrl: session.baseUrl || DEFAULT_BASE_URL, cookie: session.cookie })
}

/** Re-throw any failure as one line the model can read. */
function explain(error) {
  if (error instanceof OverleafError) {
    if (error.code === 'AUTH_EXPIRED') {
      return `${error.message}. The Overleaf session is no longer valid — log in at the instance in a browser, then call ovl_login again with the fresh cookie.`
    }
    return `${error.message}${error.code ? ` [${error.code}]` : ''}`
  }
  return error?.message ?? String(error)
}

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ baseUrl: string }} config
 */
export function apply(ctx, config) {
  const baseUrl = config?.baseUrl || DEFAULT_BASE_URL

  // ---------------------------------------------------------------- ovl_login
  ctx.tools.register(defineTool({
    name: 'ovl_login',
    description:
      'Store and verify an Overleaf session cookie. Get the cookie from a logged-in browser session (DevTools → Network → any request to the instance → copy the whole Cookie request header). The cookie is validated before it is stored, and kept in the harness credential store — never in the workspace.',
    parameters: {
      cookie: {
        type: 'string',
        required: true,
        description: 'The full Cookie request header value, e.g. "overleaf.sid=s%3A...; latex-session=...".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          userEmail: { type: 'string' },
          userId: { type: 'string' },
          baseUrl: { type: 'string' },
          cookieNames: { type: 'array', required: true, items: { type: 'string' } },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const cookie = String(args?.cookie ?? '').trim()
      if (!cookie) throw new Error('ovl_login needs a non-empty cookie')
      const fingerprint = cookieFingerprint(cookie)
      try {
        const identity = await OverleafClient.verify({ baseUrl, cookie })
        await writeSession(ctx, {
          cookie,
          baseUrl: identity.baseUrl,
          userId: identity.userId,
          userEmail: identity.userEmail,
        })
        return {
          ok: true,
          userId: identity.userId,
          userEmail: identity.userEmail,
          baseUrl: identity.baseUrl,
          cookieNames: fingerprint.names,
          message: `Overleaf session stored and verified for ${identity.userEmail} at ${identity.baseUrl} (cookies: ${fingerprint.names.join(', ')}).`,
        }
      } catch (error) {
        throw new Error(`Overleaf login rejected: ${explain(error)}`)
      }
    },
  }))

  // --------------------------------------------------------------- ovl_status
  ctx.tools.register(defineTool({
    name: 'ovl_status',
    description:
      'Report the Overleaf connection: whether a session is stored, which account and instance it belongs to, and whether it is still accepted by the server. Use this before other Overleaf calls to check reachability.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          configured: { type: 'boolean', required: true },
          live: { type: 'boolean', required: true },
          userEmail: { type: 'string' },
          userId: { type: 'string' },
          baseUrl: { type: 'string' },
          savedAt: { type: 'string' },
          cookieNames: { type: 'array', required: true, items: { type: 'string' } },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.message),
    },
    async execute() {
      const described = await describeSession(ctx)
      if (!described.configured) {
        return {
          configured: false,
          live: false,
          cookieNames: [],
          message: 'No Overleaf session stored. Call ovl_login with a session cookie.',
        }
      }
      const session = await readSession(ctx)
      const fingerprint = cookieFingerprint(session.cookie)
      try {
        const identity = await OverleafClient.verify({
          baseUrl: session.baseUrl || baseUrl,
          cookie: session.cookie,
        })
        return {
          configured: true,
          live: true,
          userId: identity.userId,
          userEmail: identity.userEmail,
          baseUrl: identity.baseUrl,
          ...(session.savedAt ? { savedAt: new Date(session.savedAt).toISOString() } : {}),
          cookieNames: fingerprint.names,
          message: `Overleaf session is live: ${identity.userEmail} at ${identity.baseUrl}.`,
        }
      } catch (error) {
        return {
          configured: true,
          live: false,
          userEmail: session.userEmail ?? undefined,
          baseUrl: session.baseUrl || baseUrl,
          ...(session.savedAt ? { savedAt: new Date(session.savedAt).toISOString() } : {}),
          cookieNames: fingerprint.names,
          message: `Overleaf session is stored but NOT accepted: ${explain(error)}`,
        }
      }
    },
  }))

  // -------------------------------------------------------------- ovl_logout
  ctx.tools.register(defineTool({
    name: 'ovl_logout',
    description: 'Forget the stored Overleaf session cookie.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute() {
      await clearSession(ctx)
      return 'Overleaf session removed.'
    },
  }))

  // ------------------------------------------------------------- ovl_projects
  ctx.tools.register(defineTool({
    name: 'ovl_projects',
    description:
      'List every Overleaf project on the connected account. The result is fetched live from the server — ids from this call are the ones every other Overleaf tool expects.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          projects: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                accessLevel: { type: 'string', required: true },
                archived: { type: 'boolean', required: true },
                trashed: { type: 'boolean', required: true },
                lastUpdated: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => text(
        value.projects
          .map((p) => `${p.id}  ${p.accessLevel.padEnd(7)} ${p.name}`)
          .join('\n') || '(no projects)',
      ),
    },
    async execute() {
      try {
        const client = await requireClient(ctx)
        const projects = await client.listProjects()
        return {
          count: projects.length,
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            accessLevel: p.accessLevel,
            archived: p.archived,
            trashed: p.trashed,
            ...(p.lastUpdated ? { lastUpdated: p.lastUpdated } : {}),
          })),
        }
      } catch (error) {
        throw new Error(explain(error))
      }
    },
  }))

  // ---------------------------------------------------------------- ovl_files
  ctx.tools.register(defineTool({
    name: 'ovl_files',
    description:
      'List every file and folder in one Overleaf project as absolute paths. Use the paths from this call to pick download targets.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Project id from ovl_projects.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          entities: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                type: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => text(
        value.entities.map((e) => `${e.type.padEnd(6)} ${e.path}`).join('\n') || '(empty project)',
      ),
    },
    async execute(args) {
      const projectId = String(args?.projectId ?? '').trim()
      if (!projectId) throw new Error('ovl_files needs a projectId')
      try {
        const client = await requireClient(ctx)
        const tree = await client.listEntities(projectId)
        return {
          projectId: tree.projectId,
          count: tree.entities.length,
          entities: tree.entities.map((e) => ({ path: e.path, type: e.type })),
        }
      } catch (error) {
        throw new Error(explain(error))
      }
    },
  }))

  // ------------------------------------------------------------- ovl_download
  ctx.tools.register(defineTool({
    name: 'ovl_download',
    description:
      'Download an Overleaf project to a local file. Downloads the server-side zip archive of the whole project. Note the archive is streamed in full (the endpoint ignores range requests), so large projects take a while.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Project id from ovl_projects.' },
      destination: {
        type: 'string',
        required: true,
        description: 'Absolute path, or a path relative to the session working directory, for the .zip file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          destination: { type: 'string', required: true },
          bytes: { type: 'integer' },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const projectId = String(args?.projectId ?? '').trim()
      const destination = String(args?.destination ?? '').trim()
      if (!projectId) throw new Error('ovl_download needs a projectId')
      if (!destination) throw new Error('ovl_download needs a destination path')
      try {
        const client = await requireClient(ctx)
        const result = await client.downloadZip(projectId, destination)
        const size = result.bytes ? ` (${result.bytes} bytes)` : ''
        return {
          destination: result.destination,
          ...(result.bytes ? { bytes: result.bytes } : {}),
          message: `Downloaded project ${projectId} to ${result.destination}${size}.`,
        }
      } catch (error) {
        if (error instanceof OverleafError) throw new Error(explain(error))
        throw error
      }
    },
  }))

  // -------------------------------------------------------------- ovl_compile
  ctx.tools.register(defineTool({
    name: 'ovl_compile',
    description:
      'Compile an Overleaf project server-side and report its output files, including a direct URL for the resulting PDF. This does not download anything.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Project id from ovl_projects.' },
      draft: { type: 'boolean', description: 'Compile in draft mode (faster, skips images). Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          pdfUrl: { type: 'string' },
          outputFiles: { type: 'array', required: true, items: { type: 'string' } },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const projectId = String(args?.projectId ?? '').trim()
      if (!projectId) throw new Error('ovl_compile needs a projectId')
      try {
        const client = await requireClient(ctx)
        const result = await client.compile(projectId, {
          draft: args?.draft === true,
          stopOnFirstError: true,
        })
        const names = result.outputFiles.map((f) => f.path)
        return {
          status: result.status,
          ...(result.pdf ? { pdfUrl: result.pdf.url } : {}),
          outputFiles: names,
          message: result.pdf
            ? `Compile ${result.status}. PDF: ${result.pdf.url}\nOutputs: ${names.join(', ')}`
            : `Compile ${result.status}, but no PDF was produced. Outputs: ${names.join(', ')}`,
        }
      } catch (error) {
        throw new Error(explain(error))
      }
    },
  }))

  // ------------------------------------------------------- authorization flow
  // Registered so a configuration surface can offer Overleaf sign-in through the
  // harness's own authorization seam, instead of only through the model.
  const flow = ctx.get('authorization')?.registerFlow?.({
    key: credentialKey('dsh-plugin-overleaf', 'overleaf-session'),
    label: 'Overleaf',
    methods: [{ id: 'cookie', label: 'Paste a session cookie' }],
    async run(session) {
      session.notify({
        message:
          'Log in to your Overleaf instance in a browser (this instance uses OIDC/AAI, so there is no password form here). Then open DevTools → Network, click any request to the instance, and copy the whole Cookie request header value.',
        url: baseUrl,
      })
      const answer = await session.prompt({
        kind: 'secret',
        message: 'Paste the Cookie request header value',
      })
      const cookie = String(answer ?? '').trim()
      if (!cookie) throw new Error('no cookie supplied')
      const identity = await OverleafClient.verify({ baseUrl, cookie })
      await writeSession(ctx, {
        cookie,
        baseUrl: identity.baseUrl,
        userId: identity.userId,
        userEmail: identity.userEmail,
      })
    },
  })

  ctx.effect(() => () => flow?.(), 'overleaf authorization flow')

  // --------------------------------------------------------------- panel RPC
  // The browser panel posts here. Same-origin, so no CORS surface; the route is
  // owned by this fiber and disappears with it.
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  /** Every panel operation returns data; failures come back as `{ error }`. */
  const rpc = {
    async overview() {
      const described = await describeSession(ctx)
      if (!described.configured) {
        return { configured: false, live: false, userEmail: null, savedAt: null, projects: [] }
      }
      const session = await readSession(ctx)
      const savedAt = session.savedAt
        ? new Date(session.savedAt).toISOString().slice(0, 16).replace('T', ' ')
        : null
      try {
        const client = new OverleafClient({
          baseUrl: session.baseUrl || baseUrl,
          cookie: session.cookie,
        })
        const projects = await client.listProjects()
        return {
          configured: true,
          live: true,
          userEmail: session.userEmail ?? null,
          savedAt,
          projects: projects
            .filter((project) => !project.trashed)
            .map((project) => ({
              id: project.id,
              name: project.name,
              accessLevel: project.accessLevel,
              archived: project.archived,
            })),
        }
      } catch (error) {
        return {
          configured: true,
          live: false,
          userEmail: session.userEmail ?? null,
          savedAt,
          projects: [],
          note: explain(error),
        }
      }
    },

    async files(args) {
      const projectId = String(args?.projectId ?? '')
      if (!projectId) return { error: 'projectId is required' }
      const client = await requireClient(ctx)
      const tree = await client.listEntities(projectId)
      return { entities: tree.entities.map((entry) => ({ path: entry.path, type: entry.type })) }
    },

    async download(args) {
      const projectId = String(args?.projectId ?? '')
      if (!projectId) return { error: 'projectId is required' }
      const client = await requireClient(ctx)
      const { join } = await import('node:path')
      const safe = String(args?.name ?? projectId).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
      const destination = join(process.cwd(), `${safe}.zip`)
      const result = await client.downloadZip(projectId, destination)
      return {
        message: `Downloaded to ${result.destination}${result.bytes ? ` (${result.bytes} bytes)` : ''}`,
      }
    },

    async compile(args) {
      const projectId = String(args?.projectId ?? '')
      if (!projectId) return { error: 'projectId is required' }
      const client = await requireClient(ctx)
      const result = await client.compile(projectId, { draft: true, stopOnFirstError: true })
      return {
        message: result.pdf
          ? `Compile ${result.status} — PDF: ${result.pdf.url}`
          : `Compile ${result.status} — no PDF produced`,
      }
    },

    async login(args) {
      const cookie = String(args?.cookie ?? '').trim()
      if (!cookie) return { error: 'cookie is required' }
      const identity = await OverleafClient.verify({ baseUrl, cookie })
      await writeSession(ctx, {
        cookie,
        baseUrl: identity.baseUrl,
        userId: identity.userId,
        userEmail: identity.userEmail,
      })
      return { message: `Signed in as ${identity.userEmail}` }
    },

    async logout() {
      await clearSession(ctx)
      return { message: 'Session removed' }
    },
  }

  const route = ctx.webServer.register({
    kind: 'exact',
    path: RPC_PATH,
    async handler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' })
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch (error) {
        sendJson(res, 400, { error: `bad request body: ${error.message}` })
        return
      }
      const method = String(payload?.method ?? '')
      const operation = Object.prototype.hasOwnProperty.call(rpc, method) ? rpc[method] : undefined
      if (!operation) {
        sendJson(res, 404, { error: `unknown method "${method}"` })
        return
      }
      try {
        sendJson(res, 200, await operation(payload.args))
      } catch (error) {
        // A missing/expired session is the common case and must read as such.
        sendJson(res, 200, { error: explain(error) })
      }
    },
  })

  ctx.effect(() => () => route(), 'overleaf panel RPC route')
}
