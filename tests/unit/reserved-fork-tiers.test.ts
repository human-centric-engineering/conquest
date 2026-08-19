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
 * Reserved directories that must EXIST in git — a reservation a fork cannot
 * find is not a reservation. Both were invented independently by forks before
 * Sunrise named them, which is the whole argument for shipping the directory
 * rather than only writing it down.
 */
const MATERIALISED_RESERVATIONS = ['components/app', 'components/framework'] as const;

/**
 * Reserved namespaces Sunrise does not currently ship a placeholder for. Still
 * asserted empty — the promise is "core creates nothing here" either way — but
 * NOT asserted to exist, because they never have.
 *
 * The distinction matters: without it these rows pass vacuously (a missing
 * directory trivially contains no platform files), so the test would report
 * success on a reservation nobody can act on.
 */
const UNMATERIALISED_RESERVATIONS = [
  'lib/framework',
  '.context/framework',
  '.context/app',
] as const;

const EMPTY_RESERVATIONS = [...MATERIALISED_RESERVATIONS, ...UNMATERIALISED_RESERVATIONS] as const;

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

  it.each(MATERIALISED_RESERVATIONS)('%s exists in git so a fork can find it', (dir) => {
    // An unreserved-but-undocumented directory is how two forks ended up
    // inventing `components/app/` independently, and a third inventing
    // `components/hub/`. Writing the reservation down is not enough — the
    // directory has to be there when someone goes looking.
    expect(
      existsSync(join(REPO_ROOT, dir)),
      `"${dir}" is named as a reserved tier in CLAUDE.md and CUSTOMIZATION.md but ` +
        `does not exist, so nobody can find it. Ship a .gitkeep explaining the reservation.`
    ).toBe(true);
    expect(filesUnder(dir).length).toBeGreaterThan(0);
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
