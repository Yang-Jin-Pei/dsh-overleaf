/**
 * Overleaf client half — a pre-built module for the DSH web shell.
 *
 * This file is authored directly in the browser-module format the shell loads
 * (`window.__ModuleLoader__.load`), because the shell consumes *built* client
 * exports: a missing `lib/client.js` fails activation loudly. Authoring the
 * format by hand keeps the plugin build-tool-free.
 *
 * Two rules of that format:
 *   - React arrives through `require`, resolved against the shell's frozen
 *     baseline table; it is not a global here (it is a global only inside the
 *     dynamic-package sandbox).
 *   - Every side effect (slot registration, CSS) belongs to `apply`'s fiber via
 *     `ctx.effect` / `ctx.slots.inject`, so unloading the plugin removes it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-overleaf',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'overleaf'

    /**
     * The official Overleaf mark (Simple Icons path data, 24x24). Filled rather
     * than stroked, because it is a logo and not a UI glyph.
     */
    const OVERLEAF_MARK = 'M22.3515.7484C19.1109-.5101 7.365-.982 7.3452 6.0266c-3.4272 2.194-5.6967 5.768-5.6967 9.598a8.373 8.373 0 0 0 13.1225 6.898 8.373 8.373 0 0 0-1.7668-14.7194c-.6062-.2339-1.9234-.6481-2.9753-.559-1.5007.9544-3.3308 2.9155-4.1949 4.8693 2.5894-3.082 7.5046-2.425 9.1937 1.2287 1.6892 3.6538-.9944 7.8237-5.0198 7.7998a5.4995 5.4995 0 0 1-4.1949-1.9328c-1.485-1.7483-1.8678-3.6444-1.5615-5.4975 1.057-6.4947 8.759-10.1894 14.486-11.6094-1.8677.989-5.2373 2.6134-7.5948 4.3837C18.015 9.1382 19.1308 3.345 22.3515.7484z'

    /**
     * Client→Host call. A static plugin has no `host.call` (that belongs to the
     * dynamic-package sandbox), so the panel posts to the route its own host half
     * registered on the shell's web server. Same origin, so no CORS surface.
     *
     * @param {string} method operation name declared by the host half
     * @param {object} [args] JSON arguments
     */
    function rpc(method, args) {
      return fetch('/overleaf/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args: args === undefined ? {} : args }),
      }).then((response) => {
        if (!response.ok) throw new Error('overleaf rpc HTTP ' + response.status)
        return response.json()
      }).then((payload) => {
        if (payload && payload.error) throw new Error(payload.error)
        return payload
      })
    }

    /** The sidebar glyph: the real Overleaf mark, in Overleaf's own green. */
    function PanelIcon(props) {
      const size = (props && props.size) || 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24',
        fill: '#47a141', xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true', focusable: 'false',
      }, h('path', { d: OVERLEAF_MARK }))
    }

    /**
     * Styles are injected once per client run and scoped under `.ovl`. Colors come
     * from the shell's own theme tokens, so the panel follows light/dark and any
     * custom theme instead of hard-coding a palette.
     */
    const CSS = `
.ovl { height: 100%; overflow-y: auto; padding: 18px 20px 28px; box-sizing: border-box;
  font-family: inherit; color: var(--dsw-alias-label-primary); font-size: 13px; }
.ovl-head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.ovl-head svg { flex: none; }
.ovl-title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.ovl-host { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ovl-head .ovl-spacer { flex: 1; }

.ovl-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; margin-bottom: 16px; }
.ovl-status { display: flex; align-items: center; gap: 8px; }
.ovl-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.ovl-dot.live { background: var(--dsw-alias-state-success-primary); }
.ovl-dot.dead { background: var(--dsw-alias-state-error-primary); }
.ovl-dot.unknown { background: var(--dsw-alias-label-secondary); }
.ovl-who { margin-top: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); }

.ovl-btn { border: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: var(--dsw-alias-label-primary); border-radius: 7px; padding: 4px 10px;
  font-size: 12px; font-family: inherit; line-height: 1.5; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease; white-space: nowrap; }
.ovl-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2); }
.ovl-btn:disabled { opacity: 0.4; cursor: default; }

.ovl-section { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--dsw-alias-label-secondary); }

.ovl-item { border-radius: 8px; transition: background 120ms ease; }
.ovl-item:hover { background: var(--dsw-alias-bg-layer-2); }
.ovl-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; }
.ovl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.ovl-meta { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ovl-acts { flex: none; display: flex; gap: 6px; opacity: 0; transition: opacity 120ms ease; }
.ovl-item:hover .ovl-acts, .ovl-item:focus-within .ovl-acts { opacity: 1; }
@media (hover: none) { .ovl-acts { opacity: 1; } }

.ovl-files { margin: 0 10px 8px; padding: 6px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); max-height: 260px; overflow-y: auto; }
.ovl-file { display: flex; gap: 8px; padding: 2px 0; font-size: 11.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dsw-alias-label-secondary); }
.ovl-file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ovl-file.doc span { color: var(--dsw-alias-label-primary); }

.ovl-note { margin-top: 14px; padding: 9px 12px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 1.6;
  word-break: break-word; color: var(--dsw-alias-label-secondary); }
.ovl-note.err { color: var(--dsw-alias-state-error-primary); }
.ovl-empty { padding: 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ovl-spin { color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 8px 0; }
`

    /** The mark, reused at header size. */
    function HeaderMark() {
      return h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: '#47a141',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
      }, h('path', { d: OVERLEAF_MARK }))
    }

    /** A small status dot; the class carries the token color. */
    function Dot(props) {
      const kind = props.unknown ? 'unknown' : (props.live ? 'live' : 'dead')
      return h('span', { className: 'ovl-dot ' + kind, 'aria-hidden': 'true' })
    }

    /** A labelled action button; styling lives in CSS so hover states work. */
    function Button(props) {
      return h('button', {
        className: 'ovl-btn',
        type: 'button',
        disabled: props.disabled === true,
        onClick: props.onClick,
        title: props.title,
      }, props.children)
    }

    /** Kind labels, kept short so the meta column never wraps. */
    const KIND = { doc: 'tex', file: 'file', folder: 'dir' }

    function PanelBody() {
      const [view, setView] = React.useState({ phase: 'loading' })
      const [openProject, setOpenProject] = React.useState(null)
      const [files, setFiles] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [log, setLog] = React.useState(null)
      const [cookie, setCookie] = React.useState('')

      const load = React.useCallback(() => {
        setView({ phase: 'loading' })
        rpc('overview')
          .then((data) => setView({ phase: 'ready', data }))
          .catch((error) => setView({ phase: 'error', message: String((error && error.message) || error) }))
      }, [])

      React.useEffect(() => { load() }, [load])

      const toggleFiles = (project) => {
        if (openProject === project.id) { setOpenProject(null); setFiles(null); return }
        setOpenProject(project.id)
        setFiles(null)
        rpc('files', { projectId: project.id })
          .then(setFiles)
          .catch((error) => setFiles({ error: String((error && error.message) || error) }))
      }

      /** All mutations share one busy flag so two cannot race. */
      const act = (label, method, args) => {
        setBusy(method)
        setLog(label)
        rpc(method, args)
          .then((result) => setLog(result && result.message ? result.message : JSON.stringify(result)))
          .catch((error) => setLog('Error: ' + String((error && error.message) || error)))
          .then(() => setBusy(null))
      }

      const signIn = () => {
        const value = cookie.trim()
        if (!value) return
        act('Verifying cookie…', 'login', { cookie: value })
        setCookie('')
        // The panel's state must reflect the new session once the call settles.
        setTimeout(load, 400)
      }

      const children = []

      children.push(h('div', { key: 'head', className: 'ovl-head' },
        h(HeaderMark, null),
        h('span', { className: 'ovl-title' }, 'Overleaf'),
        h('span', { className: 'ovl-host' }, 'latex.cstcloud.cn'),
        h('span', { className: 'ovl-spacer' }),
        h(Button, { onClick: load, disabled: busy !== null, title: 'Reload projects' }, 'Refresh'),
      ))

      if (view.phase === 'loading' && !view.data) {
        children.push(h('div', { key: 'loading', className: 'ovl-spin' }, 'Contacting Overleaf…'))
      } else if (view.phase === 'error') {
        children.push(h('div', { key: 'error', className: 'ovl-note err' },
          'Could not reach the panel host: ' + view.message))
      } else {
        const data = view.data || {}
        const live = Boolean(data.live)
        const configured = data.configured !== false

        children.push(h('div', { key: 'session', className: 'ovl-card' },
          h('div', { className: 'ovl-status' },
            h(Dot, { live, unknown: !configured }),
            h('span', null, !configured ? 'No session stored' : (live ? 'Session live' : 'Session rejected')),
          ),
          h('div', { className: 'ovl-who' },
            (data.userEmail || 'not signed in') + (data.savedAt ? '  ·  ' + data.savedAt : '')),
          !live ? h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px' } },
            h('input', {
              className: 'ovl-btn',
              style: { flex: 1, minWidth: 0, cursor: 'text' },
              type: 'password',
              placeholder: 'Paste Cookie header value',
              value: cookie,
              onChange: (event) => setCookie(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') signIn() },
            }),
            h(Button, { onClick: signIn, disabled: busy !== null || !cookie.trim() }, busy === 'login' ? '…' : 'Sign in'),
          ) : null,
          data.note ? h('div', { className: 'ovl-note err', style: { marginTop: '10px' } }, data.note) : null,
        ))

        const projects = data.projects || []
        children.push(h('div', { key: 'plabel', className: 'ovl-section' },
          'Projects',
          h('span', { style: { fontWeight: 400 } }, '(' + projects.length + ')'),
        ))

        if (projects.length === 0) {
          children.push(h('div', { key: 'none', className: 'ovl-empty' },
            configured ? 'No projects returned.' : 'Sign in above, or call ovl_login with a session cookie.'))
        }

        for (const project of projects) {
          const isOpen = openProject === project.id
          children.push(h('div', { key: project.id, className: 'ovl-item' },
            h('div', { className: 'ovl-row' },
              h('span', { className: 'ovl-name', title: project.name }, project.name),
              h('span', { className: 'ovl-meta' }, project.accessLevel || ''),
              h('span', { className: 'ovl-acts' },
                h(Button, {
                  onClick: () => toggleFiles(project),
                  disabled: busy !== null,
                  title: 'List files',
                }, isOpen ? 'Files −' : 'Files'),
                h(Button, {
                  onClick: () => act('Downloading ' + project.name + ' …', 'download',
                    { projectId: project.id, name: project.name }),
                  disabled: busy !== null,
                  title: 'Download the project zip into the working directory',
                }, busy === 'download' ? '…' : 'Download'),
                h(Button, {
                  onClick: () => act('Compiling ' + project.name + ' …', 'compile', { projectId: project.id }),
                  disabled: busy !== null,
                  title: 'Compile and get the PDF URL',
                }, busy === 'compile' ? '…' : 'Compile'),
              ),
            ),
            isOpen ? h('div', { className: 'ovl-files' },
              files === null
                ? h('div', { className: 'ovl-empty' }, 'Listing files…')
                : files.error
                  ? h('div', { className: 'ovl-empty', style: { color: 'var(--dsw-alias-state-error-primary)' } }, files.error)
                  : (files.entities || []).length === 0
                    ? h('div', { className: 'ovl-empty' }, 'Empty project.')
                    : (files.entities || []).slice(0, 60).map((entry) => h('div', {
                      key: 'f:' + entry.path,
                      className: 'ovl-file' + (entry.type === 'doc' ? ' doc' : ''),
                      title: entry.path,
                    },
                      h('span', { style: { flex: 'none', opacity: 0.55, width: '32px' } }, KIND[entry.type] || entry.type),
                      h('span', null, entry.path),
                    )),
            ) : null,
          ))
        }
      }

      if (log) {
        children.push(h('div', {
          key: 'log',
          className: 'ovl-note' + (/^(error|compile failed)/i.test(log) ? ' err' : ''),
        }, log))
      }

      return h('div', { className: 'ovl' }, children)
    }

    /** Idempotent stylesheet mounting, so an HMR re-apply replaces one node. */
    const STYLE_ID = 'dsh-plugin-overleaf-styles'

    function mountStyles() {
      const existing = document.getElementById(STYLE_ID)
      if (existing) existing.remove()
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        const current = document.getElementById(STYLE_ID)
        if (current) current.remove()
      }
    }

    /**
     * Client plugin body. Every registration lives inside `ctx.effect` and the
     * stylesheet is removed by its disposer, so the column, the icon, and the
     * styles all disappear together with the plugin.
     *
     * Note `styles.insert(...)` is NOT available here: that helper is a builtin of
     * the dynamic-package sandbox, and the shell's platform module table has no
     * `styles` entry. A built bundle mounts its CSS through the DOM.
     */
    function apply(ctx) {
      ctx.effect(() => mountStyles(), 'overleaf: panel styles')

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: 'Overleaf' },
        PanelIcon,
      )), 'overleaf: sidebar panel icon')

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID },
        PanelBody,
      )), 'overleaf: main panel body')
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.name = 'dsh-plugin-overleaf-client'
    return module.exports
  },
})
