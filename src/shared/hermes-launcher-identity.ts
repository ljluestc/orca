/**
 * Hermes argv shapes that never name `hermes`.
 *
 * Hermes' git installer publishes `python -I -c '<bootstrap>'` launchers, and without the
 * optional `setproctitle` dependency only Linux `comm` (which Orca's argv snapshot never reads)
 * changes to `hermes`. Each shape below is specific to Hermes' own module or install layout;
 * a bare `python -c` or a generic `entry.js` must stay unrecognized.
 */

// Why: every Hermes launcher imports this module before its entry point; ACP runs the same
// bootstrap but serves a protocol over stdio, not a pane the user types into.
// `ps` prints the launcher's newlines as `?`, so match on word boundaries, not separators.
const HERMES_BOOTSTRAP_IMPORT_RE = /\bimport\s+hermes_bootstrap\b/
const HERMES_ACP_MODULE_RE = /\bacp_adapter\b/

const HERMES_PYTHON_MODULES = new Set(['hermes_cli', 'hermes_cli.main', 'tui_gateway.entry'])

// Git checkouts run `<repo>/ui-tui/dist/entry.js`; wheels ship `hermes_cli/tui_dist/entry.js`.
export const HERMES_TUI_NODE_ENTRYPOINT_RE =
  /(?:^|\/)(?:ui-tui\/dist|hermes_cli\/tui_dist)\/entry\.js$/

export function isHermesPythonInlineSource(source: string): boolean {
  return HERMES_BOOTSTRAP_IMPORT_RE.test(source) && !HERMES_ACP_MODULE_RE.test(source)
}

export function isHermesPythonModule(moduleName: string): boolean {
  return HERMES_PYTHON_MODULES.has(moduleName.toLowerCase())
}
