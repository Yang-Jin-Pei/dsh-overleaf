/**
 * Overleaf HTTP client — the only file that knows about a specific Overleaf
 * instance's endpoints and quirks.
 *
 * Zero external dependencies on purpose: the DSH host process has global
 * `fetch`, and `node:zlib`/`node:fs` are available. This module is also
 * importable by plain Node, which is how it gets tested without a DSH restart.
 *
 * Instance quirks this file absorbs (all verified against latex.cstcloud.cn):
 *   - `GET /project` answers HTML, and the `ol-projects` meta tag is ABSENT on
 *     this instance, so project ids must come from `GET /user/projects` (`_id`).
 *   - entity nodes carry `{ path, type }` where `path` is absolute, NOT `name`.
 *   - `GET /project/<id>/download/zip` ignores Range requests and always streams
 *     the whole archive.
 *   - write operations require `X-Csrf-Token`, read from the `ol-csrfToken` meta.
 *   - login is OIDC-only (no password form), so this client never authenticates;
 *     it consumes a session cookie produced elsewhere.
 */

/** Error carrying a machine-readable code so callers can special-case auth loss. */
export class OverleafError extends Error {
  constructor(message, code, details) {
    super(message)
    this.name = 'OverleafError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const HTML_META = {
  userId: /<meta\s+name="ol-user_id"\s+content="([^"]*)">/,
  userEmail: /<meta\s+name="ol-usersEmail"\s+content="([^"]*)">/,
  csrfToken: /<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/,
}

/** Normalize a base URL to always end in exactly one slash. */
export function normalizeBaseUrl(url) {
  const trimmed = String(url ?? '').trim()
  if (!trimmed) throw new OverleafError('Overleaf base URL is empty', 'BAD_BASE_URL')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new OverleafError(`Overleaf base URL is not a valid URL: ${trimmed}`, 'BAD_BASE_URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OverleafError(`Overleaf base URL must be http(s): ${trimmed}`, 'BAD_BASE_URL')
  }
  return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`
}

/** A cookie header is a secret; only ever report its shape, never its value. */
export function cookieFingerprint(cookie) {
  const text = String(cookie ?? '')
  const names = text
    .split(';')
    .map((part) => part.trim().split('=')[0])
    .filter(Boolean)
  return { length: text.length, names }
}

export class OverleafClient {
  #baseUrl
  #cookie

  constructor({ baseUrl, cookie }) {
    this.#baseUrl = normalizeBaseUrl(baseUrl)
    if (typeof cookie !== 'string' || !cookie.trim()) {
      throw new OverleafError('Overleaf session cookie is empty', 'NO_COOKIE')
    }
    this.#cookie = cookie.trim()
  }

  get baseUrl() {
    return this.#baseUrl
  }

  async #fetch(path, { method = 'GET', headers = {}, body, redirect = 'manual' } = {}) {
    const url = path.startsWith('http') ? path : this.#baseUrl + path
    const requestHeaders = {
      Cookie: this.#cookie,
      Connection: 'keep-alive',
      ...headers,
    }
    let response
    try {
      response = await fetch(url, { method, redirect, headers: requestHeaders, body })
    } catch (cause) {
      throw new OverleafError(
        `Network error talking to Overleaf: ${cause?.message ?? cause}`,
        'NETWORK',
      )
    }
    if (response.status === 302 || response.status === 303) {
      const location = response.headers.get('location') ?? ''
      // The instance redirects to /login when the session is gone.
      if (/\/login|\/oidc\/login/.test(location)) {
        throw new OverleafError(
          'Overleaf session expired (server redirected to login)',
          'AUTH_EXPIRED',
        )
      }
    }
    if (response.status === 401 || response.status === 403) {
      throw new OverleafError(
        `Overleaf rejected the request (HTTP ${response.status})`,
        'AUTH_EXPIRED',
      )
    }
    return response
  }

  /** Fetch identity + a fresh CSRF token. This is the validity check for a cookie. */
  async identify() {
    const response = await this.#fetch('project')
    if (response.status !== 200) {
      throw new OverleafError(
        `Overleaf session is not usable (HTTP ${response.status} on /project)`,
        'AUTH_EXPIRED',
      )
    }
    const html = await response.text()
    const userId = html.match(HTML_META.userId)?.[1]
    const userEmail = html.match(HTML_META.userEmail)?.[1] ?? ''
    const csrfToken = html.match(HTML_META.csrfToken)?.[1]
    if (!userId || !csrfToken) {
      throw new OverleafError(
        'Reached Overleaf but the page carried no user id / CSRF token — the cookie is probably not authenticated',
        'AUTH_EXPIRED',
      )
    }
    return { userId, userEmail, csrfToken }
  }

  /** Probe a cookie without keeping a client: returns identity or throws. */
  static async verify({ baseUrl, cookie }) {
    const client = new OverleafClient({ baseUrl, cookie })
    const identity = await client.identify()
    return { baseUrl: client.baseUrl, ...identity }
  }

  async #csrf() {
    return (await this.identify()).csrfToken
  }

  /** Live project list. Authoritative — never trust a cached list. */
  async listProjects() {
    const response = await this.#fetch('user/projects', { headers: { Accept: 'application/json' } })
    if (response.status !== 200) {
      throw new OverleafError(
        `Listing projects failed (HTTP ${response.status})`,
        response.status === 401 || response.status === 403 ? 'AUTH_EXPIRED' : 'HTTP',
      )
    }
    let payload
    try {
      payload = JSON.parse(await response.text())
    } catch (cause) {
      throw new OverleafError(`Project list was not JSON: ${cause?.message}`, 'BAD_RESPONSE')
    }
    const projects = Array.isArray(payload?.projects) ? payload.projects : []
    return projects.map((project) => ({
      id: project._id ?? project.id,
      name: project.name ?? '(untitled)',
      accessLevel: project.accessLevel ?? 'unknown',
      archived: Boolean(project.archived),
      trashed: Boolean(project.trashed),
      lastUpdated: project.lastUpdated ?? null,
    }))
  }

  /** Flat file list with absolute paths, folder nodes included. */
  async listEntities(projectId) {
    const response = await this.#fetch(`project/${encodeURIComponent(projectId)}/entities`, {
      headers: { Accept: 'application/json' },
    })
    if (response.status !== 200) {
      throw new OverleafError(
        `Listing files failed (HTTP ${response.status})`,
        response.status === 401 || response.status === 403 ? 'AUTH_EXPIRED' : 'HTTP',
      )
    }
    let payload
    try {
      payload = JSON.parse(await response.text())
    } catch (cause) {
      throw new OverleafError(`Entity list was not JSON: ${cause?.message}`, 'BAD_RESPONSE')
    }
    const flat = []
    const walk = (nodes, depth) => {
      for (const node of nodes ?? []) {
        // This instance uses `path` (absolute). Upstream Overleaf uses `name`.
        const path = node.path ?? node.name ?? ''
        const type = node.type ?? node._type ?? 'doc'
        flat.push({ path, type, depth })
        if (Array.isArray(node.children)) walk(node.children, depth + 1)
      }
    }
    walk(payload?.entities, 0)
    return { projectId: payload?.project_id ?? projectId, entities: flat }
  }

  /**
   * Download the whole project as a zip. Streamed straight to disk because this
   * endpoint ignores Range and can hand back hundreds of megabytes.
   */
  async downloadZip(projectId, destination, { signal } = {}) {
    const response = await this.#fetch(
      `project/${encodeURIComponent(projectId)}/download/zip`,
      { headers: { Accept: '*/*' } },
    )
    if (response.status !== 200) {
      throw new OverleafError(
        `Downloading the project archive failed (HTTP ${response.status})`,
        response.status === 401 || response.status === 403 ? 'AUTH_EXPIRED' : 'HTTP',
      )
    }
    const { createWriteStream } = await import('node:fs')
    const { pipeline } = await import('node:stream/promises')
    const { Readable } = await import('node:stream')
    const declared = Number(response.headers.get('content-length') ?? 0)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination), { signal })
    return { bytes: declared || null, destination }
  }

  /** Download one file's bytes (documents and binary assets both use this). */
  async downloadFile(projectId, fileId) {
    const response = await this.#fetch(
      `project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`,
      { headers: { Accept: '*/*' } },
    )
    if (response.status !== 200) {
      throw new OverleafError(
        `Downloading the file failed (HTTP ${response.status})`,
        response.status === 401 || response.status === 403 ? 'AUTH_EXPIRED' : 'HTTP',
      )
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Compile and return the output file list plus a resolvable PDF URL. */
  async compile(projectId, { draft = false, stopOnFirstError = true, rootResourcePath } = {}) {
    const csrfToken = await this.#csrf()
    const body = {
      check: 'silent',
      draft,
      stopOnFirstError,
      ...(rootResourcePath ? { rootResourcePath } : {}),
    }
    const response = await this.#fetch(`project/${encodeURIComponent(projectId)}/compile`, {
      method: 'POST',
      headers: {
        'X-Csrf-Token': csrfToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (response.status !== 200) {
      throw new OverleafError(
        `Compile request failed (HTTP ${response.status})`,
        response.status === 401 || response.status === 403 ? 'AUTH_EXPIRED' : 'HTTP',
      )
    }
    let payload
    try {
      payload = JSON.parse(await response.text())
    } catch (cause) {
      throw new OverleafError(`Compile response was not JSON: ${cause?.message}`, 'BAD_RESPONSE')
    }
    const outputFiles = (payload.outputFiles ?? []).map((file) => ({
      path: file.path,
      url: file.url?.startsWith('http') ? file.url : new URL(file.url, this.#baseUrl).href,
    }))
    return {
      status: payload.status,
      outputFiles,
      pdf: outputFiles.find((file) => file.path.endsWith('.pdf')) ?? null,
      compileGroup: payload.compileGroup ?? null,
    }
  }
}
