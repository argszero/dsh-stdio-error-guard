/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is **caught**. An arm whose mutation leaves the suite green is
 * SILENT — the promise it removes is untested, which is a finding about the
 * suite rather than a pass.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm rebuilds with
 * `tsc` first. The build is `--noEmitOnError` (`tsconfig.json`), so a mutation
 * that does not compile is reported as TYPEFAIL rather than counted.
 *
 * Each arm removes **one distinction this plugin exists to make**, chosen from
 * the promises the README and the module docs make: the listener on every
 * guarded slot, the mark that de-duplicates a second mount, the per-code
 * de-duplication, the tally, the seam landing on the instance, the read-back
 * that catches a write a proxy swallowed, the four configuration decisions, and
 * the two paths that must not manufacture an unhandled rejection.
 *
 * ```sh
 * node scripts/inject-defects.mjs                  # every arm
 * node scripts/inject-defects.mjs --filter=guard   # arms whose name matches
 * ```
 *
 * The harness restores the source in a `finally` **and rebuilds afterwards**:
 * the last arm leaves its mutation compiled into `lib/`, so a checkout that ran
 * this and then published would ship the last mutant.
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/**
 * One arm per distinction.
 *
 * `equivalent` marks a mutant kept in the list although no fixture can kill it,
 * with the measurement that makes it equivalent — recorded rather than hidden,
 * because "we tried to make this arm bite and could not" is a fact about the
 * arm.
 */
const MUTATIONS = [
  {
    // The headline: one inert listener per stream is the whole plugin.
    name: 'guard: no listener is attached to any stream',
    file: 'src/guard.ts',
    edits: [['        value.on(\'error\', record.listener)', '        void record.listener']],
  },
  {
    // Without the mark a second mount attaches a second listener and reports one
    // event twice.
    name: 'guard: a guarded stream is not marked, so a second mount double-counts',
    file: 'src/guard.ts',
    edits: [['      writeMark(value, record)', '      void record']],
  },
  {
    // One report per distinct code is the economy: a chatty child must not fill
    // the log with one repeated failure.
    name: 'guard: a repeated code is reported again on every event',
    file: 'src/guard.ts',
    edits: [['        if (record.codes.has(code)) return', '        if (false) return']],
  },
  {
    // The tally is the only evidence an operator gets that anything happened.
    name: 'guard: the per-stream tally is never incremented',
    file: 'src/guard.ts',
    edits: [['        record.errors += 1', '        record.errors += 0']],
  },
  {
    // `on` is the whole acceptance test, and the strict direction is the one
    // that costs the containment.
    name: 'guard: a value with a callable `on` is refused as foreign',
    file: 'src/guard.ts',
    edits: [['    && typeof (value as { on?: unknown }).on === \'function\'', '    && typeof (value as { on?: unknown }).on === \'symbol\'']],
  },
  {
    // A slot with nothing on it is not a slot this plugin failed to cover.
    name: 'guard: an absent slot is reported as foreign',
    file: 'src/guard.ts',
    edits: [['        absent.push(slot)', '        foreign.push(slot)']],
  },
  {
    // The handle comes from a provider and may be anything at all; a guard that
    // throws on an odd handle fails a spawn it was only observing.
    name: 'guard: an unusable handle makes the call throw instead of reporting',
    file: 'src/guard.ts',
    edits: [['  if (handle !== null && (typeof handle === \'object\' || typeof handle === \'function\')) {', '  if (true) {']],
  },
  {
    // The `code` is what makes a log line actionable; the message is not a code.
    name: 'guard: errorCode answers with a placeholder other than `unknown`',
    file: 'src/guard.ts',
    edits: [['  return \'unknown\'', '  return \'none\'']],
  },
  {
    // The seam is the instance: a write on a tracking view is a write on an
    // object every later `get` may hand back as a different one.
    name: 'install: the shadow lands on the view instead of the instance',
    file: 'src/install.ts',
    edits: [['    return { target: original as object, source: \'instance\' }', '    return { target: view as object, source: \'view\' }']],
  },
  {
    // A proxy's `set` trap can answer `true` and store nothing; only the
    // read-back sees it.
    name: 'install: a write that did not take is reported as installed',
    file: 'src/install.ts',
    edits: [['  if (mutable[method] !== wrapper) {', '  if (false) {']],
  },
  {
    // A prototype method must be revealed again by deleting the shadow.
    name: 'install: unwinding leaves the shadow in place',
    file: 'src/install.ts',
    edits: [['      else delete mutable[method]', '      void mutable[method]']],
  },
  {
    // Wrapping a non-function produces a spawn that throws at call time.
    name: 'install: a method that is not callable is wrapped anyway',
    file: 'src/install.ts',
    edits: [['  if (typeof current !== \'function\') return { outcome: \'no-method\', restore: NOOP_RESTORE }', '  if (false) return { outcome: \'no-method\', restore: NOOP_RESTORE }']],
  },
  {
    // A second mount that wraps the first wraps it again, and every later mount
    // adds another layer.
    name: 'install: this plugin\'s own shadow is wrapped a second time',
    file: 'src/install.ts',
    edits: [['  if ((current as unknown as Record<symbol, unknown>)[mark] === true) {', '  if (false) {']],
  },
  {
    // The callback runs *after* the original: the caller's return value must be
    // the original's, never the observer's.
    name: 'install: the caller receives the observer\'s result instead of the original\'s',
    file: 'src/install.ts',
    edits: [['    return result', '    return undefined']],
  },
  {
    // `enabled: false` is documented as "installs nothing at all".
    name: 'index: a disabled plugin still installs the shadows',
    file: 'src/index.ts',
    edits: [['  if (!settings.enabled) {', '  if (false) {']],
  },
  {
    // A service that is not mounted must be a *report* as well as a no-op: the
    // warning is the operator's only signal that the guard is not in force. The
    // `return` stays — it is what keeps the narrowing that lets the shadow call
    // compile — so this arm removes the report and nothing else.
    name: 'index: a missing subprocess service installs nothing and says nothing',
    file: 'src/index.ts',
    edits: [[
      '    ctx.logger.warn(`${LOG_PREFIX} the subprocess service is not mounted, so nothing is guarded: `\n'
      + '      + \'a stdio "error" on a child will keep reaching the process-level fatal handler and exit the process\')\n'
      + '    return',
      '    void 0\n'
      + '    return',
    ]],
  },
  {
    // The registration is what unwinds the seam at disposal.
    name: 'index: disposal does not hand the prototype methods back',
    file: 'src/index.ts',
    edits: [['    for (const [, shadow] of shadows) shadow.restore()', '    for (const [, shadow] of shadows) void shadow']],
  },
  {
    // A rejected allocation the plugin failed to observe would be the plugin
    // causing the crash it exists to prevent.
    name: 'index: a rejected terminal allocation becomes an unhandled rejection',
    file: 'src/index.ts',
    edits: [['        .catch(() => { /* nothing was allocated, or nothing could be observed. */ })', '        .catch(() => { throw new Error(\'unhandled\') })']],
  },
  {
    // The summary is written on a promise chain nothing awaits; a throwing log
    // sink must not become an unhandled rejection.
    name: 'guard: a throwing log sink on the summary becomes an unhandled rejection',
    file: 'src/index.ts',
    edits: [['    void Promise.resolve(done).then(summarise, summarise).catch(() => {})', '    void Promise.resolve(done).then(summarise, summarise)']],
  },
  {
    // A guard the operator cannot see is not in force, and `warn` is the level
    // that says so.
    name: 'index: a write that did not take is reported at debug instead of the configured level',
    file: 'src/index.ts',
    edits: [['          + \'a stdio "error" on a child will keep exiting the process\')', '          + \'a stdio "error" on a child will keep exiting the process\', \'debug\')']],
  },
  {
    // The default is the level at which a contained failure is worth reading.
    name: 'config: the default log level is silent',
    file: 'src/config.ts',
    edits: [['export const DEFAULT_LOG: GuardLogLevel = \'warn\'', 'export const DEFAULT_LOG: GuardLogLevel = \'silent\'']],
  },
  {
    // A misspelled key that mounts and stays quiet is how an operator comes to
    // believe the guard is not firing.
    name: 'config: an unknown key is ignored instead of refused',
    file: 'src/config.ts',
    edits: [['    if (!KNOWN_KEYS.includes(key)) {', '    if (false) {']],
  },
  {
    // `enabled: "yes"` is truthy, so an unvalidated value silently enables.
    name: 'config: a non-boolean `enabled` is accepted',
    file: 'src/config.ts',
    edits: [['  if (typeof enabled !== \'boolean\') {', '  if (false) {']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: a mutant that never terminates is a mutant the
 * suite cannot report on, and it is killed here rather than hanging the gate.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns whether it succeeded, and the text it produced.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
let malformed = 0
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  if (!Array.isArray(mutation.edits) || mutation.edits.length === 0
    || !mutation.edits.every(edit => Array.isArray(edit) && edit.length === 2
      && typeof edit[0] === 'string' && typeof edit[1] === 'string')) {
    // A flat array of strings would be destructured into single characters and
    // rewrite nothing — a silent no-op, reported here instead.
    results.push({ name: mutation.name, outcome: 'MALFORMED', detail: 'every edit must be a [from, to] pair of strings' })
    malformed += 1
    continue
  }
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  if (mutated === original) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the edit left the file byte-identical' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The `finally` above restores the *source*; the build output
// is whatever the last arm compiled, so it is rebuilt here whether or not every
// arm was evaluated.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 && malformed === 0 ? 0 : 1
