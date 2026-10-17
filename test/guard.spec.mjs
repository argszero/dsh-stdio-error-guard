/**
 * The containment itself: one inert `'error'` listener per stream the handle
 * exposes.
 *
 * The load-bearing assertion is the first one in the file — a real Node stream
 * that emits `'error'` with no listener **throws**, and the same emit with this
 * plugin's listener attached does not. Everything else here holds the promises
 * that make the containment acceptable: no byte consumed, no listener replaced,
 * the handle un-wrapped, and a stream this plugin cannot guard reported rather
 * than raised.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { errorCode, GUARDED_SLOTS, GUARD_MARK, guardHandle, isStreamLike } from '../lib/guard.js'
import { fakeHandle, fakeTerminalHandle, pipeError } from './harness.mjs'

/** The bare minimum the plugin accepts as a stream. */
class FakeStream extends EventEmitter {}

describe('the event this plugin exists for', () => {
  it('throws with no listener and does not throw with the one guardHandle attaches', () => {
    const bare = new PassThrough()
    bare.on('error', () => {})
    assert.throws(() => { new PassThrough().emit('error', pipeError()) }, /read ECONNRESET/)

    const handle = fakeHandle()
    guardHandle(handle)
    assert.doesNotThrow(() => { handle.stdout.emit('error', pipeError()) })
  })

  it('counts every event, including repeats of one code, and reports each code once', () => {
    const handle = fakeHandle()
    const seen = []
    const report = guardHandle(handle, (slot, code) => { seen.push([slot, code]) })
    handle.stdout.emit('error', pipeError('ECONNRESET'))
    handle.stdout.emit('error', pipeError('ECONNRESET'))
    handle.stdout.emit('error', pipeError('EPIPE'))
    assert.deepEqual(seen, [['stdout', 'ECONNRESET'], ['stdout', 'EPIPE']])
    const observations = report.observations()
    const stdout = observations.find(entry => entry.slot === 'stdout')
    assert.equal(stdout.errors, 3)
    assert.deepEqual(stdout.codes, ['ECONNRESET', 'EPIPE'])
  })

  it('survives an observer that throws, because the containment is the promise', () => {
    const handle = fakeHandle()
    guardHandle(handle, () => { throw new Error('the observer is broken') })
    assert.doesNotThrow(() => { handle.stdout.emit('error', pipeError()) })
  })

  it('reads back as zero before anything was emitted', () => {
    const report = guardHandle(fakeHandle())
    assert.deepEqual(report.observations().map(entry => entry.errors), [0, 0, 0, 0])
  })

  it('defaults to a silent observer', () => {
    const handle = fakeHandle()
    assert.doesNotThrow(() => {
      guardHandle(handle)
      handle.stdout.emit('error', pipeError())
    })
  })
})

describe('which slots are guarded', () => {
  it('guards the four child slots and the terminal slot, in the declared order', () => {
    const handle = fakeHandle()
    const report = guardHandle(handle)
    assert.deepEqual(report.guarded, ['stdin', 'stdout', 'stderr', 'control'])
    assert.deepEqual(GUARDED_SLOTS, ['stdin', 'stdout', 'stderr', 'control', 'output'])

    const terminal = fakeTerminalHandle()
    assert.deepEqual(guardHandle(terminal).guarded, ['output'])
    assert.deepEqual(guardHandle(terminal).absent, ['stdin', 'stdout', 'stderr', 'control'])
  })

  it('reports an absent slot as absent rather than as foreign', () => {
    // `output` is a terminal slot: a child handle does not carry it, so it is
    // absent here too, and that is the honest reading rather than a gap.
    const report = guardHandle(fakeHandle({ omit: ['stdin', 'control'] }))
    assert.deepEqual(report.absent, ['stdin', 'control', 'output'])
    assert.deepEqual(report.guarded, ['stdout', 'stderr'])
  })

  it('reports a non-stream value as foreign, and guards the rest', () => {
    const report = guardHandle(fakeHandle({ replace: { stdin: { notAStream: true }, control: 'text' } }))
    assert.deepEqual(report.foreign, ['stdin', 'control'])
    assert.deepEqual(report.guarded, ['stdout', 'stderr'])
  })

  it('reports a slot whose `on` refuses the registration as foreign rather than throwing', () => {
    const refusing = { on() { throw new Error('read-only stream') } }
    const report = guardHandle(fakeHandle({ replace: { stdout: refusing } }))
    assert.deepEqual(report.foreign, ['stdout'])
    assert.deepEqual(report.guarded, ['stdin', 'stderr', 'control'])
  })

  it('is total: no shape of handle makes it throw', () => {
    for (const value of [undefined, null, 42, 'text', true, () => {}]) {
      assert.doesNotThrow(() => { guardHandle(value) })
    }
    assert.deepEqual(guardHandle({}).guarded, [])
    assert.deepEqual(guardHandle({}).absent, GUARDED_SLOTS)
    assert.deepEqual(guardHandle(() => {}).guarded, [])
  })

  it('treats `null` as absent, the way a provider leaves an unused slot', () => {
    assert.deepEqual(guardHandle(fakeHandle({ replace: { stdin: null } })).absent, ['stdin', 'output'])
  })
})

describe('installing twice', () => {
  it('recognises its own listener and leaves the slot alone rather than double-counting', () => {
    const handle = fakeHandle()
    const seen = []
    const first = guardHandle(handle, (slot, code) => { seen.push(['first', slot, code]) })
    assert.deepEqual(first.guarded, ['stdin', 'stdout', 'stderr', 'control'])
    const second = guardHandle(handle, (slot, code) => { seen.push(['second', slot, code]) })
    assert.deepEqual(second.guarded, [])
    assert.deepEqual(second.already, ['stdin', 'stdout', 'stderr', 'control'])
    handle.stdout.emit('error', pipeError())
    handle.stdout.emit('error', pipeError())
    assert.deepEqual(seen, [['first', 'stdout', 'ECONNRESET']], 'one event, one report, however many mounts')
  })

  it('marks each guarded stream so a later mount can see it', () => {
    const handle = fakeHandle()
    guardHandle(handle)
    assert.equal(handle.stdout[GUARD_MARK].slot, 'stdout')
  })

  it('still contains the event when the mark cannot be written, and re-reports on a second mount', () => {
    const stream = new PassThrough()
    // A stream that accepts the listener but refuses a symbol property: the
    // containment — which is the promise — is unaffected, and only the
    // de-duplication is lost, which this test pins rather than hides.
    const blocked = new Proxy(stream, {
      defineProperty(target, prop, descriptor) {
        if (typeof prop === 'symbol') throw new TypeError('a stream that refuses a symbol')
        return Reflect.defineProperty(target, prop, descriptor)
      },
      get(target, prop) {
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const seen = []
    const first = guardHandle({ stdout: blocked }, (slot, code) => { seen.push(['first', slot, code]) })
    assert.deepEqual(first.guarded, ['stdout'])
    assert.deepEqual(first.foreign, [])
    assert.doesNotThrow(() => { blocked.emit('error', pipeError('ECONNRESET')) })
    assert.deepEqual(seen, [['first', 'stdout', 'ECONNRESET']])

    const second = guardHandle({ stdout: blocked }, (slot, code) => { seen.push(['second', slot, code]) })
    assert.deepEqual(second.guarded, ['stdout'], 'the mark is gone, so the second mount attaches its own listener')
    blocked.emit('error', pipeError('EPIPE'))
    assert.deepEqual(seen, [
      ['first', 'stdout', 'ECONNRESET'],
      ['first', 'stdout', 'EPIPE'],
      ['second', 'stdout', 'EPIPE'],
    ])
  })
})

describe('nothing else about the stream changes', () => {
  it('does not consume a byte, does not pause, and leaves the other listeners running', () => {
    const handle = fakeHandle()
    const received = []
    handle.stdout.on('data', chunk => { received.push(chunk.toString()) })
    handle.stdout.write('the provider\'s own bytes')
    guardHandle(handle)
    handle.stdout.write(' and one more')
    handle.stdout.end()
    assert.equal(received.join(''), 'the provider\'s own bytes and one more')
  })

  it('leaves a listener that was already there in place, and runs both', () => {
    const stream = new PassThrough()
    const theirs = []
    stream.on('error', error => { theirs.push(error.code) })
    assert.deepEqual(guardHandle({ stdout: stream }).guarded, ['stdout'])
    stream.emit('error', pipeError('EPIPE'))
    assert.deepEqual(theirs, ['EPIPE'])
  })

  it('does not destroy the stream or resume a paused one', () => {
    const stream = new PassThrough()
    const seen = []
    stream.on('data', chunk => { seen.push(chunk.toString()) })
    stream.pause()
    guardHandle({ stdout: stream })
    assert.equal(stream.destroyed, false)
    assert.equal(stream.isPaused(), true)
    assert.equal(seen.length, 0)
  })

  it('returns nothing but a report: the handle object is the caller\'s own', () => {
    const handle = fakeHandle()
    const report = guardHandle(handle)
    assert.equal(handle.stdout.listenerCount('error'), 1)
    assert.equal(typeof report.observations, 'function')
  })
})

describe('isStreamLike and errorCode', () => {
  it('accepts anything with a callable `on`, and only that', () => {
    assert.equal(isStreamLike(new PassThrough()), true)
    assert.equal(isStreamLike(new FakeStream()), true)
    assert.equal(isStreamLike({ on() {} }), true)
    assert.equal(isStreamLike(() => {}), false)
    assert.equal(isStreamLike({}), false)
    assert.equal(isStreamLike({ on: 'not a function' }), false)
    assert.equal(isStreamLike(null), false)
    assert.equal(isStreamLike(undefined), false)
    assert.equal(isStreamLike('text'), false)
  })

  it('reads a string code, and says `unknown` for everything else', () => {
    assert.equal(errorCode(pipeError('ECONNRESET')), 'ECONNRESET')
    assert.equal(errorCode({ code: 'EPIPE' }), 'EPIPE')
    assert.equal(errorCode(new Error('no code')), 'unknown')
    assert.equal(errorCode({ code: '' }), 'unknown')
    assert.equal(errorCode({ code: 42 }), 'unknown')
    assert.equal(errorCode(null), 'unknown')
    assert.equal(errorCode('text'), 'unknown')
  })
})
