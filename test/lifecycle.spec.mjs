/**
 * The plugin as a mounted unit: what it installs, what it says, and what it
 * unwinds — over a stand-in service, so the assertions are about this plugin's
 * decisions rather than about cordis.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import plugin, { apply, inject, name } from '../lib/index.js'
import { fakeContext, fakeHandle, fakeTerminalHandle, pipeError, FakeRuntime, recordingLogger } from './harness.mjs'

/** A promise with its settle functions kept. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Mount the plugin over a fresh fake service and hand back everything a test needs. */
function mount(config = {}) {
  const instance = new FakeRuntime()
  const { ctx, logger, effects } = fakeContext({ instance })
  apply(ctx, config)
  return { instance, ctx, logger, effects }
}

describe('the loader contract', () => {
  it('exports a default object carrying name, inject and apply', () => {
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(plugin.name, 'stdio-error-guard')
    assert.deepEqual(plugin.inject, ['subprocess'])
  })

  it('declares the same name and inject as named exports', () => {
    assert.equal(name, 'stdio-error-guard')
    assert.deepEqual(inject, ['subprocess'])
  })

  it('reads a configuration object as a value, never as a schema', () => {
    // A `Config` export holding a plain object would make the loader call
    // `.validate` on it and refuse the mount; there is deliberately none.
    assert.equal(plugin.Config, undefined)
  })
})

describe('what a mount installs', () => {
  it('writes both shadows onto the instance and says so once per method', () => {
    const { instance, logger } = mount()
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'spawn'), true)
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'spawnTerminal'), true)
    assert.equal(logger.matching('guarding the stdio of every child spawn returns').length, 1)
    assert.equal(logger.matching('guarding the stdio of every child spawnTerminal returns').length, 1)
  })

  it('leaves a spawn\'s handle the caller\'s own object, with its streams guarded', () => {
    const { instance } = mount()
    const handle = fakeHandle()
    const spec = { argv: ['node', 'child.js'], stdio: { stdout: 'pipe' } }
    instance.handles.set(spec, handle)
    const returned = instance.spawn(spec)
    assert.equal(returned, handle, 'the very object the provider returned')
    assert.equal(handle.stdout.listenerCount('error'), 1)
  })

  it('guards a terminal handle when its allocation settles', async () => {
    const { instance } = mount()
    const terminal = fakeTerminalHandle()
    const spec = { argv: ['bash'] }
    instance.handles.set(spec, terminal)
    assert.equal(terminal.output.listenerCount('error'), 0)
    const returned = await instance.spawnTerminal(spec)
    assert.equal(returned, terminal)
    assert.equal(terminal.output.listenerCount('error'), 1)
  })

  it('contains the event on every stream of a spawned child', () => {
    const { instance, logger } = mount()
    const handle = fakeHandle()
    const spec = { argv: ['node', 'child.js'] }
    instance.handles.set(spec, handle)
    instance.spawn(spec)
    assert.doesNotThrow(() => {
      handle.stdout.emit('error', pipeError('ECONNRESET'))
      handle.stderr.emit('error', pipeError('EPIPE'))
      handle.stdin.emit('error', pipeError())
    })
    assert.equal(logger.matching('contained ECONNRESET on stdout').length, 1)
    assert.equal(logger.matching('contained EPIPE on stderr').length, 1)
  })

  it('names the executable it was told to start, when the spec names one', () => {
    const { instance, logger } = mount()
    const handle = fakeHandle()
    const spec = { argv: ['/usr/bin/node', 'child.js'] }
    instance.handles.set(spec, handle)
    instance.spawn(spec)
    handle.stdout.emit('error', pipeError())
    assert.match(logger.text(), /contained ECONNRESET on stdout of "\/usr\/bin\/node"/)
  })

  it('says "a child" when the spec names no executable', () => {
    const { instance, logger } = mount()
    const handle = fakeHandle()
    const spec = {}
    instance.handles.set(spec, handle)
    instance.spawn(spec)
    handle.stdout.emit('error', pipeError())
    assert.match(logger.text(), /contained ECONNRESET on stdout of a child/)
  })

  it('says "a child" for a spec that is not an object at all', () => {
    const { instance, logger } = mount()
    const handle = fakeHandle()
    instance.handles.set(undefined, handle)
    instance.spawn(undefined)
    handle.stdout.emit('error', pipeError())
    assert.match(logger.text(), /on stdout of a child/)
  })

  it('reports the error line as the whole argument the event would have cost', () => {
    const { instance, logger } = mount()
    const handle = fakeHandle()
    const spec = { argv: ['node'] }
    instance.handles.set(spec, handle)
    instance.spawn(spec)
    handle.stdout.emit('error', pipeError())
    assert.match(logger.text(), /The child's own outcome is unchanged/)
  })
})

describe('what a mount leaves alone', () => {
  it('installs nothing at all when disabled, and says why', () => {
    const instance = new FakeRuntime()
    const { ctx, logger } = fakeContext({ instance })
    apply(ctx, { enabled: false })
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'spawn'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'spawnTerminal'), false)
    assert.match(logger.text(), /disabled by configuration/)
    assert.match(logger.text(), /will keep reaching the process-level fatal handler/)
  })

  it('warns and installs nothing when the subprocess service is not mounted', () => {
    const { ctx, logger } = fakeContext({ instance: undefined })
    assert.doesNotThrow(() => { apply(ctx, {}) })
    assert.match(logger.text(), /the subprocess service is not mounted, so nothing is guarded/)
    assert.equal(logger.lines.filter(line => line.level === 'warn').length, 1)
  })

  it('writes the shadow on the instance, not on the tracking view', () => {
    const instance = new FakeRuntime()
    const { ctx } = fakeContext({ instance })
    apply(ctx, {})
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'spawn'), true)
  })

  it('falls back to the view when the service answers no original symbol, and guards through it', () => {
    const instance = new FakeRuntime()
    const handle = fakeHandle()
    const spec = { argv: ['node'] }
    instance.handles.set(spec, handle)
    // A service whose view is the only object reachable: the resolver returns it
    // as the fallback target, and the shadow lands there.
    const view = { spawn: instance.spawn.bind(instance), spawnTerminal: instance.spawnTerminal.bind(instance) }
    const logger = recordingLogger()
    const ctx = { logger, get: (name) => (name === 'subprocess' ? view : undefined), effect() {} }
    apply(ctx, {})
    assert.equal(Object.prototype.hasOwnProperty.call(view, 'spawn'), true)
    assert.match(logger.text(), /the subprocess view/)
    assert.equal(view.spawn(spec), handle)
    handle.stdout.emit('error', pipeError())
    assert.equal(logger.matching('contained ECONNRESET on stdout').length, 1)
  })

  it('reports an absent method instead of failing the mount', () => {
    class OnlySpawn {
      spawn() { return fakeHandle() }
    }
    const instance = new OnlySpawn()
    const { ctx, logger } = fakeContext({ instance })
    assert.doesNotThrow(() => { apply(ctx, {}) })
    assert.match(logger.text(), /the subprocess service carries no spawnTerminal method/)
  })

  it('warns loudly when the write does not take, because the guard is not in force', () => {
    const instance = Object.freeze(new FakeRuntime())
    const { ctx, logger } = fakeContext({ instance })
    apply(ctx, {})
    assert.equal(logger.lines.filter(line => line.level === 'warn').length, 2)
    assert.match(logger.text(), /this plugin is NOT in force/)
    assert.match(logger.text(), /will keep exiting the process/)
  })

  it('is silent at `log: "silent"`, including for a write that did not take', () => {
    const instance = Object.freeze(new FakeRuntime())
    const { ctx, logger } = fakeContext({ instance })
    apply(ctx, { log: 'silent' })
    assert.deepEqual(logger.lines, [])
  })

  it('reports the containment line at the configured level, and the lifecycle lines at debug', () => {
    const debugMount = mount({ log: 'debug' })
    const debugHandle = fakeHandle()
    const debugSpec = { argv: ['node'] }
    debugMount.instance.handles.set(debugSpec, debugHandle)
    debugMount.instance.spawn(debugSpec)
    debugHandle.stdout.emit('error', pipeError())
    assert.equal(debugMount.logger.matching('contained ECONNRESET')[0].level, 'debug')
    assert.equal(debugMount.logger.matching('guarding the stdio of every child spawn returns')[0].level, 'debug')

    const warnMount = mount({ log: 'warn' })
    const warnHandle = fakeHandle()
    const warnSpec = { argv: ['node'] }
    warnMount.instance.handles.set(warnSpec, warnHandle)
    warnMount.instance.spawn(warnSpec)
    warnHandle.stdout.emit('error', pipeError())
    assert.equal(warnMount.logger.matching('contained ECONNRESET')[0].level, 'warn')
    assert.equal(warnMount.logger.matching('guarding the stdio of every child spawn returns')[0].level, 'debug')
  })

  it('defaults to warn for the containment line', () => {
    const { instance, logger } = mount()
    const handle = fakeHandle()
    const spec = { argv: ['node'] }
    instance.handles.set(spec, handle)
    instance.spawn(spec)
    handle.stdout.emit('error', pipeError())
    assert.equal(logger.matching('contained ECONNRESET')[0].level, 'warn')
  })

  it('refuses to mount on an unusable configuration', () => {
    const instance = new FakeRuntime()
    const { ctx } = fakeContext({ instance })
    assert.throws(() => { apply(ctx, { log: 'verbose' }) }, /"log" must be one of/)
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'spawn'), false)
  })
})

describe('mounting twice', () => {
  it('recognises its own shadow and leaves it in place', () => {
    const instance = new FakeRuntime()
    const { ctx, logger } = fakeContext({ instance })
    apply(ctx, {})
    const shadow = instance.spawn
    apply(ctx, {})
    assert.equal(instance.spawn, shadow, 'the second mount did not wrap the first')
    assert.match(logger.text(), /already carries this plugin's "spawn" shadow, leaving it in place/)
  })

  it('does not double-count an event when the same streams are seen again', () => {
    const instance = new FakeRuntime()
    const { ctx, logger } = fakeContext({ instance })
    const handle = fakeHandle()
    const spec = { argv: ['node'] }
    instance.handles.set(spec, handle)
    apply(ctx, {})
    instance.spawn(spec)
    apply(ctx, {})
    instance.spawn(spec)
    handle.stdout.emit('error', pipeError())
    assert.equal(logger.matching('contained ECONNRESET on stdout').length, 1)
  })
})

describe('disposal', () => {
  it('registers one effect and hands the prototype method back when it is disposed', () => {
    const instance = new FakeRuntime()
    const { ctx, effects } = fakeContext({ instance })
    apply(ctx, {})
    assert.equal(effects.length, 1)
    assert.match(effects[0].label, /stdio-error-guard:restore\(\)/)
    for (const effect of effects) effect.undo()
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'spawn'), false)
    assert.equal(instance.spawn, FakeRuntime.prototype.spawn)
    assert.equal(instance.spawnTerminal, FakeRuntime.prototype.spawnTerminal)
  })

  it('is idempotent: disposing twice leaves the prototype method alone', () => {
    const instance = new FakeRuntime()
    const { ctx, effects } = fakeContext({ instance })
    apply(ctx, {})
    effects[0].undo()
    const restored = instance.spawn
    assert.doesNotThrow(() => { effects[0].undo() })
    assert.equal(instance.spawn, restored)
  })

  it('does not register an effect when it installed nothing', () => {
    const { ctx, effects } = fakeContext({ instance: undefined })
    apply(ctx, {})
    assert.deepEqual(effects, [])
  })
})

describe('the settlement summary', () => {
  it('reports the tally once the child\'s `done` settles', async () => {
    const { instance, logger } = mount({ log: 'debug' })
    const done = deferred()
    const handle = fakeHandle({ done: done.promise })
    const spec = { argv: ['node'] }
    instance.handles.set(spec, handle)
    instance.spawn(spec)
    handle.stdout.emit('error', pipeError('ECONNRESET'))
    handle.stdout.emit('error', pipeError('ECONNRESET'))
    handle.stderr.emit('error', pipeError('EPIPE'))
    done.resolve({ exitCode: 1 })
    await done.promise
    await new Promise(resolve => { setImmediate(resolve) })
    assert.equal(logger.matching('settled with 3 contained stdio error(s) on 2 stream(s)').length, 1)
    assert.match(logger.text(), /stdout=ECONNRESETx2/)
    assert.match(logger.text(), /stderr=EPIPEx1/)
  })

  it('says nothing when the child settled with no error at all', async () => {
    const { instance, logger } = mount({ log: 'debug' })
    const done = deferred()
    const handle = fakeHandle({ done: done.promise })
    const spec = { argv: ['node'] }
    instance.handles.set(spec, handle)
    instance.spawn(spec)
    done.resolve({ exitCode: 0 })
    await done.promise
    await new Promise(resolve => { setImmediate(resolve) })
    assert.equal(logger.matching('settled with').length, 0)
  })

  it('counts nothing but still settles when the child failed for its own reasons', async () => {
    const { instance, logger } = mount({ log: 'debug' })
    const done = deferred()
    const handle = fakeHandle({ done: done.promise })
    const spec = { argv: ['node'] }
    instance.handles.set(spec, handle)
    instance.spawn(spec)
    done.reject(new Error('the child could not start'))
    await done.promise.catch(() => {})
    await new Promise(resolve => { setImmediate(resolve) })
    assert.equal(logger.matching('settled with').length, 0)
  })

  it('does not turn a log sink that throws on the summary into an unhandled rejection', async () => {
    const instance = new FakeRuntime()
    const lines = []
    const logger = {
      warn: (message) => { lines.push(message) },
      debug: (message) => {
        if (message.includes('settled with')) throw new Error('the log sink is broken')
        lines.push(message)
      },
    }
    const { ctx } = fakeContext({ instance, logger })
    apply(ctx, { log: 'debug' })
    const rejections = []
    const onRejection = (reason) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      const done = deferred()
      const handle = fakeHandle({ done: done.promise })
      const spec = { argv: ['node'] }
      instance.handles.set(spec, handle)
      instance.spawn(spec)
      handle.stdout.emit('error', pipeError())
      done.resolve({ exitCode: 1 })
      await done.promise
      await new Promise(resolve => { setImmediate(resolve) })
      assert.deepEqual(rejections, [])
      assert.equal(lines.filter(line => line.includes('settled with')).length, 0)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('does not throw when the handle carries no `done` at all', () => {
    const { instance } = mount({ log: 'debug' })
    const spec = { argv: ['node'] }
    instance.handles.set(spec, { stdout: fakeHandle().stdout })
    assert.doesNotThrow(() => { instance.spawn(spec) })
  })
})

describe('handles the guard could not cover', () => {
  it('says so when a handle exposes no stream to guard', () => {
    const { instance, logger } = mount({ log: 'debug' })
    const spec = { argv: ['node'] }
    instance.handles.set(spec, { collected: {}, done: new Promise(() => {}) })
    instance.spawn(spec)
    assert.match(logger.text(), /exposed no stream to guard/)
    assert.match(logger.text(), /absent: stdin,stdout,stderr,control/)
  })

  it('names the foreign slots when a handle carries values that are not streams', () => {
    const { instance, logger } = mount({ log: 'debug' })
    const spec = { argv: ['node'] }
    instance.handles.set(spec, { stdin: {}, stdout: 'text', done: new Promise(() => {}) })
    instance.spawn(spec)
    assert.match(logger.text(), /not stream-shaped: stdin,stdout/)
  })

  it('says nothing about a handle it covered, when the mount is at debug level', () => {
    const { instance, logger } = mount({ log: 'debug' })
    const spec = { argv: ['node'] }
    instance.handles.set(spec, fakeHandle())
    instance.spawn(spec)
    assert.equal(logger.matching('exposed no stream to guard').length, 0)
  })
})

describe('an allocation that fails', () => {
  it('turns a rejected terminal allocation into silence rather than an unhandled rejection', async () => {
    const instance = new FakeRuntime()
    const { ctx } = fakeContext({ instance })
    apply(ctx, {})
    const rejections = []
    const onRejection = (reason) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      const spec = { argv: ['bash'] }
      instance.handles.set(spec, Promise.reject(new Error('no tty')))
      assert.doesNotThrow(() => { instance.spawnTerminal(spec) })
      await new Promise(resolve => { setImmediate(resolve) })
      assert.deepEqual(rejections, [])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('does not observe a result that is not thenable', () => {
    class SyncTerminal {
      spawnTerminal() { return 'not a promise' }
    }
    const instance = new SyncTerminal()
    const { ctx, logger } = fakeContext({ instance })
    assert.doesNotThrow(() => { apply(ctx, {}) })
    assert.doesNotThrow(() => { instance.spawnTerminal() })
    assert.equal(logger.matching('exposed no stream to guard').length, 0)
  })
})
