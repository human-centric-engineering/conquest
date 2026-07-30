/**
 * Invariant: `structured-completion.ts` persists nothing (#472).
 *
 * A downstream privacy claim rests on this. A fork categorises calendar-event
 * titles into aggregate time buckets with one structured completion, stores only
 * the per-bucket hour totals, and tells its users in as many words that no
 * meeting title, attendee or description is ever retained.
 *
 * That was previously only *incidentally* true. The module's docstring promised
 * layering neutrality — "no evaluation coupling, no Next.js imports" — which says
 * nothing about writes. Adding prompt logging for debugging, or completion
 * persistence for eval replay, would have been consistent with everything the
 * file said about itself and would have broken the fork's user-facing claim
 * without touching a line of the fork's code.
 *
 * This test makes the guarantee enforceable. It is a source-level check on
 * purpose: a behavioural test can only prove that the paths it happens to
 * exercise do not write, whereas the risk is a *new* path added later. Reading
 * the source catches the import the moment it appears.
 *
 * If a future feature genuinely needs to persist here, that is a breaking change
 * to a documented guarantee — give it an opt-in flag defaulting to off and a
 * CHANGELOG entry. Do not delete this test to make a build pass.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODULE_PATH = 'lib/orchestration/llm/structured-completion.ts';

/** Anything that could reach a datastore from this module. */
const FORBIDDEN_PERSISTENCE_TOKENS = [
  '@/lib/db/client',
  '@prisma/client',
  'PrismaClient',
  'prisma.',
  // A transaction client handed in from elsewhere would bypass the import check.
  'Prisma.TransactionClient',
  // Object storage / cache backends are persistence too.
  '@/lib/storage',
  'ioredis',
];

describe(`${MODULE_PATH} — no-persistence invariant (#472)`, () => {
  const source = readFileSync(join(process.cwd(), MODULE_PATH), 'utf8');

  /**
   * Strip comments before scanning. The docstring legitimately *discusses*
   * `prisma.*` while explaining the guarantee, and matching that would make the
   * test fail for documenting itself.
   */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  it.each(FORBIDDEN_PERSISTENCE_TOKENS)('does not reference %s', (token) => {
    expect(code).not.toContain(token);
  });

  it('imports no database or storage module', () => {
    // Belt and braces over the token list: catch any import whose path looks
    // like a datastore, including one nobody thought to enumerate above.
    const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const suspicious = imports.filter((p) =>
      /(^|\/)(db|database|prisma|storage|redis|cache)(\/|$)/i.test(p ?? '')
    );
    expect(suspicious).toEqual([]);
  });

  it('still states the guarantee in its own docstring', () => {
    // If someone removes the contract from the docs, the code-level check alone
    // would leave the next author unaware there is a promise to keep.
    expect(source).toContain('PERSISTS NOTHING');
    expect(source).toContain('#472');
  });
});
