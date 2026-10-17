/**
 * Contain a stdio `error` event that would otherwise reach the process-level handler.
 *
 * ## The event, and why it is fatal
 *
 * A Node stream that emits `'error'` with no listener throws. That throw happens
 * inside whatever callback was running — for a child process's stdio that is the
 * libuv completion, whose stack passes through `ChildProcess._handle.onexit` —
 * and the harness handles an uncaught exception by one deliberate policy:
 * `installFailLoud` writes one `util.inspect` diagnostic and exits 1
 * (`packages/boot/app-boot/src/index.ts:884`, registered at `:931`), because
 * *"only the throw site knows which state is intact"*
 * (`.agents/notes/implemented/architecture/2026-09-22-fatal-diagnostics-and-crash-reports.md`).
 *
 * The policy is right and this plugin does not touch it. What is wrong is that a
 * **pipe** `error` reaches it at all: a broken pipe on a child that has already
 * exited says nothing about the parent's own state, and the child's exit facts
 * are the authoritative outcome either way. The tree already contains the
 * pattern that treats it that way, in
 * `packages/experimental/ptc-runtime-python/src/index.ts:2318-2324` — three
 * lines that state the contract outright: an inert `error` handler on fd-3,
 * stdout and stderr, and a comment saying why:
 *
 * ```ts
 * // Fd-3 and the stdout/stderr pipes emit `error` on early child death
 * // (ECONNRESET/EPIPE); swallow them so they do not become uncaught. The
 * // authoritative failure signal is `child.on('close')` above.
 * ```
 *
 * The harness's own subprocess layer looks like it does the same and does not:
 * `observeOutputStream` (`packages/subprocess/subprocess-local/src/spawn.ts:293`)
 * attaches `once('end'|'close'|'error')` and removes all three as soon as the
 * first fires (`:296-305`), so the stream a child leaves behind is unlistened —
 * which is where #9904's `read ECONNRESET` comes from. What makes the window
 * survivable is that this module attaches a persistent `on`, not a `once`.
 *
 * ## What this module does
 *
 * It attaches one inert `'error'` listener to each stream a subprocess handle
 * exposes — `stdin`, `stdout`, `stderr`, `control` on a spawned child, `output`
 * on a terminal handle. Nothing else changes: the listener consumes no byte, does
 * not prevent any other listener from running (an `EventEmitter` calls all of
 * them), does not destroy or resume the stream, and the handle object the caller
 * receives is the very object the provider returned, un-wrapped.
 *
 * The `'error'` event that used to escalate still happens; it is simply
 * observed. Every occurrence is counted, and the first of each distinct
 * `error.code` per stream is reported, so an operator learns a pipe broke
 * without a chatty child filling the log.
 *
 * @module @argszero/dsh-stdio-error-guard/guard
 */

/** Marks a stream this plugin has already guarded, so a second mount recognises the first. */
export const GUARD_MARK = Symbol.for('argszero.dsh-stdio-error-guard/guarded')

/**
 * The handle properties that carry a byte stream, in report order.
 *
 * `control` is the provider's separate caller-owned channel
 * (`SubprocessHandle.control`), and `output` is a terminal handle's byte stream
 * (`SubprocessTerminalHandle.output`) — the same event reaches the same fatal
 * handler from either, so both are guarded by the same call.
 */
export const GUARDED_SLOTS = ['stdin', 'stdout', 'stderr', 'control', 'output'] as const

/** One of {@link GUARDED_SLOTS}. */
export type GuardedSlot = (typeof GUARDED_SLOTS)[number]

/** A Node stream, as far as this plugin needs to read one. */
export interface StreamLike {
  /** The event-registration method every stream carries. */
  on(event: 'error', listener: (error: unknown) => void): unknown
}

/** What one guarded stream saw, read back after the fact. */
export interface StreamObservation {
  /** The handle property the stream came from. */
  readonly slot: GuardedSlot
  /** Every `'error'` event this stream emitted, including repeats of one code. */
  readonly errors: number
  /** The distinct `error.code` values seen, in first-seen order. */
  readonly codes: readonly string[]
}

/**
 * Called once per distinct failure code on one stream.
 * @param slot - the handle property the stream came from.
 * @param code - `error.code`, or `'unknown'` when the error carries none.
 * @param error - the value the stream emitted.
 */
export type ErrorObserver = (slot: GuardedSlot, code: string, error: unknown) => void

/** What one {@link guardHandle} call did, per slot. */
export interface GuardReport {
  /** Slots that had no listener before and have one now. */
  readonly guarded: readonly GuardedSlot[]
  /** Slots already carrying this plugin's listener, left exactly as they were. */
  readonly already: readonly GuardedSlot[]
  /** Slots the handle does not carry (absent, or `null`). */
  readonly absent: readonly GuardedSlot[]
  /** Slots present, not stream-shaped, or refusing the registration. */
  readonly foreign: readonly GuardedSlot[]
  /**
   * Read the per-stream tally.
   * @returns one entry per guarded stream, in slot order.
   */
  observations(): readonly StreamObservation[]
}

/** The record parked on a guarded stream: the mark, the listener, and its tally. */
interface Marked {
  readonly slot: GuardedSlot
  readonly codes: Set<string>
  errors: number
  listener: (error: unknown) => void
}

const NO_REPORT: ErrorObserver = () => { /* the containment is what this module promises; a report is optional. */ }

/**
 * Whether a value can carry an `'error'` listener.
 *
 * `on` is the whole test on purpose: a `duplex` from another realm, a wrapping
 * proxy, or a stream class this build has never seen are all fine to attach to,
 * and a wrong answer in the strict direction (calling this `false` for something
 * that would have accepted the listener) is the one that costs the containment.
 * @param value - the candidate.
 * @returns whether `value` has callable `on`.
 */
export function isStreamLike(value: unknown): value is StreamLike {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { on?: unknown }).on === 'function'
}

/**
 * The `error.code` a stream error carries.
 * @param error - the emitted value.
 * @returns the code, or `'unknown'` when there is no string `code`.
 */
export function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'unknown'
}

function readMark(stream: StreamLike): Marked | undefined {
  const mark = (stream as unknown as Record<symbol, unknown>)[GUARD_MARK]
  return mark === undefined ? undefined : mark as Marked
}

function writeMark(stream: StreamLike, record: Marked): void {
  try {
    Object.defineProperty(stream, GUARD_MARK, { value: record, enumerable: false, configurable: true, writable: false })
  } catch {
    // A frozen stream still accepts the listener — which is the promise — but
    // cannot record that it did, so a second mount of this plugin would attach a
    // second listener and report one event twice. Containment is unaffected.
  }
}

/**
 * Attach one inert `'error'` listener to every stream a handle exposes.
 *
 * The call is total: it never throws, never replaces the handle, and never
 * rejects. A slot it cannot guard is reported in the result rather than raised,
 * because a guard that failed to install must not be the reason a spawn fails.
 * @param handle - a `SubprocessHandle` or `SubprocessTerminalHandle` (anything
 *   object-shaped; unknown slots are simply absent).
 * @param observer - called once per distinct `error.code` per stream.
 * @returns what was guarded, what was not, and how to read the tally.
 */
export function guardHandle(handle: unknown, observer: ErrorObserver = NO_REPORT): GuardReport {
  const guarded: GuardedSlot[] = []
  const already: GuardedSlot[] = []
  const absent: GuardedSlot[] = []
  const foreign: GuardedSlot[] = []
  const records: Marked[] = []

  if (handle !== null && (typeof handle === 'object' || typeof handle === 'function')) {
    const slots = handle as Record<string, unknown>
    for (const slot of GUARDED_SLOTS) {
      const value = slots[slot]
      if (value === undefined || value === null) {
        absent.push(slot)
        continue
      }
      if (!isStreamLike(value)) {
        foreign.push(slot)
        continue
      }
      if (readMark(value) !== undefined) {
        already.push(slot)
        continue
      }
      const record: Marked = {
        slot,
        codes: new Set<string>(),
        errors: 0,
        // Replaced immediately below; the field exists first so the listener can
        // close over the very record the stream's mark will carry.
        listener: () => {},
      }
      record.listener = (error: unknown): void => {
        record.errors += 1
        const code = errorCode(error)
        if (record.codes.has(code)) return
        record.codes.add(code)
        try {
          observer(slot, code, error)
        } catch {
          // A report is auxiliary; the containment it describes is not.
        }
      }
      try {
        value.on('error', record.listener)
      } catch {
        foreign.push(slot)
        continue
      }
      writeMark(value, record)
      guarded.push(slot)
      records.push(record)
    }
  }

  return {
    guarded,
    already,
    absent,
    foreign,
    observations: () => records.map((record): StreamObservation => ({
      slot: record.slot,
      errors: record.errors,
      codes: [...record.codes],
    })),
  }
}
