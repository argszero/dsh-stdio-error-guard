/**
 * Shared fixtures: a cordis-shaped context that records what the plugin logged,
 * and the two objects the plugin's seam touches.
 *
 * The plugin's whole outward surface is four calls on a context, so the fake is
 * small on purpose — a test that mounts a real fiber just to assert a log line
 * would be testing cordis rather than this plugin. The one place a real fiber
 * *is* the point (the spawn seam, over a real child) uses the shipped modules in
 * `witness.spec.mjs`.
 */

import { PassThrough } from 'node:stream'

/** A logger that keeps every line, with the level it was written at. */
export function recordingLogger() {
  const lines = []
  const record = level => (message) => { lines.push({ level, message: String(message) }) }
  return {
    lines,
    warn: record('warn'),
    debug: record('debug'),
    info: record('info'),
    error: record('error'),
    /** Every line whose text contains `needle`. */
    matching(needle) { return lines.filter(line => line.message.includes(needle)) },
    /** The joined text of every line. */
    text() { return lines.map(line => line.message).join('\n') },
  }
}

/**
 * A context that satisfies the plugin's declared surface.
 * @param options - the service to expose, the view kind, and a logger.
 */
export function fakeContext(options = {}) {
  const logger = options.logger ?? recordingLogger()
  const effects = []
  const view = (target) => {
    const proxy = Object.create(null)
    if (target !== undefined) {
      Object.defineProperty(proxy, Symbol.for('cordis.original'), { value: target, enumerable: false })
    }
    return proxy
  }
  const ctx = {
    logger,
    subprocess: options.instance,
    get(name) {
      if (name !== 'subprocess') return undefined
      if (options.instance === undefined) return undefined
      // Mirror cordis: `get` answers a tracking view, and the view answers the
      // original symbol with the underlying instance. `bareView` drops the
      // symbol, which is the fallback path `resolveSubprocessInstance` keeps.
      return options.bareView === true ? view(undefined) : view(options.instance)
    },
    effect(register, label) {
      effects.push({ undo: register(), label })
    },
  }
  return { ctx, logger, effects }
}

/**
 * A handle shaped like the one the subprocess service returns for a piped child.
 *
 * The streams are real `PassThrough`s on purpose: a real stream is the only
 * object that proves the listener is accepted, and `PassThrough` is what the
 * provider hands back for a `'pipe'` mode.
 * @param options - which slots to populate, and a `done` promise.
 */
export function fakeHandle(options = {}) {
  const handle = {
    stdin: options.stdin ?? new PassThrough(),
    stdout: options.stdout ?? new PassThrough(),
    stderr: options.stderr ?? new PassThrough(),
    control: options.control ?? new PassThrough(),
    collected: {},
    done: options.done ?? new Promise(() => {}),
    terminate() {},
    waitForExit() { return Promise.resolve(true) },
  }
  if (options.omit !== undefined) {
    for (const slot of options.omit) handle[slot] = undefined
  }
  if (options.replace !== undefined) {
    for (const [slot, value] of Object.entries(options.replace)) handle[slot] = value
  }
  return handle
}

/** A terminal handle: one byte stream named `output`, and no child slots at all. */
export function fakeTerminalHandle(options = {}) {
  return {
    output: options.output ?? new PassThrough(),
    done: options.done ?? new Promise(() => {}),
    terminate() {},
  }
}

/**
 * A stand-in for the subprocess service: both shadowed methods live on the
 * prototype, exactly as they do on `SubprocessRuntime`.
 */
export class FakeRuntime {
  constructor() {
    this.calls = []
    this.handles = new Map()
  }

  spawn(spec) {
    this.calls.push(['spawn', spec])
    return this.handles.get(spec) ?? fakeHandle()
  }

  spawnTerminal(spec) {
    this.calls.push(['spawnTerminal', spec])
    return Promise.resolve(this.handles.get(spec) ?? fakeTerminalHandle())
  }
}

/** The code an `ECONNRESET` error carries, attached the way Node attaches it. */
export function pipeError(code = 'ECONNRESET', message = 'read ECONNRESET') {
  const error = new Error(message)
  error.code = code
  return error
}

/** A temporary directory removed when `run` finishes. */
export async function withTempDir(run) {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'stdio-error-guard-test-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
