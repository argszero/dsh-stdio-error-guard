/**
 * Contain the stdio `error` events that would otherwise kill the host process.
 *
 * ## The gap
 *
 * A pipe `error` on a child's stdio is an event, not a failure of the parent's
 * state: the child is gone, its exit facts are already the authoritative
 * outcome, and the pipe is a corpse. Node does not know that. An `'error'` event
 * with no listener is **thrown**, from inside the libuv completion that raised
 * it, and the harness answers an uncaught exception with one deliberate policy —
 * one `util.inspect` diagnostic to stderr, release, `exit(1)`
 * (`packages/boot/app-boot/src/index.ts:884`, the diagnostic written at `:896`,
 * `exit(1)` at `:898` and `:917`, both process events registered at `:930-931`).
 *
 * That policy is right for a throw in the middle of an update, which is exactly
 * why it is not the thing to change: *"only the throw site knows which state is
 * intact ... a `'data'` listener that threw mid-update has already dropped a
 * chunk and half-set its own fields, and resuming would turn a visible crash
 * into silently wrong output"*
 * (`.agents/notes/implemented/architecture/2026-09-22-fatal-diagnostics-and-crash-reports.md`).
 * The fix belongs one layer down — a pipe `error` must never be **emitted with
 * no listener attached** — and the tree already says so once, in
 * `packages/experimental/ptc-runtime-python/src/index.ts:2318-2324`:
 *
 * ```ts
 * // Fd-3 and the stdout/stderr pipes emit `error` on early child death
 * // (ECONNRESET/EPIPE); swallow them so they do not become uncaught. The
 * // authoritative failure signal is `child.on('close')` above.
 * ```
 *
 * Discussion #9904 is that event reaching the desktop host: `Error: read
 * ECONNRESET`, raised while a child's stdio completed, escalated to
 * `dsh: fatal uncaught exception`, host exited 1 — the loopback web server and
 * the mobile-relay gateway dead behind an Electron shell that stayed alive. The
 * reporter's own request is the one this implements: *"catch pipe ECONNRESET
 * errors instead of letting them escalate to a fatal uncaught exception"*.
 *
 * ## Why that layer looks covered and is not
 *
 * The provider does attach an `error` listener to a child's piped streams —
 * `observeOutputStream` (`packages/subprocess/subprocess-local/src/spawn.ts:293`)
 * registers `once('end')`, `once('close')` and `once('error')` — but its
 * `settle` removes all three the moment the **first** of them fires
 * (`:296-305`). An ordinary child exit ends the pipe, and from that instant the
 * stream carries no listener at all; a pipe `error` arriving afterwards is
 * thrown out of the libuv completion with nothing to catch it. That window —
 * after the child has closed — is where #9904's stack comes from. (`stdin` is
 * the one stream the layer does guard for good, and only when the caller
 * supplied batch stdin: `spawn.ts:385`.)
 *
 * The listener this plugin attaches is a persistent `on`, so it outlives the
 * provider's `once` and covers the window the provider's own coverage ends at.
 * `test/witness.spec.mjs` measures both halves against the shipped modules: no
 * listener and a throwing emit on a plain run, one listener and an inert emit
 * with this plugin mounted.
 *
 * ## What this plugin does
 *
 * It shadows the subprocess service's `spawn` and `spawnTerminal` — one
 * own-property write on the underlying instance, which is what makes the seam
 * process-wide — and attaches one inert `'error'` listener to each stream the
 * returned handle exposes: `stdin`, `stdout`, `stderr` and `control` on a
 * spawned child, `output` on a terminal. Nothing else changes: no spec, no argv,
 * no environment, no byte, no other listener, and the handle the caller receives
 * is the very object the provider returned.
 *
 * ## What it does not do
 *
 * It does not touch the fatal policy, does not resume a failed operation, and
 * does not restore a host that has already exited — the shell has no respawn
 * (`apps/desktop/src/host-process.ts:187` returns the existing promise whenever a
 * child exists, and `apps/desktop/src/main.ts:447` is the only construction
 * site), so "auto-restart" is a separate, upstream change. It reaches only the
 * streams the provider hands back on the handle; a **collect-mode** child's
 * streams are internal to `bindManagedProcess` and no plugin can see them, and
 * the Electron shell's own pipes — `host-process.ts:203-205`,
 * `command-manager-entry.ts:29`, `login-shell-environment.ts:114-115` — live in a
 * process that mounts no plugins at all. Those are upstream work, named in
 * `README.md` § What this cannot reach.
 *
 * @module @argszero/dsh-stdio-error-guard
 */

import { resolveConfig, type GuardLogLevel, type StdioGuardConfig } from './config.ts'
import { guardHandle, type StreamObservation } from './guard.ts'
import {
  resolveSubprocessInstance, shadowMethod, SPAWN_MARK, TERMINAL_MARK, type ContextLike, type ShadowHandle,
} from './install.ts'

export { DEFAULT_LOG, GUARD_LOG_LEVELS, resolveConfig } from './config.ts'
export type { GuardLogLevel, ResolvedGuardConfig, StdioGuardConfig } from './config.ts'
export { errorCode, guardHandle, GUARD_MARK, GUARDED_SLOTS, isStreamLike } from './guard.ts'
export type { ErrorObserver, GuardReport, GuardedSlot, StreamLike, StreamObservation } from './guard.ts'
export { ORIGINAL, resolveSubprocessInstance, shadowMethod, SPAWN_MARK, TERMINAL_MARK } from './install.ts'
export type { ContextLike, ShadowHandle, ShadowOutcome, SubprocessInstance, SubprocessInstanceSource } from './install.ts'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'stdio-error-guard'

/**
 * The service whose instance carries the seam.
 *
 * Declared so `apply` runs after the subprocess service is mounted: the shadow is
 * written to the instance, and an instance that does not exist yet cannot be
 * shadowed — a plugin that mounted first would guard nothing and say nothing
 * about it.
 */
export const inject = ['subprocess']

/** The prefix of every diagnostic this plugin logs. */
const LOG_PREFIX = 'stdio-error-guard:'

/** The slice of a cordis logger this plugin uses. */
interface LoggerLike {
  warn(message: string): void
  debug(message: string): void
}

/** The slice of the context this plugin registers on. */
interface EffectContext {
  effect(register: () => () => void, label?: string): void
}

/** The slice of a spawn spec this plugin reads. */
interface SpecLike {
  argv?: unknown
}

/** Whether a value is promise-like enough to settle with a handle. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * The executable one spec names, for a log line that identifies the child.
 * @param spec - the spawn spec as the provider received it.
 * @returns the JSON-quoted first argv entry, or `'a child'` when the spec names none.
 */
function describeSpec(spec: unknown): string {
  if (spec === null || typeof spec !== 'object') return 'a child'
  const argv = (spec as SpecLike).argv
  if (!Array.isArray(argv) || argv.length === 0) return 'a child'
  const first: unknown = argv[0]
  return typeof first === 'string' ? JSON.stringify(first) : 'a child'
}

/**
 * Install the guard.
 * @param ctx - the plugin context; the shadow is disposed with it.
 * @param config - the configuration as mounted, possibly empty. Defaults live in
 *   `resolveConfig` rather than in an exported object named `Config`, because the
 *   Loader reads that export as a schema and the plugin would then fail to mount.
 * @throws when the configuration is unusable; the plugin refuses to mount rather
 *   than guarding under rules it cannot honour.
 */
export function apply(
  ctx: ContextLike & { logger: LoggerLike } & EffectContext,
  config: StdioGuardConfig = {},
): void {
  const settings = resolveConfig(config)
  if (!settings.enabled) {
    ctx.logger.debug(`${LOG_PREFIX} disabled by configuration; a stdio "error" on a child of the subprocess service `
      + 'will keep reaching the process-level fatal handler')
    return
  }
  const found = resolveSubprocessInstance(ctx)
  if (found.target === undefined) {
    ctx.logger.warn(`${LOG_PREFIX} the subprocess service is not mounted, so nothing is guarded: `
      + 'a stdio "error" on a child will keep reaching the process-level fatal handler and exit the process')
    return
  }

  const report = (message: string, level: GuardLogLevel = settings.log): void => {
    if (level === 'silent') return
    if (level === 'warn') ctx.logger.warn(message)
    else ctx.logger.debug(message)
  }

  const guard = (spec: unknown, handle: unknown): void => {
    const subject = describeSpec(spec)
    const outcome = guardHandle(handle, (slot, code) => {
      report(`${LOG_PREFIX} contained ${code} on ${slot} of ${subject}: with no "error" listener this event would have `
        + 'reached the process-level handler, which treats an uncaught exception as fatal. '
        + 'The child\'s own outcome is unchanged — its exit facts remain the authoritative signal.')
    })
    if (outcome.guarded.length === 0 && outcome.already.length === 0) {
      // Worth one line: a handle with no pipe-mode stream on it is a spawn this
      // guard could not have covered, not a spawn it covered.
      report(`${LOG_PREFIX} ${subject} exposed no stream to guard `
        + `(absent: ${outcome.absent.join(',') || 'none'}; not stream-shaped: ${outcome.foreign.join(',') || 'none'})`,
      'debug')
    }
    if (handle === null || typeof handle !== 'object') return
    const done = (handle as { done?: unknown }).done
    if (!isThenable(done)) return
    const summarise = (): void => {
      const seen: readonly StreamObservation[] = outcome.observations().filter(entry => entry.errors > 0)
      const errors = seen.reduce((total, entry) => total + entry.errors, 0)
      if (errors === 0) return
      report(`${LOG_PREFIX} ${subject} settled with ${String(errors)} contained stdio error(s) on `
        + `${String(seen.length)} stream(s): ${seen.map(entry => `${entry.slot}=${entry.codes.join('+')}x${String(entry.errors)}`).join(', ')}`,
      'debug')
    }
    // Both arms: a child that failed still ended, and `summarise` may throw if the
    // logger does — the trailing catch keeps that from becoming an unhandled
    // rejection, which this process treats as fatal too.
    void Promise.resolve(done).then(summarise, summarise).catch(() => {})
  }

  const shadows: readonly (readonly [string, ShadowHandle])[] = [
    ['spawn', shadowMethod(found.target, 'spawn', SPAWN_MARK, (spec, handle) => { guard(spec, handle) })],
    ['spawnTerminal', shadowMethod(found.target, 'spawnTerminal', TERMINAL_MARK, (spec, result) => {
      if (!isThenable(result)) return
      // One arm and one catch, covering both jobs: a rejected allocation has no
      // handle and no stream to guard, and an `onFulfilled` that threw would
      // otherwise become an unhandled rejection — the plugin causing the crash
      // it exists to prevent.
      void Promise.resolve(result)
        .then((handle) => { guard(spec, handle) })
        .catch(() => { /* nothing was allocated, or nothing could be observed. */ })
    })],
  ]

  for (const [method, shadow] of shadows) {
    switch (shadow.outcome) {
      case 'patched':
        report(`${LOG_PREFIX} guarding the stdio of every child ${method} returns from `
          + `${found.source === 'instance' ? 'the subprocess instance' : 'the subprocess view'}`
          + `${settings.log === 'silent' ? ' (silently)' : ''}`, 'debug')
        break
      case 'no-method':
        report(`${LOG_PREFIX} the subprocess service carries no ${method} method, so nothing it starts is guarded`, 'debug')
        break
      /* v8 ignore next 4 -- the read-back check makes both write failures one outcome. */
      case 'not-writable':
        report(`${LOG_PREFIX} the subprocess service refuses an own "${method}" property, so this plugin is NOT in force: `
          + 'a stdio "error" on a child will keep exiting the process')
        break
      case 'already-patched':
        report(`${LOG_PREFIX} the subprocess service already carries this plugin's "${method}" shadow, leaving it in place`, 'debug')
        break
    }
  }

  ctx.effect(() => () => {
    for (const [, shadow] of shadows) shadow.restore()
  }, `${LOG_PREFIX}restore()`)
}

export default { name, inject, apply }
