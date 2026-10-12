import { describe, expect, it } from 'vitest'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

const HERMES = { agent: 'hermes', processName: 'hermes' }

// Shapes from hermes_cli/_launchers.py at NousResearch/hermes-agent@687c666a.
const RUNTIME_BOOTSTRAP =
  "import os, sys, runpy; os.environ.pop('PYTHONHOME', None); " +
  "sys.path.insert(0, '/opt/hermes-agent'); import hermes_bootstrap; " +
  "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"
const SHELL_LAUNCHER_SCRIPT = [
  'import os, re, sys',
  "sys.path.insert(0, '/home/dev/.hermes/hermes-agent')",
  'import hermes_bootstrap',
  'from hermes_cli.main import main',
  'sys.exit(main())'
].join('\n')

describe('Hermes launcher recognition', () => {
  it('recognizes the issue #23723 process-tree shapes', () => {
    expect(
      recognizeAgentProcessFromCommandLine(
        "/opt/venv/bin/python3 -I -c 'import hermes_bootstrap' chat --native --tui"
      )
    ).toEqual(HERMES)
    expect(
      recognizeAgentProcessFromCommandLine(
        '/usr/bin/node --expose-gc /opt/hermes-agent/ui-tui/dist/entry.js'
      )
    ).toEqual(HERMES)
    expect(
      recognizeAgentProcessFromCommandLine('/opt/venv/bin/python3 -m tui_gateway.entry')
    ).toEqual(HERMES)
  })

  it('recognizes the quoted bootstrap and the unquoted argv that ps prints for it', () => {
    expect(
      recognizeAgentProcessFromCommandLine(
        `/opt/store/python3 -I -c "${RUNTIME_BOOTSTRAP}" chat --native --tui`
      )
    ).toEqual(HERMES)
    // `ps -o command=` joins argv with spaces and prints newlines as `?`.
    const psLine = `/opt/store/python3 -I -c ${SHELL_LAUNCHER_SCRIPT.replace(/\n/g, '?')} --tui`
    expect(recognizeAgentProcessFromCommandLine(psLine)).toEqual(HERMES)
    expect(
      recognizeAgentProcessFromCommandLine(`python3 -Ic "${SHELL_LAUNCHER_SCRIPT}" chat`)
    ).toEqual(HERMES)
  })

  it('recognizes the wheel TUI bundle and the Hermes CLI module', () => {
    expect(
      recognizeAgentProcessFromCommandLine(
        'node --expose-gc /home/dev/.local/lib/python3.12/site-packages/hermes_cli/tui_dist/entry.js'
      )
    ).toEqual(HERMES)
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node.exe --expose-gc C:\Users\dev\hermes-agent\ui-tui\dist\entry.js`
      )
    ).toEqual(HERMES)
    expect(recognizeAgentProcessFromCommandLine('python3 -m hermes_cli.main --tui')).toEqual(HERMES)
  })

  it('does not treat other inline programs, entry scripts or ACP as Hermes', () => {
    expect(recognizeAgentProcessFromCommandLine("python3 -c 'print(1)' hermes")).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine("python3 -c 'import hermes_bootstrapper'")
    ).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine("python3 -c 'import os' /usr/bin/hermes")
    ).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(
        "python3 -I -c 'import hermes_bootstrap; from acp_adapter.entry import main; main()'"
      )
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('node /repo/app/dist/entry.js')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('python3 -m tui_gateway.ws')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('python3 /repo/script.py -c hermes')).toBeNull()
  })
})
