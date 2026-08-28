/**
 * Tests for `scripts/ci/validate-changed.ts` — the scoped half of `npm run validate`.
 *
 * `scripts/ci/**` is deliberately not excluded from coverage: it is ordinary production tooling,
 * and this file in particular decides *what gets checked at all*. Its failure mode is therefore the
 * worst kind — a run that looked at a fraction of the branch and printed the same "all clean" as a
 * real one — so most of what is pinned here is the not-looking cases:
 *
 *  - an unresolvable base exits non-zero rather than falling back to whatever it could see;
 *  - a failed `git diff` does the same, even though the uncommitted listings would still have
 *    returned a plausible handful of files (this was a real bug in the first draft);
 *  - and `.prisma` never reaches Prettier, which errors rather than skipping on it.
 *
 * The side-effecting seams (git, the filesystem, the two spawned toolchains) are injected, so
 * nothing here shells out.
 */

import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import {
  main,
  changedFiles,
  partition,
  lines,
  hasHeapCap,
  heapCapMb,
  runTool,
  REAL_DEPS,
  DEFAULT_HEAP_MB,
  type Deps,
} from '@/scripts/ci/validate-changed';
import { DEFAULT_HEAP_MB as CANONICAL_DEFAULT } from '@/scripts/run-capped.mjs';

/** NUL-delimited, the way git writes it with `-z`. */
const z = (...paths: string[]) => paths.map((p) => `${p}\0`).join('');

/**
 * @param over git stdout per call, in the order the module makes them: merge-base, branch diff,
 *   uncommitted, untracked. `null` models a non-zero exit.
 */
function makeDeps(over: Partial<Deps> = {}, gitResponses?: (string | null)[]) {
  const queue = [...(gitResponses ?? [])];
  const git = vi.fn((args: string[]) => {
    if (queue.length > 0) return queue.shift() ?? null;
    return args[0] === 'merge-base' ? 'base-sha-123456789\n' : '';
  });
  const run = vi.fn(() => 0);
  const log = vi.fn();
  const error = vi.fn();
  const deps: Deps = { git, exists: () => true, run, log, error, ...over };
  return { deps, git, run, log, error };
}

describe('lines', () => {
  it('splits a NUL-delimited listing and drops the trailing empty entry', () => {
    expect(lines(z('a.ts', 'b.ts'))).toEqual(['a.ts', 'b.ts']);
  });

  it('treats a failed git call as no output rather than throwing', () => {
    expect(lines(null)).toEqual([]);
  });
});

describe('partition', () => {
  it('sends only ESLint-configured extensions to the linter', () => {
    const { lintable } = partition(['a.ts', 'b.tsx', 'c.mjs', 'd.md', 'e.json', 'f.prisma']);
    expect(lintable).toEqual(['a.ts', 'b.tsx', 'c.mjs']);
  });

  it('keeps `.prisma` away from Prettier, which errors rather than skipping on it', () => {
    // "No parser could be inferred" is a hard failure, so one schema file in the list would fail
    // the whole run. Prisma formatting has its own step in the chain.
    const { formattable } = partition(['a.ts', 'schema.prisma', 'README.md']);
    expect(formattable).toEqual(['a.ts', 'README.md']);
  });

  it('allowlists what Prettier can parse rather than blocklisting one extension', () => {
    // The blocklist version of this failed any branch touching a Dockerfile, an .nvmrc, a shell
    // script or a CSV fixture — `prettier --check <file>` errors on an unknown extension named
    // explicitly, even though it skips the same file when walking a directory.
    const { formattable } = partition([
      'Dockerfile',
      '.nvmrc',
      '.npmrc',
      'nginx.conf',
      'scripts/ci/check.sh',
      'tests/fixtures/rows.csv',
      'app/page.tsx',
      'config.yml',
      'styles.css',
      'notes.md',
    ]);
    expect(formattable).toEqual(['app/page.tsx', 'config.yml', 'styles.css', 'notes.md']);
  });
});

describe('changedFiles', () => {
  it('unions the branch diff, the uncommitted work and the untracked files', () => {
    // The uncommitted half is not an extra: this runs mid-gate, where fixes sit in the working
    // tree precisely because they have not been amended in yet.
    const { deps } = makeDeps({}, [z('committed.ts'), z('staged.ts'), z('untracked.ts')]);
    expect(changedFiles('base', deps)).toEqual(['committed.ts', 'staged.ts', 'untracked.ts']);
  });

  it('de-duplicates a file that is both committed on the branch and dirty now', () => {
    const { deps } = makeDeps({}, [z('same.ts'), z('same.ts'), '']);
    expect(changedFiles('base', deps)).toEqual(['same.ts']);
  });

  it('drops paths that no longer exist, so a deletion is not handed to a tool', () => {
    const { deps } = makeDeps({ exists: (f) => f !== 'deleted.ts' }, [
      z('kept.ts', 'deleted.ts'),
      '',
      '',
    ]);
    expect(changedFiles('base', deps)).toEqual(['kept.ts']);
  });

  it('returns null when the branch diff itself failed', () => {
    // The bug this exists for: without it the two working-tree listings still return a plausible
    // handful of files, and the run prints the same cheerful "all clean" as a real one.
    const { deps } = makeDeps({}, [null, z('staged.ts'), z('untracked.ts')]);
    expect(changedFiles('bad-ref', deps)).toBeNull();
  });

  it('returns null when any listing failed — each is a way of not-looking', () => {
    const { deps } = makeDeps({}, [z('committed.ts'), null, '']);
    expect(changedFiles('base', deps)).toBeNull();
  });
});

describe('main — the cases where it must refuse to run', () => {
  it('exits 1 on `--base` with no revision', () => {
    const { deps, error, run } = makeDeps();
    expect(main(['--base'], deps)).toBe(1);
    expect(error).toHaveBeenCalledWith('`--base` needs a revision.');
    expect(run).not.toHaveBeenCalled();
  });

  it('exits 1 when `--base` is followed by another option, not a revision', () => {
    const { deps, run } = makeDeps();
    expect(main(['--base', '--verbose'], deps)).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('exits 1 when no merge base resolves, naming the fix', () => {
    const { deps, error, run } = makeDeps({}, [null]);
    expect(main([], deps)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no base revision available'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('git fetch origin main'));
    expect(run).not.toHaveBeenCalled();
  });

  it('exits 1 when the diff failed, rather than checking what it could see', () => {
    const { deps, error, run } = makeDeps({}, [null, z('staged.ts'), '']);
    expect(main(['--base', 'nonexistent'], deps)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('`git diff` failed'));
    expect(run).not.toHaveBeenCalled();
  });
});

describe('main — a normal run', () => {
  it('lints the code files and formats everything but `.prisma`', () => {
    const { deps, run } = makeDeps({}, [z('a.ts', 'schema.prisma', 'notes.md'), '', '']);

    expect(main(['--base', 'base-sha'], deps)).toBe(0);

    expect(run).toHaveBeenCalledTimes(2);
    const [eslintCall, prettierCall] = run.mock.calls as unknown as [
      [string, string[], string[]],
      [string, string[], string[]],
    ];
    expect(eslintCall[0]).toContain('eslint');
    expect(eslintCall[2]).toEqual(['a.ts']);
    expect(prettierCall[0]).toContain('prettier');
    expect(prettierCall[2]).toEqual(['a.ts', 'notes.md']);
  });

  it('reports how much it scoped to, so a suspiciously small run is visible', () => {
    const { deps, log } = makeDeps({}, [z('a.ts', 'b.md'), '', '']);
    main(['--base', 'abcdef1234567'], deps);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Scoped to 2 changed files vs abcdef123')
    );
  });

  it('skips ESLint entirely on a docs-only branch', () => {
    const { deps, run } = makeDeps({}, [z('README.md'), '', '']);
    expect(main(['--base', 'base-sha'], deps)).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0] as unknown as [string])[0]).toContain('prettier');
  });

  it('passes with nothing to do when the branch touched nothing that still exists', () => {
    // Not a failure: the other steps in the `validate:changed` chain still ran, and said so.
    const { deps, run, log } = makeDeps({}, ['', '', '']);
    expect(main(['--base', 'base-sha'], deps)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Nothing in scope for ESLint or Prettier.');
  });

  it('runs both tools even when the first fails, and fails the run', () => {
    // Two reports in one pass beats making someone re-run to discover the second problem.
    const run = vi.fn((entrypoint: string) => (entrypoint.includes('eslint') ? 1 : 0));
    const { deps } = makeDeps({ run }, [z('a.ts'), '', '']);

    expect(main(['--base', 'base-sha'], deps)).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('fails the run when only the formatter objects', () => {
    const run = vi.fn((entrypoint: string) => (entrypoint.includes('prettier') ? 1 : 0));
    const { deps } = makeDeps({ run }, [z('a.ts'), '', '']);
    expect(main(['--base', 'base-sha'], deps)).toBe(1);
  });

  it('resolves the merge base itself when no `--base` is given', () => {
    const { deps, git } = makeDeps({}, ['merge-base-sha\n', z('a.ts'), '', '']);
    main([], deps);
    expect(git).toHaveBeenCalledWith(['merge-base', 'origin/main', 'HEAD']);
  });
});

describe('the real seams', () => {
  // The two functions that actually leave the process. Exercised for real — cheaply and with no
  // side effects — because a seam nothing ever calls is a seam nothing has proved works.

  it('runs a tool from a plain node entrypoint and returns its exit status', () => {
    // No shell anywhere: `node <entrypoint>` with an argv array, so a filename carrying `&` or a
    // space is inert. That is the whole reason this does not go through `node_modules/.bin`.
    const ok = join(process.cwd(), 'scripts', 'ci', '__exit-ok.cjs');
    const bad = join(process.cwd(), 'scripts', 'ci', '__exit-bad.cjs');
    writeFileSync(ok, 'process.exit(0);\n');
    writeFileSync(bad, 'process.exit(3);\n');
    try {
      expect(runTool(ok, [], ['a file with spaces & an ampersand.ts'])).toBe(0);
      expect(runTool(bad, [], [])).toBe(3);
    } finally {
      rmSync(ok, { force: true });
      rmSync(bad, { force: true });
    }
  });

  it('returns git stdout on success and null on a non-zero exit', () => {
    const { git } = REAL_DEPS;
    expect(git(['--version'])).toMatch(/^git version/);
    expect(git(['rev-parse', 'definitely-not-a-ref-xyz'])).toBeNull();
  });

  it('resolves existence against the repo root, not the cwd of the caller', () => {
    expect(REAL_DEPS.exists('package.json')).toBe(true);
    expect(REAL_DEPS.exists('does/not/exist.ts')).toBe(false);
  });
});

describe('the heap cap', () => {
  it('matches the cap `npm run lint` runs under', () => {
    // Restated rather than imported — `run-capped.mjs` ends in a top-level `await`, and tsx
    // transpiles the CLI to CJS, where importing an async module throws. This is what stops the
    // restated number drifting; vitest runs ESM, so the import the CLI cannot do works here.
    expect(DEFAULT_HEAP_MB).toBe(CANONICAL_DEFAULT);
  });

  it('stands down when NODE_OPTIONS already fixes the heap, in either spelling', () => {
    // A fork that measured its own value keeps it.
    expect(hasHeapCap('--max-old-space-size=8192')).toBe(true);
    expect(hasHeapCap('--max_old_space_size 8192')).toBe(true);
    expect(hasHeapCap('--enable-source-maps')).toBe(false);
    expect(hasHeapCap(undefined)).toBe(false);
  });

  it('honours an explicit NODE_HEAP_MB request', () => {
    expect(heapCapMb('2048', 64 * 1024 ** 3, 1024)).toBe(2048);
  });

  it('ignores a malformed NODE_HEAP_MB rather than refusing to lint', () => {
    expect(heapCapMb('not-a-number', 64 * 1024 ** 3, 1024)).toBe(DEFAULT_HEAP_MB);
    expect(heapCapMb('-5', 64 * 1024 ** 3, 1024)).toBe(DEFAULT_HEAP_MB);
    expect(heapCapMb(undefined, 64 * 1024 ** 3, 1024)).toBe(DEFAULT_HEAP_MB);
  });

  it('clamps to a fraction of physical memory — a ceiling above real RAM is an OOM kill', () => {
    // 4GB machine → 3GB affordable, well under the 6144 default.
    expect(heapCapMb(undefined, 4 * 1024 ** 3, 1024)).toBe(3072);
  });

  it('never goes below what Node would have chosen unaided', () => {
    // On a machine too small for the request this is a no-op, not a downgrade.
    expect(heapCapMb('512', 4 * 1024 ** 3, 4288)).toBe(4288);
  });
});
