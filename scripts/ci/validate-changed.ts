/**
 * Scoped lint + format — the narrowable half of `npm run validate`.
 *
 * `npm run validate` is seven whole-tree steps. Two of them scale with the size of the repository
 * rather than the size of the change: ESLint (type-aware, the step that OOMs — see
 * `scripts/run-capped.mjs`) and Prettier. This runs those two over **only what the branch touched**,
 * so a two-file fix is not paying to lint two thousand files.
 *
 * ## What is deliberately NOT scoped
 *
 * `tsc --noEmit`. Type-checking is whole-program: handing `tsc` a file list drops the project's
 * config and, worse, silently stops looking at the *consumers* of what changed — which are exactly
 * the errors a change-scoped check exists to catch. `validate:changed` therefore still runs the
 * full type-check, along with the three cheap `check:*` steps and the Prisma format check; it is a
 * narrowing of `validate`, never a subset of it. Nothing is dropped.
 *
 * ## What counts as changed
 *
 * The branch diff against `origin/main` (via `merge-base`, the same base
 * `check-missing-tests.ts` uses), **plus everything uncommitted** — staged, unstaged and untracked.
 * The uncommitted half is not an extra: this runs mid-`/pr-gates`, where fixes are sitting in the
 * working tree precisely because they have not been amended in yet, and a gate that could not see
 * them would report clean on code nobody checked.
 *
 * ## Exit codes
 *
 *   0 — ran, and both tools were clean (or there was nothing in scope to run them on)
 *   1 — a tool reported a problem, or the check could not establish what changed
 *
 * That second case is loud on purpose, the `check-missing-tests.ts` posture: a run that cannot
 * work out a base has no opinion about this branch, and printing a cheerful nothing is how a blind
 * check gets copied into a summary as a pass.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import v8 from 'node:v8';

/** Run from the repo root by npm, the same assumption every other `scripts/ci` check makes. */
const ROOT = process.cwd();

/** Files ESLint is configured for. Anything else is Prettier's problem alone. */
const LINTABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Files Prettier is handed — an allowlist, and it has to be.
 *
 * `prettier --check .` walks a directory and silently skips what it cannot parse, but a file named
 * **explicitly** on the command line with no inferable parser is a hard error ("No parser could be
 * inferred"), which fails the whole run. Since this check exists to name files explicitly, a
 * blocklist is the wrong shape: it was `/\.prisma$/` at first, and every branch that touched
 * `Dockerfile`, `.nvmrc`, `.npmrc`, `nginx.conf`, a `.husky/` hook, a shell script or a `.csv`
 * fixture would have failed `validate:changed` with a formatting error `validate` never produces.
 *
 * `.prisma` is absent because it has no Prettier parser at all; it is covered by the chain's
 * `format:prisma:check` step instead.
 */
const FORMATTABLE =
  /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json|jsonc|json5|md|mdx|css|scss|less|html|vue|yml|yaml|graphql|gql|hbs)$/;

/**
 * The side-effecting seams, injected so the decision logic can be tested without a git repository,
 * a filesystem, or two spawned toolchains. The defaults are the real thing; only tests pass others.
 */
export interface Deps {
  /** Run git, returning stdout, or `null` when it exited non-zero. */
  git: (args: string[]) => string | null;
  /** Does this repo-relative path exist on disk? */
  exists: (file: string) => boolean;
  /** Run one tool over a file list; returns its exit status. */
  run: (entrypoint: string, args: string[], files: string[]) => number;
  log: (message: string) => void;
  error: (message: string) => void;
}

function gitSync(args: string[]): string | null {
  const out = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return out.status === 0 ? out.stdout : null;
}

/** Split a NUL-delimited git listing, dropping the trailing empty entry. */
export function lines(raw: string | null): string[] {
  return (raw ?? '').split('\0').filter((v) => v.length > 0);
}

/**
 * Every path this branch touched that still exists on disk, or `null` if that could not be
 * established.
 *
 * The branch diff is **required**, not best-effort. An unresolvable base (a typo'd `--base`, a
 * stale `origin/main`) makes that `git diff` fail, and the uncommitted and untracked listings on
 * their own would still return a plausible-looking handful of files — a run that checked a fraction
 * of the branch and printed the same cheerful "all clean" as a real one. So a failed diff is `null`
 * and the caller exits non-zero; the other two listings are additive and a failure there is treated
 * the same way, since each is a way of not-looking.
 *
 * Deleted files are filtered by existence rather than by parsing status letters: a path can be
 * deleted in the branch diff and re-created in the working tree (or the reverse), and the only
 * question either tool has is whether there is a file there now.
 */
export function changedFiles(base: string, deps: Pick<Deps, 'git' | 'exists'>): string[] | null {
  // Committed on this branch; uncommitted (staged and unstaged, in one pass against HEAD); and
  // untracked-but-not-ignored, for a brand-new file nobody has `git add`ed yet.
  const listings = [
    deps.git(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', `${base}...HEAD`]),
    deps.git(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', 'HEAD']),
    deps.git(['ls-files', '--others', '--exclude-standard', '-z']),
  ];
  if (listings.some((out) => out === null)) return null;

  const found = new Set<string>(listings.flatMap((out) => lines(out)));
  return [...found].filter((file) => deps.exists(file)).sort();
}

/**
 * Which of the changed files each tool gets.
 *
 * Pure, and separated from {@link main} because it is the one piece of this check that decides
 * something rather than plumbing something: a file Prettier cannot parse fails the whole run when
 * it is named explicitly, and a `.md` file reaching ESLint is a wasted process. Both lists are
 * allowlists — a branch touching a `Dockerfile` must come back clean, not error.
 */
export function partition(files: readonly string[]): { lintable: string[]; formattable: string[] } {
  return {
    lintable: files.filter((f) => LINTABLE.test(f)),
    formattable: files.filter((f) => FORMATTABLE.test(f)),
  };
}

/**
 * The heap cap for a type-aware ESLint run, in MB.
 *
 * This is `scripts/run-capped.mjs`'s logic, restated rather than imported — that module ends in a
 * guarded top-level `await main()`, and `tsx` transpiles this file to CJS, where importing an async
 * module throws `ERR_REQUIRE_ASYNC_MODULE`. The number is not free-floating: a test asserts it
 * still equals that module's `DEFAULT_HEAP_MB`, so the two cannot drift apart quietly.
 *
 * Same three rules as the original. An explicit `--max-old-space-size` anywhere in `NODE_OPTIONS`
 * wins outright (a fork that measured its own value keeps it); the ask is clamped to a fraction of
 * physical memory, because a ceiling above real RAM turns a clean V8 abort into an OS OOM kill;
 * and it is floored at whatever Node would have chosen unaided, so on a small machine this is a
 * no-op rather than a downgrade.
 */
export const DEFAULT_HEAP_MB = 6144;

/** Never hand the machine a ceiling it cannot back. Mirrors `run-capped.mjs`. */
const MEMORY_FRACTION = 0.75;
const MB = 1024 * 1024;

export function heapCapMb(
  rawRequest = process.env.NODE_HEAP_MB,
  totalMemBytes = totalmem(),
  nodeDefaultMb = v8.getHeapStatistics().heap_size_limit / MB
): number {
  const raw = Number(rawRequest);
  const requested = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_HEAP_MB;
  const affordable = Math.floor((totalMemBytes * MEMORY_FRACTION) / MB);
  return Math.max(Math.round(nodeDefaultMb), Math.min(requested, affordable));
}

/** Matched on the flag name only — both `=N` and a following token mean someone chose a number. */
export function hasHeapCap(nodeOptions: string | undefined): boolean {
  return /(^|\s)--max[-_]old[-_]space[-_]size(\s|=|$)/.test(nodeOptions ?? '');
}

/**
 * Run a tool from its plain `.js` entrypoint, never the `node_modules/.bin` shim.
 *
 * This is the one thing `run-capped.mjs` warns about in its own header: on Windows a `.bin` shim is
 * a `.cmd`, which needs `shell: true`, which joins argv into a single `cmd.exe` string — and this
 * caller's argv is git-derived filenames. Spawning `node <entrypoint>` with an argv array needs no
 * shell on any platform, so a path containing `&` or a space is inert. That is also why this does
 * not simply shell out to `run-capped.mjs`: its CLI is documented as safe only for the static argv
 * its `package.json` callers pass.
 */
export function runTool(entrypoint: string, args: string[], files: string[]): number {
  const env = hasHeapCap(process.env.NODE_OPTIONS)
    ? process.env
    : {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--max-old-space-size=${heapCapMb()}`,
      };

  const result = spawnSync(process.execPath, [entrypoint, ...args, ...files], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  return result.status ?? 1;
}

/** The real seams. Overridden wholesale in tests; never partially, so a test cannot spawn by accident. */
export const REAL_DEPS: Deps = {
  git: gitSync,
  exists: (file) => existsSync(join(ROOT, file)),
  run: runTool,
  // `no-console` is off for `scripts/**` — this IS the CLI's output.
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

export function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: Deps = REAL_DEPS
): number {
  const explicit = argv.indexOf('--base');
  const requested = explicit === -1 ? null : argv[explicit + 1];
  if (explicit !== -1 && (!requested || requested.startsWith('-'))) {
    deps.error('`--base` needs a revision.');
    return 1;
  }

  const base = requested ?? deps.git(['merge-base', 'origin/main', 'HEAD'])?.trim();
  if (!base) {
    deps.error('validate:changed — could not run: no base revision available.');
    deps.error('Run `git fetch origin main` and re-run, or pass `--base <ref>`.');
    return 1;
  }

  const files = changedFiles(base, deps);
  if (files === null) {
    // Same posture as the missing base above: a scan that could not see the branch has no opinion
    // about it, and saying nothing is how a blind check gets banked as a clean one.
    deps.error(`validate:changed — could not run: \`git diff\` failed against base "${base}".`);
    deps.error('Check the revision exists (`git fetch origin main` if the local ref is stale).');
    return 1;
  }

  const { lintable, formattable } = partition(files);

  deps.log(
    `Scoped to ${files.length} changed file${files.length === 1 ? '' : 's'} vs ${base.slice(0, 9)} ` +
      `(${lintable.length} lintable, ${formattable.length} formattable).`
  );

  if (files.length === 0) {
    // Not a failure: the branch may be docs-and-schema only, or already merged. The full steps in
    // the `validate:changed` chain still ran, and said so.
    deps.log('Nothing in scope for ESLint or Prettier.');
    return 0;
  }

  let status = 0;

  if (lintable.length > 0) {
    status =
      deps.run(
        join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
        ['--cache', '--cache-strategy', 'content', '--cache-location', '.next/cache/eslint/'],
        lintable
      ) || status;
  }

  if (formattable.length > 0) {
    // Both tools run even when the first fails: two separate reports in one pass beats making
    // someone re-run to discover the second problem.
    status =
      deps.run(
        join(ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs'),
        [
          '--check',
          '--cache',
          '--cache-strategy',
          'content',
          '--cache-location',
          '.next/cache/.prettiercache',
        ],
        formattable
      ) || status;
  }

  return status;
}

// Only when run as a CLI — this file exports `DEFAULT_HEAP_MB` for the drift test, and importing
// it must not run the check. Same guard as `check-missing-tests.ts`.
if (process.argv[1] !== undefined && process.argv[1].endsWith('validate-changed.ts')) {
  process.exitCode = main();
}
