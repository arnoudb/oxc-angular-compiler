/**
 * Vite 8 always full-reloads a `.html` change when no JS modules remain
 * after `handleHotUpdate` / `hotUpdate`. Component templates are not Vite
 * page entries — Angular HMR already applied the update — so a subsequent
 * `full-reload` (path `*`, `/src/app/foo.component.html`, …) must be
 * suppressed. See https://github.com/voidzero-dev/oxc-angular-compiler/issues/443
 *
 * Analog marks the owning component module self-accepting so Vite's
 * pipeline treats the update as accepted. That is not enough when the
 * template is absent from the module graph (this plugin does not
 * `addWatchFile` templates): Vite still takes the empty-modules + `.html`
 * path and sends `full-reload`. The client guard below is the safety net
 * for that case, scoped to a short window after `angular:component-update`
 * so legitimate reloads (`index.html`, `angular:invalidate`, class-body
 * edits) still go through.
 */

import type { ModuleNode } from 'vite'

/** Window after a component HMR event during which a Vite HTML full-reload is skipped. */
export const TEMPLATE_HMR_RELOAD_SUPPRESS_MS = 250

/**
 * Whether a Vite `full-reload` payload should be swallowed because we just
 * applied Angular template/style HMR.
 *
 * `path` is Vite's payload.path: `*` (middlewareMode / mixed updates), a
 * root-relative HTML url (`/src/app/foo.component.html`), or empty.
 */
export function shouldSuppressViteFullReload(
  path: string | undefined,
  recentlyHandledComponentUpdate: boolean,
): boolean {
  if (!recentlyHandledComponentUpdate) return false
  if (!path || path === '*') return true
  const file = path.split('?')[0]
  // The app's HTML entry must still reload.
  if (/(?:^|\/)index\.html?$/.test(file)) return false
  return /\.html?$/.test(file)
}

/**
 * Mark a module (and its Vite 6+ `_clientModule`, if present) as
 * self-accepting so HMR propagation stops instead of falling through to a
 * full page reload. Mirrors Analog's `markModuleSelfAccepting`.
 */
export function markModuleSelfAccepting<T extends ModuleNode>(mod: T): T {
  const mixed = mod as T & { _clientModule?: ModuleNode }
  if (mixed._clientModule) {
    mixed._clientModule.isSelfAccepting = true
  }
  mod.isSelfAccepting = true
  return mod
}

/**
 * Client snippet injected once via `transformIndexHtml`. Listens for
 * `angular:component-update` and, for a short window, throws out of
 * `vite:beforeFullReload` when the payload is a leftover template HTML
 * reload. Throwing is the documented way to cancel Vite's client reload.
 */
export const HMR_FULL_RELOAD_GUARD = `(function () {
  var suppressUntil = 0;
  var hot = import.meta.hot;
  if (!hot) return;
  hot.on('angular:component-update', function () {
    suppressUntil = Date.now() + ${TEMPLATE_HMR_RELOAD_SUPPRESS_MS};
  });
  hot.on('vite:beforeFullReload', function (payload) {
    if (Date.now() > suppressUntil) return;
    var path = (payload && payload.path) || '';
    var file = path.split('?')[0];
    if (/(?:^|\\/)index\\.html?$/.test(file)) return;
    if (!path || path === '*' || /\\.html?$/.test(file)) {
      throw '(oxc-angular: skipping full reload for template HMR)';
    }
  });
})();
`
