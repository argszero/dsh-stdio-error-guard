/**
 * The plugin's configuration, validated where it is read.
 *
 * The defaults are applied here rather than in an exported object named
 * `Config`, because the Loader reads a `Config` export as a schema: a plain
 * object there makes the plugin fail to mount with
 * `Cannot read properties of undefined (reading 'validate')`, and a plugin that
 * does not mount guards nothing.
 *
 * An unknown key is refused rather than ignored. A misspelled `log` that mounts
 * and stays quiet is how an operator comes to believe the guard is not firing
 * when it is only unreported — and the two states ask for different work.
 *
 * @module @argszero/dsh-stdio-error-guard/config
 */

/** How much of what the guard contains is written to the log. */
export type GuardLogLevel =
  /** Contain silently; the tally is still kept and readable from a test. */
  | 'silent'
  /** One line per distinct failure code per stream, at debug level. */
  | 'debug'
  /** The same lines, at warning level. */
  | 'warn'

/** What the plugin accepts, every field optional. */
export interface StdioGuardConfig {
  /** `false` installs nothing at all: the shadow is not written and no listener is attached. */
  enabled?: boolean
  /** Level of the containment line. */
  log?: GuardLogLevel
}

/** The configuration after defaults and validation. */
export interface ResolvedGuardConfig {
  readonly enabled: boolean
  readonly log: GuardLogLevel
}

/** Every level {@link resolveConfig} accepts, in the order the errors list them. */
export const GUARD_LOG_LEVELS: readonly GuardLogLevel[] = ['silent', 'debug', 'warn']

/** The default level: a contained failure is worth one warning line. */
export const DEFAULT_LOG: GuardLogLevel = 'warn'

const KNOWN_KEYS = ['enabled', 'log']

/**
 * Apply defaults and validate one mounted configuration.
 * @param raw - the configuration as mounted; empty uses every default.
 * @returns the resolved configuration.
 * @throws when the value is not an object, a key is unknown, or a value is
 *   unusable — the plugin refuses to mount rather than guard under rules it
 *   cannot honour.
 */
export function resolveConfig(raw: StdioGuardConfig = {}): ResolvedGuardConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`stdio-error-guard: configuration must be an object, got ${JSON.stringify(raw)}`)
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) {
      throw new Error(`stdio-error-guard: unknown configuration key "${key}"; known keys are ${KNOWN_KEYS.join(', ')}`)
    }
  }
  const enabled = raw.enabled ?? true
  if (typeof enabled !== 'boolean') {
    throw new Error(`stdio-error-guard: "enabled" must be a boolean, got ${JSON.stringify(enabled)}`)
  }
  const log = raw.log ?? DEFAULT_LOG
  if (!GUARD_LOG_LEVELS.includes(log)) {
    throw new Error(`stdio-error-guard: "log" must be one of ${GUARD_LOG_LEVELS.join(', ')}, got ${JSON.stringify(log)}`)
  }
  return { enabled, log }
}
