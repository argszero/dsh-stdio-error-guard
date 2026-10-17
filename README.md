# @argszero/dsh-stdio-error-guard

A containment plugin for the stdio `error` events that kill a `dsh` host.

A Node stream that emits `'error'` with no listener is **thrown**, from inside
the callback that raised it. The harness answers an uncaught exception with one
deliberate policy — one `util.inspect` diagnostic, release, `exit(1)` — and that
policy is right for a throw in the middle of an update. It is the wrong answer
for a broken pipe on a child that has already exited: the pipe is a corpse, and
the child's exit facts were always the authoritative outcome.

This plugin shadows the subprocess service's `spawn` and `spawnTerminal` and
attaches one inert `'error'` listener to each stream the returned handle
exposes. Nothing else changes.

Source: [Discussion #9904](https://github.com/deepseek-ai/deepseek-harness/discussions/9904).

## The problem

The reported failure is three occurrences in two days, on Windows, during
ordinary use:

```
dsh: fatal uncaught exception: Error: read ECONNRESET
    at WriteWrap.onWriteComplete [as oncomplete] (node:internal/stream_base_commons:87:19)
    …
    at ChildProcess._handle.onexit (node:child_process:1124:15)
```

The host exits 1. The Electron shell stays alive, and the loopback web server
and the mobile-relay gateway are gone behind it, with no UI signal — nothing in
the shell can respawn a host (`apps/desktop/src/host-process.ts:187` returns the
existing promise whenever a child exists, and `apps/desktop/src/main.ts:447` is
the only construction site).

The escalation is by design. `installFailLoud`
(`packages/boot/app-boot/src/index.ts:884`; the diagnostic is written at `:896`,
`exit(1)` at `:898` and `:917`, and both process events are registered at
`:930-931`) is registered for every shipped profile, the desktop host included,
at `apps/cli/src/profile-boot.ts:309`. It exists because *"only the throw site
knows which state is intact; a `'data'` listener that threw mid-update has
already dropped a chunk and half-set its own fields, and resuming would turn a
visible crash into silently wrong output"*
(`.agents/notes/implemented/architecture/2026-09-22-fatal-diagnostics-and-crash-reports.md`).
**This plugin does not touch that policy.**

### Why the layer looks covered and is not

The subprocess provider does attach an `error` listener to a child's piped
streams — `observeOutputStream`
(`packages/subprocess/subprocess-local/src/spawn.ts:293`) registers
`once('end')`, `once('close')` and `once('error')` — but its `settle` removes all
three the moment the **first** of them fires (`:296-305`). An ordinary child exit
ends the pipe, and from that instant the stream carries no listener at all. A
pipe `error` arriving afterwards has nothing to catch it and is thrown out of the
libuv completion. **That window — after the child has closed — is where the
reported stack comes from.** (`stdin` is the one stream the layer does guard for
good, and only when the caller supplied batch stdin: `spawn.ts:385`.)

The tree already states the contract this plugin applies, for the Python worker
child, in `packages/experimental/ptc-runtime-python/src/index.ts:2318-2324`:

```ts
const silenceStreamError = (): void => {}
proto.on('error', silenceStreamError)
child.stdout.on('error', silenceStreamError)
child.stderr.on('error', silenceStreamError)
```

with the comment above it:

> Fd-3 and the stdout/stderr pipes emit `error` on early child death
> (ECONNRESET/EPIPE); swallow them so they do not become uncaught. The
> authoritative failure signal is `child.on('close')` above.

This plugin is that same contract applied one layer up, to every child the
subprocess service starts.

## What it does

It shadows the subprocess service's `spawn` and `spawnTerminal` — **one
own-property write on the underlying instance**, which is what makes the seam
process-wide rather than one call site wide — and attaches one inert `'error'`
listener to each stream the returned handle exposes:

| handle | guarded slots |
|---|---|
| `SubprocessHandle` | `stdin`, `stdout`, `stderr`, `control` |
| `SubprocessTerminalHandle` | `output` |

Precisely, and no further:

- **The listener is inert.** It consumes no byte, does not resume or pause the
  stream, does not destroy it, and does not replace or suppress any other
  listener — an `EventEmitter` calls all of them, so a caller's own `'error'`
  handler still runs.
- **The handle is the provider's own object**, returned un-wrapped. The
  observation runs *after* the original method, and the caller receives the
  original's return value.
- **It is a persistent `on`, not a `once`** — that is the whole point. It
  outlives the provider's `once('error')` and covers the post-close window.
- **It counts and reports.** Every occurrence is counted per stream, and the
  first of each distinct `error.code` per stream is reported, so one broken pipe
  reaches the log and a child that fails a thousand times does not fill it.
- **It is total.** A handle that is absent, `null`, not stream-shaped, or
  refuses the registration is reported in the result rather than raised — a guard
  that failed to install must never be the reason a spawn fails.
- **The prototype is never mutated.** The shadow is one own property on the
  service instance; `LocalSubprocessRuntime.prototype.spawn` is untouched, and
  disposal deletes the own property to reveal it again.

## Install

The package is a cordis plugin, so it mounts like any other. Add it to the
profile and apply it as a bundle patch:

```sh
npm install --save @argszero/dsh-stdio-error-guard
```

```yaml
# cordis.yml — or the profile's own patch
- insert:
    - id: stdio-error-guard
      name: '@argszero/dsh-stdio-error-guard'
      inject:
        - subprocess
```

The package ships its own bundle patch (`cordis.patch.yml`, declared under
`dsh.bundle.patch`), so a profile that installs it by name gets the row above
without writing it by hand.

`inject: ['subprocess']` matters: the shadow is written to the *instance*, and a
plugin that mounted before the subprocess service would shadow nothing and say
nothing about it.

## Configuration

```yaml
- id: stdio-error-guard
  name: '@argszero/dsh-stdio-error-guard'
  inject: [subprocess]
  config:
    enabled: true   # default true  — false installs nothing at all
    log: warn       # default warn  — silent | debug | warn
```

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | `false` writes no shadow and attaches no listener |
| `log` | `warn` | level of the containment line and of the "not in force" warning; `silent` suppresses both |

The lifecycle lines ("guarding …", "carries no … method", "exposed no stream to
guard", the settlement summary) are always `debug`: they say what was installed,
not that something broke. An unknown key is **refused** rather than ignored — a
misspelled `log` that mounts and stays quiet is how an operator comes to believe
the guard is not firing when it is only unreported.

## What this cannot reach

Stated plainly, because a containment plugin that overstates itself is worse
than none:

- **It does not change the fatal policy**, does not resume a failed operation,
  and cannot restore a host that has already exited. Auto-restart is a separate,
  upstream change.
- **Collect-mode streams are invisible to it.** A child spawned with a
  `SubprocessCollect` disposition has its pipes bound inside `bindManagedProcess`
  (`spawn.ts:288`) and no plugin ever receives them. The same applies to the
  provider's own spill-file path.
- **The Electron shell's own pipes are in a different process** —
  `apps/desktop/src/host-process.ts:203-205`,
  `apps/desktop/src/command-manager-entry.ts:29`,
  `apps/desktop/src/login-shell-environment.ts:114-115` — and that process mounts
  no plugins at all. Those are upstream work, not this package's.
- **It is not a fix for the provider.** The durable fix is for
  `observeOutputStream` to leave a permanent listener on a piped stream it has
  finished observing, which is why this is a containment rather than a patch to
  the harness.

## How it is verified

- **93 tests** across 19 suites, eight of them across three suites against the
  shipped modules rather than a stand-in: a real cordis `Context`, the real
  `LocalSubprocessRuntime`, and real child processes.
- `test/witness.spec.mjs` measures the gap itself, in both directions, with no
  stand-in anywhere on the path: a plain run leaves the closed child's `stdout`
  with **zero** `error` listeners and `emit('error')` **throws**; with the plugin
  mounted the same stream carries a listener after close and the same emit is
  **inert**, while the caller's own reader still receives every byte.
- **23 defect-injection arms**, each removing one distinction, all
  **23 caught** — none silent. `npm run test:inject` mutates the source, rebuilds
  with `tsc`, and requires the suite to fail.
- Zero runtime dependencies; `@deepseek-ai/cordis` and
  `@deepseek-ai/dsh-subprocess` are peers.

## Supported lines

`@deepseek-ai/dsh-subprocess` in the `0.1.7-rc` and `0.2.x` lines, and the
`@deepseek-ai/cordis` `4.0.x` line. The plugin reads only the service instance,
the two method names, and the handle's slot names — all of which are the
published seam.

## Development

```sh
npm install
npm run build          # tsc
npm test               # node --test test/*.spec.mjs
npm run test:inject    # mutation arms; requires every mutation to be caught
```

## License

MIT
