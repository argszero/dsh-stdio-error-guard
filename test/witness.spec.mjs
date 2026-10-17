/**
 * The seam against the **shipped** implementations: a real cordis `Context`,
 * the real local subprocess provider, and a real child process.
 *
 * `lifecycle.spec.mjs` proves what the plugin decides, over a stand-in service.
 * This file proves the three things that stand-in assumes away, because they are
 * exactly what the plugin promises:
 *
 * 1. Both shadowed methods are **prototype** methods of the shipped provider, so
 *    one own-property write covers a caller that never looked at this plugin —
 *    and the prototype itself is never mutated.
 * 2. The view `ctx.get('subprocess')` returns answers the instance behind it,
 *    which is the object the write has to land on.
 * 3. **The gap is real.** The provider's own `error` listener on a piped stream
 *    is a `once` that `observeOutputStream` removes as soon as the *first* of
 *    `end`, `close` or `error` fires — so after an ordinary child exit the
 *    stream carries no listener at all, and a pipe `error` arriving then is
 *    thrown out of the libuv completion, which is the fatal path #9904 reports.
 *    With the plugin mounted the same event on the same stream is contained and
 *    the caller's own reader still receives every byte.
 *
 * The premise of (1) and (3) is read from the shipped modules rather than
 * restated: if `spawn` moved onto the instance, or the provider grew a
 * permanent listener, this file goes red instead of the plugin silently
 * covering nothing.
 *
 * The plugin's logger is the one thing replaced here (`recordingLogger`): a log
 * line is not on the seam, and the real one has no exporter attached in this
 * process.
 *
 * @module test/witness
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { apply } from '../lib/index.js'
import { pipeError, recordingLogger } from './harness.mjs'

/** The symbol cordis answers with the instance behind a service view. */
const ORIGINAL = Symbol.for('cordis.original')

/** A real context, the shipped provider mounted on it, and a recording logger. */
function mountReal() {
  const app = new Context()
  const provider = new LocalSubprocessRuntime(app)
  const logger = recordingLogger()
  // `logger` is an own property of a cordis context, so replacing it is a shadow
  // of the same kind this plugin installs — and it is the only substitution here.
  Object.defineProperty(app, 'logger', { value: logger, configurable: true })
  return { app, provider, logger }
}

/** A throwaway working directory for the children. */
function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'stdio-error-guard-witness-'))
  return { dir }
}

/** A spec for a real piped child running one inline script. */
function childSpec(dir, code) {
  return {
    argv: [process.execPath, '-e', code],
    cwd: dir,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 5000,
  }
}

/** Every byte a reader collects from a stream. */
function collect(stream) {
  const chunks = []
  stream.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
  return () => Buffer.concat(chunks).toString('utf8')
}

describe('the shipped provider the seam rests on', () => {
  it('keeps both shadowed methods on the prototype, so one own-property write covers every caller', () => {
    const { provider } = mountReal()
    assert.equal(Object.getPrototypeOf(provider), LocalSubprocessRuntime.prototype)
    assert.equal(typeof LocalSubprocessRuntime.prototype.spawn, 'function')
    assert.equal(typeof LocalSubprocessRuntime.prototype.spawnTerminal, 'function')
    assert.equal(Object.prototype.hasOwnProperty.call(provider, 'spawn'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(provider, 'spawnTerminal'), false)
  })

  it('answers a view with the instance, which is the object a write must land on', () => {
    const { app, provider } = mountReal()
    const view = app.get('subprocess')
    assert.equal(typeof view, 'object')
    assert.equal(view[ORIGINAL], provider)
  })

  it('guards a piped stream only until its first terminal event, and then not at all', async () => {
    const { app } = mountReal()
    const { dir } = makeWorkspace()
    try {
      const handle = app.subprocess.spawn(childSpec(dir, 'process.stdout.write("x")'))
      assert.equal(handle.stdout.listenerCount('error'), 1, 'the provider\'s own `once` is attached while the child runs')
      const outcome = await handle.done
      assert.deepEqual(outcome, { exitCode: 0, signal: null })
      assert.equal(handle.stdout.readableEnded, true)
      // The premise of the whole plugin: after an ordinary exit nobody is left
      // listening, so the next `error` on this stream has no home.
      assert.equal(handle.stdout.listenerCount('error'), 0)
      assert.throws(() => { handle.stdout.emit('error', pipeError()) }, /read ECONNRESET/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the seam against the shipped cordis', () => {
  it('is seen by a view created after the write, not only by the one that made it', () => {
    const { app, provider } = mountReal()
    const prototypeSpawn = LocalSubprocessRuntime.prototype.spawn
    const { dir } = makeWorkspace()
    try {
      apply(app, {})
      assert.equal(Object.prototype.hasOwnProperty.call(provider, 'spawn'), true)
      assert.notEqual(provider.spawn, prototypeSpawn)
      // The prototype is left alone: the shadow is one own property, never a
      // mutation of the class every deployment shares.
      assert.equal(LocalSubprocessRuntime.prototype.spawn, prototypeSpawn)
      const later = app.get('subprocess')
      assert.notEqual(later.spawn, prototypeSpawn)
      assert.equal(later[ORIGINAL], provider)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hands the prototype method back when the registration is disposed', () => {
    const { app, provider } = mountReal()
    const prototypeSpawn = LocalSubprocessRuntime.prototype.spawn
    const realEffect = app.effect.bind(app)
    const registrations = []
    // The real `effect` is what runs; only its return value is kept, because the
    // plugin registers the shadow itself and this is the only handle on it.
    app.effect = (execute, label) => {
      const disposable = realEffect(execute, label)
      registrations.push(disposable)
      return disposable
    }
    apply(app, {})
    assert.equal(registrations.length, 1)
    assert.match(registrations[0][Symbol.for('cordis.effect')]?.label ?? '', /restore/)
    for (const dispose of registrations) dispose()
    assert.equal(Object.prototype.hasOwnProperty.call(provider, 'spawn'), false)
    assert.equal(provider.spawn, prototypeSpawn)
  })

  it('refuses to guard anything when the service is absent, and says so instead of failing', () => {
    const app = new Context()
    const logger = recordingLogger()
    Object.defineProperty(app, 'logger', { value: logger, configurable: true })
    assert.doesNotThrow(() => { apply(app, {}) })
    assert.match(logger.text(), /subprocess service is not mounted/)
  })
})

describe('a real child process', () => {
  it('contains the post-close pipe error that kills a host, without taking a byte from the provider', async () => {
    const { app, logger } = mountReal()
    const { dir } = makeWorkspace()
    try {
      apply(app, {})
      // The provider's own call shape: a property read on the context, then spawn.
      const handle = app.subprocess.spawn(childSpec(dir, 'process.stdout.write("the provider\'s own bytes")'))
      // Attached after the spawn returned: this is the reader the caller is, and
      // every byte must still reach it.
      const delivered = collect(handle.stdout)
      const outcome = await handle.done

      assert.deepEqual(outcome, { exitCode: 0, signal: null })
      assert.equal(delivered(), "the provider's own bytes")
      // The one assertion this file exists for: the same stream that threw with
      // nobody listening in the test above is inert here.
      assert.equal(handle.stdout.listenerCount('error'), 1, 'the guard\'s listener outlives the provider\'s `once`')
      assert.doesNotThrow(() => { handle.stdout.emit('error', pipeError('ECONNRESET')) })

      const line = logger.matching('contained ECONNRESET on stdout')[0]?.message ?? ''
      assert.match(line, /of "\/.*node"/, 'the log names the executable the spec started')
      assert.match(line, /reached the process-level handler/)
      assert.match(line, /exit facts remain the authoritative signal/)
      assert.equal(logger.matching('contained').length, 1, 'one event, one line')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a real child alone when the plugin is disabled', async () => {
    const { app, logger } = mountReal()
    const { dir } = makeWorkspace()
    try {
      apply(app, { enabled: false })
      const handle = app.subprocess.spawn(childSpec(dir, 'process.stdout.write("plain")'))
      const delivered = collect(handle.stdout)
      const outcome = await handle.done
      assert.deepEqual(outcome, { exitCode: 0, signal: null })
      assert.equal(delivered(), 'plain')
      assert.equal(handle.stdout.listenerCount('error'), 0, 'nothing was installed, so the post-close window is open')
      assert.equal(logger.matching('contained').length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
