/**
 * Live HTTP test against the instance.
 *
 * Needs a real session cookie, which is a secret: it is read from the
 * environment and never written into this file. The cookie used to be
 * hard-coded here — that is exactly the accident this indirection prevents.
 *
 *   pwsh:  $env:OVL_COOKIE = 'overleaf.sid=...; latex-session=...'; node test-api.mjs
 *    sh:   OVL_COOKIE='overleaf.sid=...' node test-api.mjs
 *
 * Credentials store alternative: copy the `key` of the
 * `dsh-plugin-overleaf/overleaf-session` record in `~/.dsh/.credentials.yaml`.
 */
import { OverleafClient } from './lib/overleaf.js'

const BASE = process.env.OVL_BASE_URL ?? 'https://latex.cstcloud.cn/'
const COOKIE = (process.env.OVL_COOKIE ?? '').trim()

if (!COOKIE) {
  console.error('OVL_COOKIE is not set. Pass the instance\'s Cookie request header (it must contain overleaf.sid).')
  process.exit(2)
}

let failed = 0
const ok = (label, cond, extra = '') => {
  if (!cond) failed += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}

// --- 1. verify ---
const id = await OverleafClient.verify({ baseUrl: BASE, cookie: COOKIE })
ok('verify() returns identity', Boolean(id.userId && id.userEmail), `${id.userEmail} csrf=${id.csrfToken.length}chars`)

// --- 2. a bad cookie must fail with AUTH_EXPIRED, not a generic error ---
try {
  await OverleafClient.verify({ baseUrl: BASE, cookie: 'overleaf.sid=bogus; latex-session=bogus' })
  ok('bad cookie rejected', false, '(it was accepted!)')
} catch (error) {
  ok('bad cookie rejected', error.code === 'AUTH_EXPIRED', `code=${error.code}`)
}

// --- 3. listProjects ---
const client = new OverleafClient({ baseUrl: BASE, cookie: COOKIE })
const projects = await client.listProjects()
ok('listProjects()', projects.length > 0, `${projects.length} projects`)
for (const p of projects.slice(0, 3)) console.log(`        - ${p.name}  [${p.id}] ${p.accessLevel}`)

// --- 4. listEntities honours `path` ---
const target = projects.find((p) => p.name === 'MIVEM') ?? projects[0]
const tree = await client.listEntities(target.id)
const named = tree.entities.filter((e) => e.path)
ok('listEntities() all nodes have a path', named.length === tree.entities.length, `${tree.entities.length} nodes`)
console.log(`        project: ${target.name}`)
for (const e of tree.entities.slice(0, 5)) console.log(`        ${e.type.padEnd(6)} ${e.path}`)

// --- 5. compile + resolve the PDF url ---
const compiled = await client.compile(target.id, { draft: true })
ok('compile() success', compiled.status === 'success', `status=${compiled.status}`)
ok('compile() found a pdf', compiled.pdf !== null, compiled.pdf ? compiled.pdf.path : '(none)')
if (compiled.pdf) {
  const head = await fetch(compiled.pdf.url, { headers: { Cookie: COOKIE } })
  const bytes = new Uint8Array(await head.arrayBuffer())
  const magic = String.fromCharCode(...bytes.slice(0, 5))
  ok('pdf url serves a real pdf', magic === '%PDF-', `${bytes.length} bytes, magic=${magic}`)
}

// --- 6. cookie fingerprint never leaks the value ---
const { cookieFingerprint } = await import('./lib/overleaf.js')
const fp = cookieFingerprint(COOKIE)
// The report is *meant* to name the cookies (overleaf.sid, latex-session); what
// it must never carry is a value. Compare against values only, and treat every
// field long enough to be a secret as one.
const reported = new Set(fp.names)
const values = COOKIE.split(/[=;]\s*/).filter((part) => part.length >= 12 && !reported.has(part))
const leaked = values.filter((part) => JSON.stringify(fp).includes(part))
ok('fingerprint reports shape only', leaked.length === 0, JSON.stringify(fp))

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`)
process.exitCode = failed === 0 ? 0 : 1
