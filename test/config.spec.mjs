/**
 * The configuration, validated where it is read.
 *
 * The plugin refuses to mount on an unusable configuration rather than guarding
 * under rules it cannot honour: a misspelled `log` that mounts and stays quiet
 * is how an operator comes to believe the guard is not firing.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_LOG, GUARD_LOG_LEVELS, resolveConfig } from '../lib/config.js'

describe('resolveConfig', () => {
  it('applies the documented defaults to an empty configuration', () => {
    assert.deepEqual(resolveConfig(), { enabled: true, log: DEFAULT_LOG })
    assert.equal(DEFAULT_LOG, 'warn')
  })

  it('accepts every declared level', () => {
    for (const level of GUARD_LOG_LEVELS) {
      assert.equal(resolveConfig({ log: level }).log, level)
    }
  })

  it('carries `enabled: false` through, which is what installs nothing', () => {
    assert.deepEqual(resolveConfig({ enabled: false }), { enabled: false, log: 'warn' })
  })

  it('takes an explicit `log: "debug"` and leaves `enabled` at its default', () => {
    assert.deepEqual(resolveConfig({ log: 'debug' }), { enabled: true, log: 'debug' })
  })

  it('refuses an unknown key instead of ignoring it', () => {
    assert.throws(() => { resolveConfig({ logs: 'debug' }) }, /unknown configuration key "logs"/)
  })

  it('refuses a non-object in every shape that could reach it', () => {
    assert.throws(() => { resolveConfig(null) }, /must be an object/)
    assert.throws(() => { resolveConfig('debug') }, /must be an object/)
    assert.throws(() => { resolveConfig(['debug']) }, /must be an object/)
  })

  it('refuses a non-boolean `enabled`', () => {
    assert.throws(() => { resolveConfig({ enabled: 'yes' }) }, /"enabled" must be a boolean/)
  })

  it('refuses an unknown level and names the ones it accepts', () => {
    assert.throws(() => { resolveConfig({ log: 'verbose' }) }, /"log" must be one of silent, debug, warn/)
  })

  it('names the offending value in the message', () => {
    assert.throws(() => { resolveConfig({ log: 'verbose' }) }, /got "verbose"/)
  })
})
