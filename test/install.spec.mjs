/**
 * The seam: writing one own-property shadow onto the subprocess instance.
 *
 * What makes this a process-wide seam rather than a per-caller patch is that
 * both shadowed methods are prototype methods, so one own-property write covers
 * every caller — the provider's own call-time lookup included. The tests below
 * hold that, and hold the failure cases as firmly: a service the plugin cannot
 * write to must be reported, never half-installed.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ORIGINAL, resolveSubprocessInstance, shadowMethod, SPAWN_MARK } from '../lib/install.js'

/** A stand-in for the service: both methods on the prototype, as the real one has them. */
class FakeRuntime {
  constructor() {
    this.calls = []
    this.terminalCalls = []
  }

  spawn(spec) {
    this.calls.push(spec)
    return { handleFor: spec.argv }
  }

  spawnTerminal(spec) {
    this.terminalCalls.push(spec)
    return Promise.resolve({ terminalFor: spec.argv })
  }
}

describe('resolveSubprocessInstance', () => {
  it('prefers the underlying instance behind the tracking view', () => {
    const instance = new FakeRuntime()
    const ctx = { get: (name) => (name === 'subprocess' ? { [ORIGINAL]: instance } : undefined) }
    const found = resolveSubprocessInstance(ctx)
    assert.equal(found.source, 'instance')
    assert.equal(found.target, instance)
  })

  it('falls back to the view when it carries no original symbol', () => {
    const view = { spawn() {} }
    const ctx = { get: (name) => (name === 'subprocess' ? view : undefined) }
    const found = resolveSubprocessInstance(ctx)
    assert.equal(found.source, 'view')
    assert.equal(found.target, view)
  })

  it('reads the service by property when the context has no `get`', () => {
    const instance = new FakeRuntime()
    const found = resolveSubprocessInstance({ subprocess: instance })
    assert.equal(found.source, 'view', 'a bare property read is not a tracking view, so it is the fallback target')
    assert.equal(found.target, instance)
  })

  it('reads the instance by property when the symbol is there', () => {
    const instance = new FakeRuntime()
    assert.equal(resolveSubprocessInstance({ subprocess: { [ORIGINAL]: instance } }).target, instance)
  })

  it('reports none for every shape that is not a mounted service', () => {
    assert.equal(resolveSubprocessInstance({ get: () => undefined }).source, 'none')
    assert.equal(resolveSubprocessInstance({ get: () => null }).source, 'none')
    assert.equal(resolveSubprocessInstance({ get: () => 'a string' }).source, 'none')
    assert.equal(resolveSubprocessInstance({}).source, 'none')
  })
})

describe('shadowMethod', () => {
  it('shadows a prototype method with an own property, so every instance caller is covered', () => {
    const instance = new FakeRuntime()
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'spawn'), false)
    const seen = []
    const shadow = shadowMethod(instance, 'spawn', SPAWN_MARK, (spec, handle) => { seen.push([spec, handle]) })
    assert.equal(shadow.outcome, 'patched')
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'spawn'), true)

    const spec = { argv: ['node', 'x'] }
    const handle = instance.spawn(spec)
    assert.deepEqual(instance.calls, [spec], 'the original ran')
    assert.deepEqual(handle, { handleFor: spec.argv }, 'the caller gets the original handle, un-wrapped')
    assert.deepEqual(seen, [[spec, handle]])
    shadow.restore()
  })

  it('reveals the prototype method again on restore, rather than freezing it as an own property', () => {
    const instance = new FakeRuntime()
    const shadow = shadowMethod(instance, 'spawn', SPAWN_MARK, () => {})
    shadow.restore()
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'spawn'), false)
    assert.equal(typeof instance.spawn, 'function')
    assert.equal(instance.calls.length, 0)
  })

  it('restores an own property by writing the old value back', () => {
    const original = () => 'own'
    const target = { spawn: original }
    const shadow = shadowMethod(target, 'spawn', SPAWN_MARK, () => {})
    assert.equal(shadow.outcome, 'patched')
    shadow.restore()
    assert.equal(target.spawn, original)
  })

  it('takes the receiver from the call, so a borrowed method still works', () => {
    const first = new FakeRuntime()
    const second = new FakeRuntime()
    shadowMethod(first, 'spawn', SPAWN_MARK, () => {})
    first.spawn.call(second, { argv: [] })
    assert.equal(second.calls.length, 1)
    assert.equal(first.calls.length, 0)
  })

  it('falls back to the shadowed object when the call arrives without a receiver', () => {
    const target = { spawn: function () { return this }, flag: 'target' }
    let observed
    shadowMethod(target, 'spawn', SPAWN_MARK, (_spec, handle) => { observed = handle })
    const detached = target.spawn
    assert.equal(detached(), target, 'the receiver falls back to the shadowed object')
    assert.equal(observed, target)
  })

  it('swallows an observer failure, because a missing diagnostic is not a failed spawn', () => {
    const instance = new FakeRuntime()
    shadowMethod(instance, 'spawn', SPAWN_MARK, () => { throw new Error('the observer is broken') })
    assert.deepEqual(instance.spawn({ argv: ['x'] }), { handleFor: ['x'] })
  })

  it('returns the promise the original returned, for an allocation that is async', () => {
    const instance = new FakeRuntime()
    const seen = []
    shadowMethod(instance, 'spawnTerminal', SPAWN_MARK, (spec, result) => { seen.push([spec, result]) })
    const spec = { argv: ['shell'] }
    const returned = instance.spawnTerminal(spec)
    assert.equal(typeof returned.then, 'function')
    assert.deepEqual(seen, [[spec, returned]], 'the observer sees the very promise the caller got')
  })

  it('reports no-method rather than installing a wrapper over nothing', () => {
    const target = {}
    const shadow = shadowMethod(target, 'spawn', SPAWN_MARK, () => {})
    assert.equal(shadow.outcome, 'no-method')
    assert.equal('spawn' in target, false)
    assert.doesNotThrow(() => { shadow.restore() })
  })

  it('reports no-method when the property exists and is not callable', () => {
    const target = { spawn: 'not a function' }
    assert.equal(shadowMethod(target, 'spawn', SPAWN_MARK, () => {}).outcome, 'no-method')
    assert.equal(target.spawn, 'not a function')
  })

  it('recognises its own shadow, and one installed by another copy of this plugin', () => {
    const instance = new FakeRuntime()
    assert.equal(shadowMethod(instance, 'spawn', SPAWN_MARK, () => {}).outcome, 'patched')
    assert.equal(shadowMethod(instance, 'spawn', SPAWN_MARK, () => {}).outcome, 'already-patched')

    const other = new FakeRuntime()
    other.spawn = Object.defineProperty(function () {}, SPAWN_MARK, { value: true })
    assert.equal(shadowMethod(other, 'spawn', SPAWN_MARK, () => {}).outcome, 'already-patched')
  })

  it('does not mistake another plugin\'s shadow for its own', () => {
    const instance = new FakeRuntime()
    instance.spawn = Object.defineProperty(function () {}, Symbol.for('someone.else/shadow'), { value: true })
    assert.equal(shadowMethod(instance, 'spawn', SPAWN_MARK, () => {}).outcome, 'patched')
  })

  it('reports not-writable on a sealed object and leaves the original callable', () => {
    const instance = Object.freeze(new FakeRuntime())
    const shadow = shadowMethod(instance, 'spawn', SPAWN_MARK, () => {})
    assert.equal(shadow.outcome, 'not-writable')
    assert.deepEqual(instance.spawn({ argv: ['x'] }), { handleFor: ['x'] })
    assert.doesNotThrow(() => { shadow.restore() })
  })

  it('reports not-writable when the write is accepted and ignored, which only a read-back sees', () => {
    const original = () => 'original'
    const target = new Proxy(
      { spawn: original },
      // Reports success for the write and stores nothing, so nothing throws and
      // the `try` returns normally — the read-back is the only witness.
      { set: (object, key, value) => (key === 'spawn' ? true : Reflect.set(object, key, value)) },
    )
    const shadow = shadowMethod(target, 'spawn', SPAWN_MARK, () => {})
    assert.equal(shadow.outcome, 'not-writable')
    assert.equal(target.spawn, original, 'the original method is still the one in place')
    assert.doesNotThrow(() => { shadow.restore() })
  })

  it('is idempotent on restore', () => {
    const instance = new FakeRuntime()
    const shadow = shadowMethod(instance, 'spawn', SPAWN_MARK, () => {})
    const afterFirst = instance.spawn
    shadow.restore()
    shadow.restore()
    assert.notEqual(instance.spawn, afterFirst)
    assert.equal(typeof instance.spawn, 'function')
  })

  it('leaves a shadow someone else installed later alone when unwound', () => {
    const instance = new FakeRuntime()
    const shadow = shadowMethod(instance, 'spawn', SPAWN_MARK, () => {})
    const thirdParty = () => 'third party'
    instance.spawn = thirdParty
    shadow.restore()
    assert.equal(instance.spawn, thirdParty)
  })
})
