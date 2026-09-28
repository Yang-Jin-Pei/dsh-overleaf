/**
 * Session storage over the harness credential seam.
 *
 * The cookie is a secret, so it lives in the credential store — never in the
 * workspace, never in `.env`, never in a log line.
 *
 * Record shape is an `api-key` record, deliberately, not a `grant`:
 *   - `key` holds the cookie header value (the secret).
 *   - `env` holds the non-secret facts as a string map.
 * A `grant` record's `payload` is NOT usable here — the local credential store
 * rejects any keyed object as a payload value ("payload holds a value JSON
 * cannot represent"), including `{}`. `api-key.env` is the seam's own string
 * map and round-trips exactly.
 */
import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** Scope segment is this plugin; id names the one Overleaf session it holds. */
export const SESSION_SCOPE = 'dsh-plugin-overleaf'
export const SESSION_ID = 'overleaf-session'

export const sessionKey = () => credentialKey(SESSION_SCOPE, SESSION_ID)

/**
 * @typedef {object} StoredSession
 * @property {string} cookie       the session cookie header value (secret)
 * @property {string} baseUrl      the instance this cookie belongs to
 * @property {string} [userId]
 * @property {string} [userEmail]
 * @property {number} [savedAt]    epoch ms when the cookie was last stored
 */

/**
 * Read the stored session, or undefined when nothing is configured.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<StoredSession | undefined>}
 */
export async function readSession(ctx) {
  const record = await ctx.credentials.readRecord(sessionKey())
  if (!record) return undefined

  // `api-key` is the shape this plugin writes; `grant` is still accepted on read
  // so a record written by an older build keeps working instead of vanishing.
  const cookie = record.kind === 'api-key'
    ? record.key
    : (record.payload && typeof record.payload === 'object' ? record.payload.cookie : undefined)
  if (typeof cookie !== 'string' || !cookie) return undefined

  const env = record.kind === 'api-key' && record.env ? record.env : {}
  const payload = record.kind === 'grant' && record.payload && typeof record.payload === 'object'
    ? record.payload
    : {}
  const pick = (field) => env[field] ?? payload[field]

  const savedAt = Number(pick('savedAt'))
  return {
    cookie,
    baseUrl: typeof pick('baseUrl') === 'string' ? pick('baseUrl') : '',
    ...(typeof pick('userId') === 'string' ? { userId: pick('userId') } : {}),
    ...(typeof pick('userEmail') === 'string' ? { userEmail: pick('userEmail') } : {}),
    ...(Number.isFinite(savedAt) && savedAt > 0 ? { savedAt } : {}),
  }
}

/**
 * Persist a verified session. Goes through `modifyRecord` because that is the
 * seam's only write path — it is serialized, so a concurrent refresh cannot
 * lose a write.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {StoredSession} session
 */
export async function writeSession(ctx, session) {
  if (!session.cookie) {
    throw new Error('refusing to store an empty Overleaf cookie')
  }
  /** @type {Record<string, string>} */
  const env = {
    baseUrl: session.baseUrl ?? '',
    savedAt: String(Date.now()),
  }
  if (session.userId) env.userId = session.userId
  if (session.userEmail) env.userEmail = session.userEmail

  await ctx.credentials.modifyRecord(sessionKey(), () =>
    Promise.resolve({ kind: 'api-key', key: session.cookie, env }))
}

/**
 * Describe the stored session for a UI, without revealing the cookie.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function describeSession(ctx) {
  const info = await ctx.credentials.describeRecord(sessionKey())
  const session = info.configured ? await readSession(ctx) : undefined
  return {
    configured: Boolean(info.configured),
    writable: Boolean(info.writable),
    kind: info.kind ?? null,
    baseUrl: session?.baseUrl ?? null,
    userEmail: session?.userEmail ?? null,
    userId: session?.userId ?? null,
    savedAt: session?.savedAt ?? null,
  }
}

/**
 * Forget the session.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function clearSession(ctx) {
  await ctx.credentials.deleteRecord(sessionKey())
}
