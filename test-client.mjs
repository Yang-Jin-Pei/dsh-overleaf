/**
 * Client-half smoke test.
 *
 * The shell consumes a *built* client bundle whose only contract is
 * `window.__ModuleLoader__.load({ id, factory })` plus `require` for framework
 * modules. This test reconstructs exactly that environment so a broken client
 * half fails here instead of in the browser — where the only symptom is a
 * missing icon and a console error nobody is watching.
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const source = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')

const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)

// --- minimal React -----------------------------------------------------------
const react = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.filter((c) => c !== null && c !== undefined) }
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
  useCallback(fn) { return fn },
}

// --- minimal document --------------------------------------------------------
const head = {
  children: [],
  appendChild(node) { this.children.push(node) },
}
const document = {
  head,
  getElementById(id) { return head.children.find((n) => n.id === id) || null },
  createElement(tag) {
    return {
      tagName: tag, id: '', textContent: '',
      remove() { const i = head.children.indexOf(this); if (i >= 0) head.children.splice(i, 1) },
    }
  },
}

// --- capture what the bundle registers --------------------------------------
let loaded = null
const window = {
  __ModuleLoader__: {
    load(spec) { loaded = spec },
  },
}

const requireMap = {
  react,
  'react/jsx-runtime': { jsx: react.createElement, jsxs: react.createElement },
}

const sandbox = {
  window,
  document,
  require: (name) => {
    if (!(name in requireMap)) throw new Error(`unexpected require("${name}") — not in the shell's platform table`)
    return requireMap[name]
  },
  fetch: async () => { throw new Error('fetch not stubbed') },
  console,
  setTimeout,
}
runInContext(source, createContext(sandbox), { filename: 'client.js' })

// --- the loader contract -----------------------------------------------------
ok('bundle registers itself with the shell loader', loaded !== null)
ok('bundle declares the package id',
  loaded?.id === 'dsh-plugin-overleaf', String(loaded?.id))
ok('bundle exposes a factory', typeof loaded?.factory === 'function')

const client = loaded.factory(sandbox.require)
ok('factory returns exports', typeof client === 'object' && client !== null)
ok('exports an apply()', typeof client.apply === 'function')
ok('exports inject', Array.isArray(client.inject), JSON.stringify(client.inject))

// --- apply() against a stub client context -----------------------------------
const slots = []
const effects = []
const ctx = {
  slots: {
    inject(key, callback) {
      const disposer = callback()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    register(registration, component) {
      slots.push({ registration, component })
      return () => {}
    },
  },
  effect(callback, label) {
    const disposer = callback()
    effects.push({ label, disposer })
    return () => {}
  },
}

let applyError = null
try {
  client.apply(ctx)
} catch (error) {
  applyError = error
}
ok('apply() does not throw', applyError === null, applyError ? applyError.message : '')
if (applyError) {
  console.log('      ' + applyError.stack)
  process.exit(1)
}

// --- what it registered ------------------------------------------------------
console.log('\nregistered slots: ' + slots.map((s) => s.registration.name).join(', '))
const panelIcon = slots.find((s) => s.registration.name === 'sidebar.panellist')
const mainBody = slots.find((s) => s.registration.name === 'main')

ok('registers a sidebar panel icon', Boolean(panelIcon),
  panelIcon ? `id=${panelIcon.registration.id} order=${panelIcon.registration.order}` : '')
ok('the icon carries a label for the rail tooltip',
  panelIcon?.registration.label === 'Overleaf', String(panelIcon?.registration.label))
ok('registers the main panel body under the SAME id',
  mainBody?.registration.key === panelIcon?.registration.id,
  `${mainBody?.registration.key} vs ${panelIcon?.registration.id}`)
ok('registered exactly two seats', slots.length === 2, `${slots.length} seat(s)`)

// --- the icon must be the real Overleaf mark, not a generic glyph -------------
const icon = panelIcon.component({ size: 20 })
ok('icon renders an svg', icon?.type === 'svg', String(icon?.type))
ok('icon is filled (a logo), not stroked',
  typeof icon.props.fill === 'string' && icon.props.fill !== 'none', String(icon.props.fill))
ok('icon uses Overleaf green', icon.props.fill === '#47a141', String(icon.props.fill))
ok('icon carries the logo path',
  icon.children.some((c) => c?.type === 'path' && String(c.props.d).startsWith('M22.3515')),
  'path starts with M22.3515')

// --- stylesheet lifecycle ----------------------------------------------------
const styleEffects = effects.filter((e) => e.label.includes('styles'))
ok('mounts a stylesheet through an effect', styleEffects.length === 1)
ok('stylesheet node is in the document', head.children.some((n) => n.tagName === 'style'))
const css = head.children.find((n) => n.tagName === 'style')?.textContent ?? ''
ok('stylesheet is scoped under .ovl', css.includes('.ovl {') || css.includes('.ovl{'))
ok('stylesheet uses shell theme tokens, not hard-coded colors',
  css.includes('var(--dsw-alias-'), `${(css.match(/var\(--dsw-alias-/g) || []).length} token uses`)
ok('stylesheet avoids raw hex colors for surfaces',
  !/background:\s*#/.test(css), 'no background hex')
if (typeof styleEffects[0]?.disposer === 'function') {
  styleEffects[0].disposer()
  ok('disposing the effect removes the stylesheet',
    !head.children.some((n) => n.tagName === 'style'))
}

// --- the panel body renders without throwing ---------------------------------
console.log('\n--- panel body render ---')
try {
  const tree = mainBody.component({})
  ok('panel body renders a tree', tree?.type === 'div', String(tree?.type))
  ok('panel body is class-scoped', tree.props.className === 'ovl', String(tree.props.className))
} catch (error) {
  // useEffect/useState are stubbed to no-ops, so a throw here means a real bug.
  ok('panel body renders a tree', false, error.message)
}
