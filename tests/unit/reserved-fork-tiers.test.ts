/**
 * Unit Tests: the reserved fork tiers stay empty upstream
 *
 * CLAUDE.md and CUSTOMIZATION.md both promise that "Sunrise core never creates
 * files or tables under either tier", which is what lets a fork's files there
 * merge cleanly on `git merge vX.Y.Z`. Until now that promise was prose with
 * nothing enforcing it — and the cost of breaking it is not a conflict a
 * maintainer resolves, it is a platform file landing on top of fork code that
 * two forks are already shipping (`components/app/**` in ConQuest and Reclaim
 * Your Week, discovered while fixing #561).
 *
 * Two kinds of reservation, and the distinction is the point:
 *
 *   - **Empty reservations** — Sunrise ships nothing at all. A fork creates
 *     whatever structure suits it. Asserted here.
 *   - **Scaffold tiers** (`lib/app/**`) — Sunrise ships files that export
 *     `null` or an empty function, once, and then does not change them. Those
 *     legitimately have content, so they are deliberately NOT asserted empty.
 *
 * @see CUSTOMIZATION.md "The app/platform model"
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();

/**
 * Directories Sunrise reserves but never populates. A `.gitkeep` (or a
 * `README`) explaining the reservation is the only permitted content — the
 * directory has to exist in git for a fork to find it.
 */
const EMPTY_RESERVATIONS = [
  'components/app',
  'components/framework',
  'lib/framework',
  '.context/framework',
  '.context/app',
] as const;

const PLACEHOLDER_NAMES = new Set(['.gitkeep', '.gitignore', 'README.md']);

/** Every file under `dir`, repo-relative, recursively. */
function filesUnder(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, rel))) {
      const childRel = join(rel, entry);
      if (statSync(join(REPO_ROOT, childRel)).isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk(dir);
  return out;
}

describe('reserved fork tiers', () => {
  it.each(EMPTY_RESERVATIONS)('%s holds nothing but a placeholder', (dir) => {
    const unexpected = filesUnder(dir).filter((f) => !PLACEHOLDER_NAMES.has(f.split('/').pop()!));

    expect(
      unexpected,
      `Sunrise core must not create files under the reserved tier "${dir}". ` +
        `A fork already has its own files there, and an upgrade would land these on top of them. ` +
        `Platform code belongs in a named domain folder instead — see CUSTOMIZATION.md ` +
        `"The app/platform model".`
    ).toEqual([]);
  });

  it('components/app exists in git so a fork can find it', () => {
    // An unreserved-but-undocumented directory is how two forks ended up
    // inventing `components/app/` independently. It has to be discoverable.
    expect(existsSync(join(REPO_ROOT, 'components/app'))).toBe(true);
    expect(filesUnder('components/app').length).toBeGreaterThan(0);
  });

  it('prisma/schema/app.prisma declares no models', () => {
    // The same promise, in the file the docs single out as "ships empty".
    const src = readFileSync(join(REPO_ROOT, 'prisma/schema/app.prisma'), 'utf8');
    const declarations = src
      .split('\n')
      .filter((line) => /^\s*(model|enum|type|view)\s+\w+/.test(line));

    expect(
      declarations,
      'prisma/schema/app.prisma is fork-reserved and ships empty; platform ' +
        'app-domain models belong in prisma/schema/platform.prisma.'
    ).toEqual([]);
  });

  it('the reservation is documented in both places a fork would look', () => {
    // Prose and enforcement drifting apart is the failure this whole file
    // exists to prevent, so assert they agree.
    const claude = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    const customization = readFileSync(join(REPO_ROOT, 'CUSTOMIZATION.md'), 'utf8');

    for (const doc of [claude, customization]) {
      expect(doc).toContain('components/app');
      expect(doc).toContain('components/framework');
    }
  });
});
