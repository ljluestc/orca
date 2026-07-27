# PR: fix(terminal): close Windows PTY root-identity recycle gap (#10680)

## Problem

`classifyWindowsTreeKillTarget` / `verifyWindowsTreeKillTarget` gate `taskkill /T /F` by
walking a PID's ancestry back to `process.pid` (this Orca process).  That is enough to
reject a completely foreign PID, but **not** enough to prove we own the *original* PTY
root:

> A recycled PID that lands on another Orca-owned descendant — another pane's shell, an
> agent CLI, a `git.exe` we spawned — still classifies as `own` and is eligible for
> `taskkill /T /F` on its whole subtree.

During concurrent multi-pane teardown (worktree delete, window close) Windows can recycle
a dead PTY root's PID into a still-live process that Orca itself parented.  The ancestry
walk returns `own` and `killWithDescendantSweep` force-kills that unrelated-but-ours tree,
taking a live pane's shell (or in-flight tool process) down with it.

The existing test already *documents* this as a known limit:

```ts
it('documents that a recycled PID under another Orca pane still classifies as own', () => {
  // Dead PTY root 4242 recycled as a tool under a different pane's agent tree.
  // Ancestry still reaches us, so taskkill is allowed — wrong process, own tree.
  // Closing this needs spawn-time CreationDate / Job Object (#10680).
  const rows = [link(ORCA_PID, 900), link(7000, ORCA_PID), link(7100, 7000), link(4242, 7100)]
  expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('own')
})
```

## Solution — Option 2: spawn-time `CreationDate` baseline

Capture `Win32_Process.CreationDate` (UTC milliseconds, same field the PowerShell/CIM probe
already reads) when the PTY is started, and compare it at teardown before issuing
`taskkill /T /F`.  A recycled PID has a different `CreationDate` than the original PTY
root, so it is classified `foreign` even though its ancestry still reaches Orca.

This is the exact analogue of the POSIX `lstart` check already used for descendant
`SIGKILL` identity.

### New types / exports

**`WindowsPtySpawnIdentity`** — the spawn-time snapshot stored per PTY:

```ts
export interface WindowsPtySpawnIdentity {
  /** PID as reported at spawn time. */
  readonly pid: number
  /**
   * Win32_Process.CreationDate at spawn, as a UTC millisecond epoch value.
   * `null` when the probe was unavailable (treat as unverifiable, fall back to
   * ancestry-only check so behaviour is identical to the pre-fix path).
   */
  readonly creationDateMs: number | null
}
```

**`captureWindowsPtySpawnIdentity(pid, deps?)`** — called once at PTY start:

```ts
export async function captureWindowsPtySpawnIdentity(
  pid: number,
  deps?: { readRows?: WindowsProcessLinkReader; platform?: NodeJS.Platform }
): Promise<WindowsPtySpawnIdentity>
```

Queries `Win32_Process` for `pid`'s `CreationDate`.  Returns `{ pid, creationDateMs: null }`
when the probe is unavailable so callers can still proceed with the weaker ancestry-only
check.

**`WindowsTreeKillTarget` — new verdict `'stale'`**

```ts
export type WindowsTreeKillTarget = 'own' | 'absent' | 'foreign' | 'unknown' | 'stale'
```

`'stale'`: the PID exists in our subtree but its `CreationDate` does not match the
spawn-time snapshot — the PTY root has been recycled.  Callers must treat this identically
to `'foreign'` (refuse `taskkill /T /F`).

**Updated `classifyWindowsTreeKillTarget` signature:**

```ts
export function classifyWindowsTreeKillTarget(
  rootPid: number,
  rows: readonly ProcessLink[],
  ownerPid: number,
  spawnIdentity?: WindowsPtySpawnIdentity   // ← new optional parameter
): WindowsTreeKillTarget
```

When `spawnIdentity` is provided and `creationDateMs` is non-null, and the `rootPid`
resolves to `own`, the function additionally checks whether the row's `CreationDate`
matches `spawnIdentity.creationDateMs`.  If they differ, it returns `'stale'` instead of
`'own'`.

**Updated `verifyWindowsTreeKillTarget` signature:**

```ts
export async function verifyWindowsTreeKillTarget(
  rootPid: number,
  deps: {
    readRows?: WindowsProcessLinkReader
    ownerPid?: number
    platform?: NodeJS.Platform
    timeoutMs?: number
    spawnIdentity?: WindowsPtySpawnIdentity  // ← new optional parameter
  } = {}
): Promise<WindowsTreeKillTarget>
```

The `spawnIdentity` is threaded through to `classifyWindowsTreeKillTarget`.

### Storage

`WindowsPtySpawnIdentity` is attached to the existing per-PTY session record in
`killWithDescendantSweep`'s call site (local provider and daemon session path both carry
it).  SSH relay teardown is explicitly out of scope (tracked separately).

### Fallback behaviour

If `captureWindowsPtySpawnIdentity` returns `creationDateMs: null` (probe unavailable,
timeout, or non-Windows platform), `classifyWindowsTreeKillTarget` falls back to the
pre-fix ancestry-only check.  The blast radius is identical to the current code — no
regression for systems where the probe is slow or blocked.

### Provider change — `CreationDate` in process rows

`queryWindowsProcessRowsFresh` (and its type `ProcessLink`) is extended to include an
optional `creationDateMs` field so the existing single CIM query retrieves both topology
and identity in one round trip:

```ts
type ProcessLink = { pid: number; ppid: number; creationDateMs?: number }
```

The PowerShell query is updated to select `CreationDate` alongside `ProcessId` and
`ParentProcessId`.  Callers that do not use `creationDateMs` are unaffected.

## Files changed

| File | Change |
|---|---|
| `src/main/windows-pty-root-identity.ts` | Add `WindowsPtySpawnIdentity`, `captureWindowsPtySpawnIdentity`, `'stale'` verdict, `spawnIdentity` parameter on both classify/verify functions |
| `src/main/windows-pty-root-identity.test.ts` | Tests for: `creationDateMs` mismatch → `'stale'`; match → `'own'`; null baseline → `'own'` (fallback); updated `documents…` test now asserts `'stale'` not `'own'`; spawn-capture happy/sad path |
| `src/main/providers/windows-foreground-process-rows.ts` | Add `creationDateMs` to `ProcessLink`, extend PowerShell query |
| Call site in local/daemon teardown path | Pass `spawnIdentity` from stored per-PTY record through to `verifyWindowsTreeKillTarget` |

## Acceptance criteria (from issue)

- [ ] A recycled PID that lands on a different Orca-owned process returns `'stale'`/`'foreign'` and is **not** eligible for `taskkill /T /F`.
- [ ] Legitimate ConPTY / winpty PTY roots with matching `CreationDate` still return `'own'`.
- [ ] The `documents…` test is updated to assert `'stale'` (previously documented `'own'` as a known gap).
- [ ] Unit coverage for the false-`own` graph shape passes with `creationDateMs` mismatch.
- [ ] `captureWindowsPtySpawnIdentity` returns `{ creationDateMs: null }` when the probe is unavailable and does not throw.
- [ ] Local provider + daemon session paths both carry `spawnIdentity`.
- [ ] Residual verify-to-taskkill race (no handle or Job Object) is documented in the source.

## Non-goals

- Reopening fail-open on unknown probe failure (intentional).
- SSH relay teardown (separate implementation).
- Job Object / handle approach (Option 3, stronger but out of scope here).

Co-Authored-By: Oz <oz-agent@warp.dev>
