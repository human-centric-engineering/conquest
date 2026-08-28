/**
 * Tests: scripts/ci/chunked-lint.mjs
 *
 * The thing under test is a chunk PLAN, and a bad plan does not fail — it
 * passes, faster, having linted less. Every assertion here exists because that
 * failure mode is silent:
 *
 *  - An earlier draft of this change split the tree by directory name and
 *    dropped 139 files (`emails/`, `hooks/`, `types/`, `prisma/`, `proxy.ts`,
 *    every root config). CI stayed green.
 *  - A chunk plan that duplicates files is only slow, but one that loses them
 *    is a hole, so the partition property is asserted in both directions:
 *    nothing lost, nothing repeated, order-independent.
 *
 * `lintTargets` takes its two collaborators by injection (`listFiles`, and an
 * ESLint-shaped object) so the enumeration logic is testable without spawning
 * a real lint — which on this repo costs ~4GB and four minutes.
 *
 * @see scripts/ci/chunked-lint.mjs
 */

import { describe, it, expect, vi } from 'vitest';

// Plain .mjs with no type declarations, by design: it must run from
// `npm run lint:ci` in a fresh checkout, before anything is compiled. TS
// resolves it via allowJs, so the named imports below are inferred, not `any`.
import {
  chunk,
  parseChunks,
  lintTargets,
  runChunk,
  adaptiveGroups,
  groupKey,
  resolveEslintCommand,
  withHeapCap,
  main,
  DEFAULT_CHUNKS,
  LINTABLE,
} from '@/scripts/ci/chunked-lint.mjs';

const files = (n: number): string[] => Array.from({ length: n }, (_, i) => `f${i}.ts`);

describe('chunk', () => {
  it('partitions exactly — every item once, none lost', () => {
    const input = files(101);
    const flat = chunk(input, 4).flat();

    expect(flat).toHaveLength(input.length);
    expect(new Set(flat).size).toBe(input.length);
    expect([...flat].sort()).toEqual([...input].sort());
  });

  it.each([1, 2, 3, 7, 64])('partitions exactly at %i chunks', (n) => {
    const input = files(50);
    const flat = chunk(input, n).flat();
    expect([...flat].sort()).toEqual([...input].sort());
  });

  it('keeps a directory together — locality, not balance, is what costs memory', () => {
    // The FIRST version of this function striped round-robin to balance the
    // chunks, and measured WORSE than not chunking at all (3.98GB against
    // 3.28GB): striping puts a slice of every directory in every chunk, so each
    // chunk loads nearly the whole type graph. A chunk costs its import
    // CLOSURE, not its file count — `eslint prisma` (98 files) peaks at 1.92GB
    // while one file in `lib/api` peaks at 2.64GB. So directories stay whole.
    const plan = chunk(['a/1.ts', 'a/2.ts', 'b/1.ts', 'b/2.ts'], 2);

    for (const c of plan) {
      const dirs = new Set(c.map((f: string) => f.split('/')[0]));
      expect(dirs.size, `chunk ${JSON.stringify(c)} mixes directories`).toBe(1);
    }
  });

  it('splits an oversized directory rather than letting it set the peak alone', () => {
    // At a fixed depth of 2, `tests/unit` alone was 1,649 of 4,527 files — one
    // indivisible group, so every plan had a chunk a third of the tree wide and
    // that chunk set the peak by itself. Oversized buckets deepen.
    const big = Array.from({ length: 40 }, (_, i) => `tests/unit/${i % 4}/f${i}.ts`);
    const plan = chunk([...big, 'lib/a.ts'], 4);
    const largest = Math.max(...plan.map((c: string[]) => c.length));

    expect(largest).toBeLessThan(big.length);
  });

  it('stops deepening when a directory has no deeper segment to split on', () => {
    // 30 siblings in one flat directory cannot be divided by path, and the
    // grouping must terminate rather than loop looking for a deeper segment.
    const flat = Array.from({ length: 30 }, (_, i) => `lib/f${i}.ts`);
    const groups = adaptiveGroups(flat, 5);

    expect([...groups.values()].flat()).toHaveLength(30);
  });

  it('groups a root-level file without crashing on its missing directory', () => {
    expect(groupKey('proxy.ts')).toBe('.');
    const plan = chunk(['proxy.ts', 'lib/a.ts'], 2);
    expect(plan.flat().sort()).toEqual(['lib/a.ts', 'proxy.ts']);
  });

  it('never emits an empty chunk, even when asked for more chunks than it can make', () => {
    // An empty chunk would spawn eslint with no file arguments, and eslint with
    // no arguments lints NOTHING and exits 0 — a silent pass, which is the
    // failure mode this whole file guards against.
    //
    // Asking for 10 chunks of 3 files does NOT give 10 chunks, or even 3: these
    // three are siblings in one directory, and locality chunking keeps a
    // directory whole. Fewer, well-localised chunks is the design working, not
    // failing — the count is a ceiling, not a target.
    const plan = chunk(files(3), 10);

    expect(plan.length).toBeGreaterThan(0);
    expect(plan.length).toBeLessThanOrEqual(10);
    expect(plan.every((c: string[]) => c.length > 0)).toBe(true);
    expect(plan.flat().sort()).toEqual(files(3).sort());
  });

  it('survives an empty input without throwing', () => {
    expect(chunk([], 4)).toEqual([]);
  });
});

describe('parseChunks', () => {
  it('defaults when unset or empty', () => {
    expect(parseChunks(undefined)).toBe(DEFAULT_CHUNKS);
    expect(parseChunks('')).toBe(DEFAULT_CHUNKS);
  });

  it('takes a positive integer', () => {
    expect(parseChunks('8')).toBe(8);
  });

  it.each(['0', '-1', '2.5', 'four', 'NaN'])(
    'falls back rather than failing the run on %s',
    (raw) => {
      // Refusing to lint because an unrelated variable is malformed trades a
      // small problem for a bigger one — same rule as run-capped.mjs.
      expect(parseChunks(raw)).toBe(DEFAULT_CHUNKS);
    }
  );
});

describe('lintTargets', () => {
  const eslintStub = (ignored: string[] = []) => ({
    isPathIgnored: (p: string) => Promise.resolve(ignored.some((i) => p.endsWith(i))),
  });

  it('keeps only lintable extensions', async () => {
    const listFiles = () =>
      ['a.ts', 'b.tsx', 'c.js', 'd.mjs', 'e.cjs', 'f.jsx', 'g.md', 'h.json', 'i.css'].join('\n');

    const out = await lintTargets({ listFiles, eslint: eslintStub(), exists: () => true });

    expect(out).toEqual(['a.ts', 'b.tsx', 'c.js', 'd.mjs', 'e.cjs', 'f.jsx'].sort());
    expect(LINTABLE).toContain('.tsx');
  });

  it("defers to ESLint's own ignore logic rather than reimplementing it", async () => {
    // The flat config's `ignores` (coverage/**, .next/**, …) must be honoured
    // without this script re-deriving them, which is where a hand-rolled
    // equivalent silently drifts from the real config.
    const listFiles = () => ['keep.ts', 'coverage/skip.js'].join('\n');

    const out = await lintTargets({
      listFiles,
      eslint: eslintStub(['coverage/skip.js']),
      exists: () => true,
    });

    expect(out).toEqual(['keep.ts']);
  });

  it('is deterministic, so the same commit chunks the same way on every runner', async () => {
    const listFiles = () => ['z.ts', 'a.ts', 'm.ts'].join('\n');
    const out = await lintTargets({ listFiles, eslint: eslintStub(), exists: () => true });
    expect(out).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('drops a file deleted from the working tree but still in the index', async () => {
    // `git ls-files` reads the INDEX. Handing eslint a path that no longer
    // exists exits 2 ("No files matching the pattern") and fails the whole
    // chunk for a reason unrelated to lint — the state a developer is in while
    // reproducing a CI failure locally.
    const listFiles = () => ['kept.ts', 'deleted.ts'].join('\n');
    const out = await lintTargets({
      listFiles,
      eslint: eslintStub(),
      exists: (p: string) => !p.endsWith('deleted.ts'),
    });

    expect(out).toEqual(['kept.ts']);
  });

  it('ignores blank lines from git output', async () => {
    const listFiles = () => 'a.ts\n\n  \nb.ts\n';
    const out = await lintTargets({ listFiles, eslint: eslintStub(), exists: () => true });
    expect(out).toEqual(['a.ts', 'b.ts']);
  });
});

describe('runChunk', () => {
  const fakeChild = (behaviour: (h: Record<string, (...a: never[]) => void>) => void) => {
    const handlers: Record<string, (...a: never[]) => void> = {};
    queueMicrotask(() => behaviour(handlers));
    return { on: (e: string, h: (...a: never[]) => void) => (handlers[e] = h) };
  };

  it('resolves the exit code rather than throwing', async () => {
    const spawnFn = vi.fn(() => fakeChild((h) => h.exit?.(1 as never)));
    await expect(runChunk(['a.ts'], [], { spawnFn, command: ['eslint'] })).resolves.toBe(1);
  });

  it('reports a spawn failure as a failure, not a pass', async () => {
    // `resolve(0)` here would turn "eslint is missing" into a green run.
    const spawnFn = vi.fn(() => fakeChild((h) => h.error?.(new Error('ENOENT') as never)));
    await expect(runChunk(['a.ts'], [], { spawnFn, command: ['eslint'] })).resolves.toBe(1);
  });

  it('treats a signal-killed child as a failure', async () => {
    // A chunk OOM-killed by the runner exits with a null code. Coercing that to
    // 0 would report success for the exact failure this script exists to avoid.
    const spawnFn = vi.fn(() => fakeChild((h) => h.exit?.(null as never)));
    await expect(runChunk(['a.ts'], [], { spawnFn, command: ['eslint'] })).resolves.toBe(1);
  });

  it('never spawns through a shell — the argv is filenames', async () => {
    // run-capped.mjs documents the hazard: with `shell: true` on Windows the
    // args are joined into one cmd.exe string, so a path containing `&` or `^`
    // is interpreted. Filenames must never take that path.
    const spawnFn = vi.fn(() => fakeChild((h) => h.exit?.(0 as never)));
    await runChunk(['a.ts'], ['--cache'], { spawnFn, command: ['eslint'] });

    expect(spawnFn).toHaveBeenCalledWith(
      'eslint',
      ['a.ts', '--cache'],
      expect.objectContaining({ shell: false })
    );
  });
});

describe('resolveEslintCommand', () => {
  it("runs eslint's JS entry under this node, not the .bin shim", () => {
    // The shim is a `.cmd` on Windows, and since the CVE-2024-27980 fix `spawn`
    // REFUSES a `.cmd` target without `shell: true` — which this script cannot
    // use, because its argv is filenames. Going through `execPath` keeps one
    // code path on every platform instead of one that fails on Windows.
    const [bin, entry] = resolveEslintCommand() as string[];
    expect(bin).toBe(process.execPath);
    expect(entry).toMatch(/node_modules[/\\]eslint[/\\]bin[/\\]eslint\.js/);
  });
});

describe('withHeapCap', () => {
  it('applies a cap when the environment carries none', () => {
    // Without this, `lint:ci` outside CI inherits Node's default heap (~2GB on
    // an 8GB box), which is BELOW the 2.64GB floor one chunk needs — so every
    // chunk aborts with exit 134, the failure this script exists to prevent.
    expect((withHeapCap({}) as { NODE_OPTIONS: string }).NODE_OPTIONS).toBe(
      '--max-old-space-size=6144'
    );
  });

  it("defers to a cap already set, so CI's value always wins", () => {
    const out = withHeapCap({ NODE_OPTIONS: '--max-old-space-size=5120' }) as {
      NODE_OPTIONS: string;
    };
    expect(out.NODE_OPTIONS).toBe('--max-old-space-size=5120');
  });

  it('appends rather than replacing other NODE_OPTIONS', () => {
    const out = withHeapCap({ NODE_OPTIONS: '--enable-source-maps' }) as {
      NODE_OPTIONS: string;
    };
    expect(out.NODE_OPTIONS).toBe('--enable-source-maps --max-old-space-size=6144');
  });
});

describe('main', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    log: () => {},
    env: {},
    run: () => Promise.resolve(0),
    ...over,
  });

  it('does nothing, successfully, when there is nothing to lint', async () => {
    const run = vi.fn();
    await expect(main([], deps({ targets: [], run }))).resolves.toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs one eslint process per chunk', async () => {
    // Typed signature, not a bare `vi.fn()`: without it `mock.calls` is `[]`
    // and indexing a call is a type error rather than a read.
    const run = vi.fn((_files: string[], _argv: string[]) => Promise.resolve(0));
    const targets = ['a/1.ts', 'b/1.ts', 'c/1.ts', 'd/1.ts'];

    await main([], deps({ targets, chunks: 4, run }));

    expect(run).toHaveBeenCalledTimes(4);
    // Every target reached exactly one process — the partition property again,
    // this time through the real loop rather than through `chunk()` alone.
    expect(run.mock.calls.flatMap((c) => c[0]).sort()).toEqual(targets);
  });

  it('returns the WORST exit code, not the last one', async () => {
    // The loop keeps going after a failing chunk so the author sees every
    // problem in one run. That is only safe if the failure still propagates —
    // returning the last code would turn "chunk 1 failed, chunk 2 passed" into
    // a green lint.
    const run = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    await expect(
      main([], deps({ targets: ['a/1.ts', 'b/1.ts', 'c/1.ts', 'd/1.ts'], chunks: 4, run }))
    ).resolves.toBe(1);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('forwards its argv to every chunk', async () => {
    // `--cache` and friends have to reach each process; dropping them silently
    // turns every CI run cold, which is the cost this script is trying to bound.
    const run = vi.fn((_files: string[], _argv: string[]) => Promise.resolve(0));
    await main(
      ['--cache', '--max-warnings=0'],
      deps({ targets: ['a/1.ts', 'b/1.ts'], chunks: 2, run })
    );

    for (const call of run.mock.calls) {
      expect(call[1]).toEqual(['--cache', '--max-warnings=0']);
    }
  });

  it('reads the chunk count from LINT_CHUNKS', async () => {
    const run = vi.fn(() => Promise.resolve(0));
    const targets = ['a/1.ts', 'b/1.ts', 'c/1.ts', 'd/1.ts'];

    await main([], { log: () => {}, env: { LINT_CHUNKS: '2' }, run, targets });

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default when LINT_CHUNKS is nonsense', async () => {
    const run = vi.fn(() => Promise.resolve(0));
    const targets = Array.from({ length: 8 }, (_, i) => `d${i}/1.ts`);

    await main([], { log: () => {}, env: { LINT_CHUNKS: 'lots' }, run, targets });

    expect(run).toHaveBeenCalledTimes(DEFAULT_CHUNKS);
  });
});
