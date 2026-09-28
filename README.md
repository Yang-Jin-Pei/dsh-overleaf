# dsh-plugin-overleaf

English | [中文](README.zh.md)

Overleaf access for DeepSeek Harness, with both model tools and a browser panel.
Works with self-hosted Overleaf / Overleaf CE instances, including ones that
authenticate only through OIDC/SSO and therefore have no password login at all.

Verified against `https://latex.cstcloud.cn/` (CSTCloud, OIDC/AAI-only).

## What it does

**A sidebar panel.** The left rail gets an *Overleaf* entry; opening it shows the
signed-in account, every project, and per-project **Files**, **Download**, and
**Compile** actions, plus a Refresh button. The buttons act on the real instance —
Compile really compiles and prints the PDF's direct URL, Download writes the
project zip into the session working directory.

**Seven model-facing tools:**

| Tool | Purpose |
|---|---|
| `ovl_login` | Store and verify a session cookie |
| `ovl_status` | Report whether the stored session still works |
| `ovl_logout` | Forget the session |
| `ovl_projects` | List projects (live, with authoritative ids) |
| `ovl_files` | List a project's files as absolute paths |
| `ovl_download` | Download a project's zip archive |
| `ovl_compile` | Compile server-side and return the PDF URL |

## Authentication

The plugin never authenticates. It consumes a session cookie produced elsewhere
and keeps it in the harness credential store.

`latex.cstcloud.cn` disables password login (`recaptchaDisabled.login: true`,
and the login page offers only *使用 CSTCloud AAI 认证*), so neither
`passportLogin(email, password)` nor a scripted password form can work. Get the
cookie one of these ways:

1. **Browser + DevTools** — log in normally, open DevTools → Network, click any
   request to the instance, and copy the whole `Cookie` **request header**.
2. **VS Code Overleaf Workshop** — if that extension is already logged in, the
   cookie sits in `%APPDATA%\Code\User\globalStorage\state.vscdb` under the key
   `iamhyc.overleaf-workshop` (read-only access; the plugin never writes there).

Then call `ovl_login` with that value.

**The cookie must contain `overleaf.sid`.** The instance also sets
`latex-session`, which is *not* HttpOnly and is easy to copy by mistake — but on
its own it returns **401**. Verified: `overleaf.sid` + `latex-session` → 200;
`latex-session` alone → 401.

Sessions **slide** on each request but expire after ~5 days of inactivity, so an
unused session dies. On expiry every tool fails with `AUTH_EXPIRED` and tells the
model to re-login; nothing is retried silently.

## Install

For a profile the CLI owns (`web`, `tui`), one command:

```
dsh plugin --profile web add link:C:/Users/33901/.dsh/plugins/dsh-plugin-overleaf
```

`dsh plugin add` records the package in the profile's `dsh.profile.bundles`, which
is what makes it load — no manual `cordis.patch.yml` edit is needed in the profile.

The **`desktop`** profile is *not* CLI-owned, and the command above refuses it:

```
error: profile "desktop" is managed exclusively by the Electron application
```

Use the Web sidebar's **Plugins** page instead (its install field takes an
absolute path or a `link:` spec), or run `install.ps1`, which does the same
wiring by hand:

```
pwsh -File install.ps1
```

**A restart is required** to pick up a newly added bundle. `patchReload: live`
only covers patch-file edits, not new bundles.

### Moving it to another machine

The install is four things and `git clone` delivers only the first: the source,
the profile's dependency entry, its `dsh.profile.bundles` selection, and both
`node_modules` links — including the package-local `@deepseek-ai/*` junctions
described below, which Node needs because a `link:` install resolves the real
path. `install.ps1` does the remaining three and then runs `test-register.mjs` to
prove the package loads.

The Overleaf cookie is never part of this: it is a secret in the credential
store, so log in on the new machine and call `ovl_login` again.

Chinese walkthrough, both routes included: [MIGRATION.zh.md](MIGRATION.zh.md).

## Hacking on it

The install is a junction, so edits to this directory are live — but see the
`node_modules` note below.

- `lib/overleaf.js` — the HTTP client. **The only file that knows this instance's
  endpoints and quirks.** No DSH imports, no external dependencies, so it runs
  under plain `node`.
- `lib/session-store.js` — credential-seam read/write.
- `index.js` — `apply()`: tool registration + the authorization flow.

### The node_modules junction

Because the profile installs this package as a *junction*, Node resolves the real
path (`C:\Users\33901\.dsh\plugins\dsh-plugin-overleaf`) and walks **up from
there** for `node_modules` — it never sees `profiles/node_modules`, where the
`@deepseek-ai/*` packages live. The fix is the local `node_modules\@deepseek-ai`
junction set in this directory, pointing at `C:\Users\33901\.dsh\profiles\node_modules\@deepseek-ai`.

Without it, the plugin fails at import with `ERR_MODULE_NOT_FOUND:
@deepseek-ai/schemastery`. If the plugin ever fails to load, check those
junctions first.

### Tests

All three run without a DSH restart. `test-register` and `test-client` must run
from **this** directory so the local `node_modules` junctions resolve.

```
node test-api.mjs        # live HTTP against the instance (needs OVL_COOKIE, see below)
node test-register.mjs   # host apply() with stub ctx — catches registration crashes
node test-client.mjs     # client bundle inside a fake shell environment
```

`test-api.mjs` takes the cookie from `OVL_COOKIE` — it is a secret, so it is
never written into the file:

```
pwsh:  $env:OVL_COOKIE = 'overleaf.sid=...; latex-session=...'; node test-api.mjs
sh:    OVL_COOKIE='overleaf.sid=...' node test-api.mjs
```

It exits non-zero when any check fails, so it is usable as a gate.

`test-register.mjs` and `test-client.mjs` exist because the browser is otherwise
the first place a failure appears — as a missing icon plus a console error nobody
is watching. `test-client.mjs` reconstructs the loader contract
(`window.__ModuleLoader__`, `require`, `document`) in a `node:vm`, asserts the icon
is the real Overleaf mark rather than a generic glyph, and asserts the stylesheet
is removed when its effect is disposed.

### Visual language

The panel reuses the shell's own theme tokens (`--dsw-alias-bg-layer-*`,
`--dsw-alias-border-l*`, `--dsw-alias-label-*`, `--dsw-alias-state-*`) so it follows
light/dark and any custom theme instead of carrying a private palette. The one
hard-coded color is Overleaf's brand green (`#47a141`) on the logo, which is the
point of a brand mark.

The rail shows **only the mark**; `label` is what the shell uses for its tooltip
and accessible name. Row actions (Files / Download / Compile) reveal on hover so
the list stays quiet, and are forced visible under `@media (hover: none)` so touch
users are not locked out.

Icon path data is the official Overleaf mark from
[Simple Icons](https://github.com/simple-icons/simple-icons) (`icons/overleaf.svg`),
filled rather than stroked because it is a logo, not a UI glyph.

## The browser half

`lib/client.js` is **authored directly in the shell's module format** rather than
produced by a bundler:

```js
window.__ModuleLoader__.load({ id: 'dsh-plugin-overleaf', factory: (require) => { … } })
```

The shell consumes *built* client exports, so a missing `lib/client.js` fails
activation loudly. Hand-authoring the format keeps the plugin build-tool-free.
Two rules of that format:

- React arrives through `require('react')`, resolved against the shell's frozen
  baseline module table. It is **not** a global here — the `React` global exists
  only inside the dynamic-package sandbox. (Getting this wrong is the exact cause
  of `Cannot read properties of undefined (reading 'createElement')`.)
- Every side effect belongs to `apply`'s fiber via `ctx.effect` / `ctx.slots.inject`,
  so unloading the plugin removes both the panel and its icon.

The panel occupies two seats: the icon in the root-scoped `sidebar.panellist`
list, and the body in the root-scoped keyed `main` slot under the **same id** —
that shared id is what ties the rail button to the column.

### Client → Host RPC, and why it is a raw HTTP route

There are three ways a browser half can reach a host half. Two are unavailable here:

| Mechanism | Available? |
|---|---|
| `host.call()` | **No** — that is the dynamic-package sandbox's private channel, not a static plugin's |
| `Remote` / `TypertRemoteService` | **No** — the typed remote seam needs build-time code generation |
| `ctx.webServer.register(...)` | **Yes** — used here |

So the host half registers an exact route at `POST /overleaf/rpc`, and the panel
`fetch`es it. Same origin, no CORS surface; the route is owned by the plugin's
fiber and disappears with it. Methods: `overview`, `files`, `download`, `compile`,
`login`, `logout`. Failures come back as `{ error }` with HTTP 200 so the panel can
render them as text instead of throwing.

## Instance quirks already handled

All verified against `latex.cstcloud.cn`:

- `GET /project` returns **HTML**, and the `ol-projects` meta tag is **absent**
  on this instance → project ids come from `GET /user/projects` (`_id`).
- Entity nodes carry `{ path, type }` where `path` is **absolute**, not `name`.
- `GET /project/<id>/download/zip` **ignores Range** and always streams the whole
  archive (24 MB for one test project) — it is streamed to disk, never buffered.
- Write operations need `X-Csrf-Token`, read from the `ol-csrfToken` meta.
- No git integration (`/git` → 404), so git-token tools cannot work here.

## Credential record shape

Stored as an `api-key` record, **not** a `grant`:

- `key` → the cookie header value
- `env` → `{ baseUrl, savedAt, userId, userEmail }` as strings

A `grant` record is unusable: the local credential store rejects **any** keyed
object as a `payload` value — including `{}` — with *"payload holds a value JSON
cannot represent"*. `api-key.env` is the seam's own string map and round-trips
exactly. The reader still accepts `grant` so older records do not vanish.

## Not implemented

- Uploading and two-way sync (`ovl_upload`, `ovl_sync`)
- A settings page (`settings.section`). The authorization flow *is* registered, but
  the shipped web frontend renders no authorization UI, so sign-in goes through the
  panel's `login` RPC or the `ovl_login` tool instead.
- Real-time collaborative editing (Socket.IO + OT). Deliberately out of scope.
