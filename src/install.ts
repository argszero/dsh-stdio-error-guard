/**
 * The instance seam: shadow the subprocess service's `spawn` and `spawnTerminal`.
 *
 * There is no event on the spawn path and no hook in the provider that would hand
 * a plugin a child's streams. Their creation is internal to the provider:
 * `bindManagedProcess` receives them as `launch.stdout`/`launch.stderr`
 * (`packages/subprocess/subprocess-local/src/spawn.ts:273`), and the handle
 * exposes them only when the caller asked for the matching `'pipe'` mode
 * (`packages/subprocess/subprocess/src/types.ts:169-177`).
 *
 * What the plugin does have is the service instance itself.
 * `ctx.get('subprocess')` returns a tracking proxy; the proxy answers
 * `Symbol.for('cordis.original')` with the underlying object
 * (`vendor/cordis/src/utils.ts`), and both methods are **prototype** methods of
 * `SubprocessRuntime` (`packages/subprocess/subprocess/src/index.ts:117`, `:153`,
 * `:162`), so one own-property write on that object shadows them for every
 * caller — the provider's own `this.ctx.subprocess.spawn(spec)`, any other
 * provider, and any third-party plugin. The shadow is what makes this seam
 * process-wide rather than one call site wide.
 *
 * @module @argszero/dsh-stdio-error-guard/install
 */

/** Brand carried by an installed `spawn` shadow, so a second mount recognises the first. */
export const SPAWN_MARK = Symbol.for('argszero.dsh-stdio-error-guard/spawn-shadowed')

/** Brand carried by an installed `spawnTerminal` shadow. */
export const TERMINAL_MARK = Symbol.for('argszero.dsh-stdio-error-guard/spawn-terminal-shadowed')

/** The cordis symbol that exposes a service view's underlying instance. */
export const ORIGINAL = Symbol.for('cordis.original')

/** The narrowest shape the shadow needs from a caller's context. */
export interface ContextLike {
  /** The service lookup every cordis context offers. */
  get?: (name: string) => unknown
  /** The property-read spelling of the same lookup. */
  subprocess?: unknown
}

/** Which object the shadow was written to. */
export type SubprocessInstanceSource = 'instance' | 'view' | 'none'

/** Where the subprocess service was found, and what was found. */
export interface SubprocessInstance {
  /** The object to write the shadow on; absent when the service is not mounted. */
  readonly target: object | undefined
  /** `instance` is the underlying object, `view` a tracking proxy, `none` nothing at all. */
  readonly source: SubprocessInstanceSource
}

/**
 * Resolve the object a shadow must be written to.
 *
 * The underlying instance is preferred: cordis returns a fresh tracking proxy
 * from every `get`, and a proxy is not a stable place to hang state. The proxy
 * is used as a fallback so a service that does not carry the symbol still gets a
 * working — if narrower — shadow.
 * @param ctx - the plugin context.
 * @returns the target and where it came from.
 */
export function resolveSubprocessInstance(ctx: ContextLike): SubprocessInstance {
  const view = typeof ctx.get === 'function' ? ctx.get('subprocess') : ctx.subprocess
  if (view === null || typeof view !== 'object') return { target: undefined, source: 'none' }
  const original = (view as Record<symbol, unknown>)[ORIGINAL]
  if (original !== null && typeof original === 'object') {
    return { target: original as object, source: 'instance' }
  }
  return { target: view as object, source: 'view' }
}

/** What {@link shadowMethod} did. */
export type ShadowOutcome =
  /** The shadow is installed and confirmed by a read-back. */
  | 'patched'
  /** The object does not carry that method. */
  | 'no-method'
  /** The write threw, or a read-back shows it did not take. */
  | 'not-writable'
  /** This object already carries a shadow installed by this plugin. */
  | 'already-patched'

/** An installed shadow and how to unwind it. */
export interface ShadowHandle {
  /** What happened. */
  readonly outcome: ShadowOutcome
  /** Unwind the shadow. Idempotent, and a no-op unless this handle installed it. */
  readonly restore: () => void
}

const NOOP_RESTORE = (): void => { /* nothing was installed, so there is nothing to unwind. */ }

/**
 * Shadow one object's method with a wrapper that reports every result.
 *
 * The callback is invoked after the original returned and its failure is
 * swallowed: an observation that could not be made is a diagnostic that is
 * missing, never a spawn that fails. The wrapper's return value is the
 * original's, unchanged and un-wrapped, so the caller's handle is the caller's
 * own object — which matters more here than anywhere, because the guard's whole
 * promise is that nothing about the caller's handle changes.
 * @param target - the object carrying the method (the service instance, or its view).
 * @param method - the method name to shadow.
 * @param mark - the brand that recognises this plugin's own shadow.
 * @param observe - called with the first argument and the returned value.
 * @returns the outcome and an undo.
 */
export function shadowMethod(
  target: object,
  method: string,
  mark: symbol,
  observe: (spec: unknown, result: unknown) => void,
): ShadowHandle {
  const mutable = target as Record<string, unknown>
  const current = mutable[method]
  if (typeof current !== 'function') return { outcome: 'no-method', restore: NOOP_RESTORE }
  if ((current as unknown as Record<symbol, unknown>)[mark] === true) {
    return { outcome: 'already-patched', restore: NOOP_RESTORE }
  }
  const original = current as (...args: unknown[]) => unknown
  // Whether the property was the object's own before the shadow: a prototype
  // method must be revealed again by deleting the shadow, an own property by
  // writing the old value back.
  const hadOwn = Object.prototype.hasOwnProperty.call(target, method)
  const wrapper = function shadowedMethod(this: unknown, ...args: unknown[]): unknown {
    const result = Reflect.apply(original, this === undefined ? target : this, args)
    try {
      observe(args[0], result)
    } catch {
      // The observation is auxiliary; the call it observed is not.
    }
    return result
  }
  Object.defineProperty(wrapper, mark, { value: true, enumerable: false })

  try {
    mutable[method] = wrapper
  } catch {
    return { outcome: 'not-writable', restore: NOOP_RESTORE }
  }
  if (mutable[method] !== wrapper) {
    // A write that reports success and stores nothing: a proxy's `set` trap can
    // answer `true` and keep the old value, and this module is strict, so nothing
    // throws and only this read-back notices.
    return { outcome: 'not-writable', restore: NOOP_RESTORE }
  }

  let installed = true
  return {
    outcome: 'patched',
    restore: () => {
      if (!installed) return
      installed = false
      if (mutable[method] !== wrapper) return
      if (hadOwn) mutable[method] = original
      else delete mutable[method]
    },
  }
}
