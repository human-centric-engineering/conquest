// Lints the tree in N sequential chunks, in ONE process at a time.
//
// WHY THIS EXISTS
// Type-aware ESLint peaks at 4.70GB on this repo against a `CI_NODE_HEAP_MB`
// of 6144, and this repo is going private — where `ubuntu-latest` is a 7GB
// machine, not 16GB. It already OOM'd on #273 (a `typescript-eslint` bump,
// which invalidates every cache entry and so forces a cold whole-tree run).
// Raising the ceiling is not available: the ceiling is the machine now.
//
// THE MEASUREMENT THIS IS BUILT ON (28 Aug 2026, serial, worst of 2 runs):
//
//     files linted   peak RSS
//              1     2.64 GB   <- floor: the TypeScript Program
//            565     3.02 GB
//          1,131     3.50 GB
//          2,262     3.91 GB
//          4,525     4.70 GB   <- one whole-tree pass, what this replaces
//
// 56% of the cost is a FLOOR that no amount of splitting removes. Type-aware
// linting needs types for the file under test, types come from the whole
// project graph, so ESLint builds a Program over every file in `tsconfig.json`
// before it lints a line. (For scale: `tsc --noEmit` type-checks the entire
// repo in 2.26GB — ESLint costs more to lint ONE file, because
// typescript-eslint re-materialises TypeScript's AST into ESTree, a second AST
// per file, and ESLint layers scope analysis on that.) The other 44% is
// marginal per-file cost, and that is what chunking divides.
//
// WHY SEQUENTIAL CHUNKS AND NOT PARALLEL JOBS. Each chunk is its own `eslint`
// process, so the memory is released when it exits and the job's peak is the
// LARGEST chunk rather than the sum. That gets sharding's memory profile
// without sharding's bill: a matrix of N jobs pays N checkouts and N `npm ci`s,
// which on a private repo is metered runner time. One job that takes longer
// beats N jobs that each pay setup. The cost is wall-clock, and it is the right
// currency to pay in here.
//
// GETTING THE FILE LIST RIGHT IS THE WHOLE SAFETY PROPERTY. A chunk plan that
// omits files does not fail — it passes, faster, having linted less. An earlier
// draft of this change split by directory name and silently dropped 139 files
// (`emails/`, `hooks/`, `types/`, `prisma/`, `proxy.ts`, every root config).
// So the list is derived from ESLint's OWN ignore logic via `isPathIgnored`
// rather than from a roster, and `tests/unit/scripts/chunked-lint.test.ts`
// asserts the chunks partition it exactly — every file once, none lost.
//
// PLAIN .mjs, NO BUILD STEP — same rule as `run-capped.mjs` and
// `dev-server.mjs`. It runs from `npm run lint:ci` in a fresh checkout.
//
// NOT ROUTED THROUGH `run-capped.mjs`, deliberately. That wrapper spawns with
// `shell: true` on Windows and quotes only the command, so a caller whose argv
// is filenames hands `cmd.exe` whatever `&` or `^` a path contains — its own
// docblock names this as the reason `lint-staged` calls eslint directly. This
// script's argv IS filenames, so it spawns with `shell: false` and applies the
// heap cap itself (`withHeapCap`), which is the one thing the wrapper would
// otherwise have done for it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ESLint } from 'eslint';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_WINDOWS = process.platform === 'win32';

/** Extensions the flat config has `files` blocks for. */
export const LINTABLE = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'];

/** Chunks when nothing asks for a number. Measured on a runner at cap 6144:
 * 1 chunk OOMs, 2 -> 5.75GB, 4 -> 5.20GB, 6 -> 4.98GB. */
export const DEFAULT_CHUNKS = 4;

/** Cap applied when the environment carries none. Matches `run-capped.mjs`'s
 * value, and comfortably clears the measured 2.64GB floor. */
export const DEFAULT_HEAP_MB = 6144;

/**
 * Parse `LINT_CHUNKS`. A garbage value falls back rather than failing the run:
 * refusing to lint because an unrelated variable is malformed trades a small
 * problem for a bigger one. Same rule as `run-capped.mjs`'s `NODE_HEAP_MB`.
 *
 * @param {string | undefined} raw
 * @returns {number}
 */
export function parseChunks(raw) {
  if (raw === undefined || raw === '') return DEFAULT_CHUNKS;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CHUNKS;
}

/**
 * Group key for a file at a given depth — its first `depth` path segments.
 *
 * @param {string} file
 * @param {number} depth
 * @returns {string}
 */
export function groupKey(file, depth = 2) {
  const parts = file.split('/');
  if (parts.length <= 1) return '.';
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
}

/**
 * Bucket `items` by directory, deepening any bucket bigger than `target`.
 *
 * A FIXED DEPTH DOES NOT WORK on this tree. At depth 2, `tests/unit` alone is
 * 1,649 of 4,527 files — one indivisible group, so every plan had a chunk more
 * than a third of the tree and that chunk set the peak on its own. Deepening
 * only the oversized buckets keeps small directories whole (locality preserved
 * where it is free) while splitting the few that are too big to pack.
 *
 * Terminates because each pass either deepens a bucket or leaves it alone, and
 * a bucket stops deepening once its files have no deeper segment to split on —
 * which is also why a directory of 2,000 sibling files stays one bucket rather
 * than looping forever.
 *
 * @param {readonly string[]} items
 * @param {number} target Desired maximum bucket size.
 * @returns {Map<string, string[]>}
 */
export function adaptiveGroups(items, target) {
  /** @type {Map<string, string[]>} */
  let groups = new Map();
  for (const item of items) {
    const key = groupKey(item, 1);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  for (let depth = 2; depth <= 8; depth++) {
    let split = false;
    /** @type {Map<string, string[]>} */
    const next = new Map();
    for (const [key, files] of groups) {
      // Only deepen a bucket that is both too big AND actually divisible: some
      // file in it must have a segment beyond the current depth.
      const divisible = files.some((f) => f.split('/').length > depth);
      if (files.length > target && divisible) {
        split = true;
        for (const file of files) {
          const k = groupKey(file, depth);
          const bucket = next.get(k);
          if (bucket) bucket.push(file);
          else next.set(k, [file]);
        }
      } else {
        next.set(key, files);
      }
    }
    groups = next;
    if (!split) break;
  }
  return groups;
}

/**
 * Split `items` into at most `count` chunks, KEEPING EACH DIRECTORY TOGETHER.
 *
 * LOCALITY IS THE WHOLE POINT, and the first version of this function got it
 * exactly backwards. It striped files round-robin to balance the chunks, on the
 * theory that no chunk should inherit a heavy import closure. Measured, that
 * made things WORSE than not chunking at all (3.98GB striped against 3.28GB in
 * one pass): striping guarantees every chunk touches every corner of the tree,
 * so every chunk loads nearly the whole type graph and each one pays close to
 * the full cost.
 *
 * What a chunk actually costs is its IMPORT CLOSURE, not its file count.
 * `eslint prisma` — 98 files — peaks at 1.92GB, while a single file in
 * `lib/api` peaks at 2.64GB, because the second reaches most of the app and the
 * first does not. So chunks are built from whole directories, and the win comes
 * from chunks whose closures barely overlap.
 *
 * Greedy largest-first bin packing: buckets are sorted by size and each is
 * placed in the currently-smallest bin. That balances file counts without
 * splitting a directory needlessly.
 *
 * @param {readonly string[]} items
 * @param {number} count
 * @returns {string[][]}
 */
export function chunk(items, count) {
  if (items.length === 0) return [];

  const n = Math.max(1, count);
  const groups = adaptiveGroups(items, Math.ceil(items.length / n));
  const bins = Array.from({ length: Math.min(n, groups.size) }, () => /** @type {string[]} */ ([]));

  // Largest bucket first, into the emptiest bin. Size then key, so the plan is
  // deterministic — the same commit chunks identically on every runner, which
  // is what makes a chunk failure reproducible.
  const ordered = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
  );
  for (const [, files] of ordered) {
    let smallest = bins[0];
    for (const bin of bins) if (bin.length < smallest.length) smallest = bin;
    smallest.push(...files);
  }

  return bins.map((b) => b.sort()).filter((f) => f.length > 0);
}

/**
 * Every file ESLint would lint, repo-relative and sorted.
 *
 * Sourced from `git ls-files` (tracked files only — an untracked scratch file
 * is not something CI should fail on) filtered by ESLint's own
 * `isPathIgnored`. Deriving it from ESLint means the flat config's `ignores`
 * are honoured without this script re-implementing them, which is where a
 * hand-rolled equivalent would drift.
 *
 * Sorted so the chunk plan is deterministic: the same commit produces the same
 * chunks on every runner, which is what makes a failure reproducible.
 *
 * @param {object} [deps]
 * @returns {Promise<string[]>}
 */
export async function lintTargets(deps = {}) {
  const {
    listFiles = () =>
      execFileSync('git', ['-C', ROOT, '-c', 'core.quotePath=false', 'ls-files'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    eslint = new ESLint({ cwd: ROOT }),
    // Injected for the same reason `listFiles` is: the enumeration logic has to
    // be testable without a real tree on disk.
    exists = existsSync,
  } = deps;

  const candidates = listFiles()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && LINTABLE.some((ext) => line.endsWith(ext)));

  const kept = [];
  for (const file of candidates) {
    const absolute = join(ROOT, file);
    // `git ls-files` reads the INDEX, so a file deleted from the working tree
    // but not yet staged is still listed. Handing that path to eslint exits 2
    // ("No files matching the pattern were found") and fails the whole chunk
    // for a reason that has nothing to do with lint — which is exactly the
    // state a developer is in while reproducing a CI failure locally.
    if (!exists(absolute)) continue;
    if (!(await eslint.isPathIgnored(absolute))) kept.push(file);
  }
  return kept.sort();
}

/**
 * How to invoke eslint: `[command, ...leadingArgs]`.
 *
 * Runs eslint's JS entry point under `process.execPath` rather than the
 * `.bin` shim. The shim is a `.cmd` on Windows, and since the CVE-2024-27980
 * fix (Node >= 18.20.2 / 20.12.2 — this repo requires 24) `spawn` REFUSES a
 * `.bat`/`.cmd` target unless `shell: true`. We cannot pass `shell: true`,
 * because the argv is filenames and a shell would interpret whatever `&` or
 * `^` a path contains. So the Windows branch of a `.bin`-based resolver is
 * unreachable by construction: every chunk would fail with `spawn EINVAL`.
 *
 * Going through `execPath` sidesteps that, and keeps one code path on every
 * platform rather than one that is only ever exercised on two of them.
 *
 * @returns {[string, ...string[]]}
 */
export function resolveEslintCommand() {
  const entry = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (existsSync(entry)) return [process.execPath, entry];
  // Fallback for a global install; still never a shell.
  return [join(ROOT, 'node_modules', '.bin', IS_WINDOWS ? 'eslint.cmd' : 'eslint')];
}

/**
 * The child's environment, with an old-space cap appended when nothing has set
 * one.
 *
 * NOT COSMETIC, and this file's header used to CLAIM this behaviour before the
 * code did — a review caught the discrepancy. Without it `lint:ci` inherits
 * Node's default heap, which is derived from machine RAM and is roughly 2GB on
 * an 8GB box: BELOW this script's own measured 2.64GB floor, so every chunk
 * would abort with exit 134 — the exact failure it exists to prevent. In CI the
 * workflow's `NODE_OPTIONS` supplies a cap and this stands down; anywhere else
 * (a developer reproducing a CI lint failure, a fork on a different runner)
 * there is nothing else to supply one.
 *
 * Matches `run-capped.mjs`: append to `NODE_OPTIONS` rather than passing
 * `--max-old-space-size` on the command line, and only when no cap is already
 * present, so an explicit value always wins.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function withHeapCap(env) {
  if (/(^|\s)--max[-_]old[-_]space[-_]size(\s|=|$)/.test(env.NODE_OPTIONS ?? '')) {
    return { ...env };
  }
  const existing = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : '';
  return { ...env, NODE_OPTIONS: `${existing}--max-old-space-size=${DEFAULT_HEAP_MB}` };
}

/**
 * Run one chunk. Resolves to its exit code rather than rejecting, so a failing
 * chunk does not abandon the ones after it — a lint run that stops at the first
 * failing chunk reports a fraction of the problems and sends the author round
 * the loop again for each one.
 *
 * @param {readonly string[]} files
 * @param {readonly string[]} passthrough
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export function runChunk(files, passthrough, deps = {}) {
  const { spawnFn = spawn, env = process.env, command = resolveEslintCommand() } = deps;
  const [bin, ...leading] = command;
  return new Promise((resolveCode) => {
    const child = spawnFn(bin, [...leading, ...files, ...passthrough], {
      cwd: ROOT,
      env: withHeapCap(env),
      stdio: 'inherit',
      // `false` even on Windows: the argv is filenames. See the header.
      shell: false,
    });
    child.on('error', (error) => {
      console.error(`Failed to start eslint: ${error.message}`);
      resolveCode(1);
    });
    child.on('exit', (code) => resolveCode(code ?? 1));
  });
}

/**
 * @param {string[]} [argv] Passthrough args for eslint (e.g. `--cache`).
 * @param {object} [deps]
 * @returns {Promise<number>} Worst exit code across the chunks.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    targets = await lintTargets(),
    chunks = parseChunks((deps.env ?? process.env).LINT_CHUNKS),
    run = runChunk,
    log = console.log,
    env = process.env,
  } = deps;

  if (targets.length === 0) {
    log('chunked-lint: no lintable files found — nothing to do.');
    return 0;
  }

  const plan = chunk(targets, chunks);
  log(`chunked-lint: ${targets.length} files in ${plan.length} sequential chunk(s).`);

  let worst = 0;
  for (const [i, files] of plan.entries()) {
    log(`chunked-lint: chunk ${i + 1}/${plan.length} — ${files.length} files`);
    const code = await run(files, argv, { env });
    if (code > worst) worst = code;
  }
  return worst;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}

export { ROOT };
