/**
 * resolveSessionPersonas (F-persona) — `lib/app/questionnaire/persona/resolve.ts`.
 *
 * The DB seam for the respondent persona menu. Pins: `null` on a missing session; the client menu
 * strips the tone/prompt prose (only key/label/description ship); `enabled` requires the per-version
 * toggle AND at least two personas; an unconfigured library resolves to the built-ins; and the
 * session's `selectedPersonaKey` + the config default flow through.
 *
 * @see lib/app/questionnaire/persona/resolve.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireSession: { findUnique: dbMock.findUnique } },
}));

import { resolveSessionPersonas } from '@/lib/app/questionnaire/persona/resolve';
import { BUILT_IN_PERSONAS } from '@/lib/app/questionnaire/persona/presets';

function row(over: {
  personas?: unknown;
  personaSelection?: unknown;
  selectedPersonaKey?: string | null;
}) {
  return {
    selectedPersonaKey: over.selectedPersonaKey ?? null,
    version: {
      config: {
        personas: over.personas ?? [],
        personaSelection: over.personaSelection ?? { enabled: true, defaultPersonaKey: 'x' },
      },
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('resolveSessionPersonas', () => {
  it('returns null when the session does not resolve', async () => {
    dbMock.findUnique.mockResolvedValue(null);
    expect(await resolveSessionPersonas('missing')).toBeNull();
  });

  it('fills an unconfigured library with the built-ins, tone stripped', async () => {
    dbMock.findUnique.mockResolvedValue(
      row({ personas: [], personaSelection: { enabled: true, defaultPersonaKey: 'neutral-coach' } })
    );
    const out = await resolveSessionPersonas('sess-1');
    expect(out?.personas.map((p) => p.key)).toEqual(BUILT_IN_PERSONAS.map((p) => p.key));
    // No tone / prompt prose leaks to the client.
    for (const p of out!.personas) {
      expect(Object.keys(p).sort()).toEqual(['description', 'key', 'label']);
    }
  });

  it('is enabled only when the toggle is on AND there are ≥2 personas', async () => {
    dbMock.findUnique.mockResolvedValue(
      row({ personaSelection: { enabled: true, defaultPersonaKey: 'neutral-coach' } })
    );
    expect((await resolveSessionPersonas('s'))?.enabled).toBe(true); // built-ins → 8 personas

    dbMock.findUnique.mockResolvedValue(
      row({ personaSelection: { enabled: false, defaultPersonaKey: 'neutral-coach' } })
    );
    expect((await resolveSessionPersonas('s'))?.enabled).toBe(false);
  });

  it('flows the session choice and the config default through', async () => {
    dbMock.findUnique.mockResolvedValue(
      row({
        selectedPersonaKey: 'comedian',
        personaSelection: { enabled: true, defaultPersonaKey: 'philosopher' },
      })
    );
    const out = await resolveSessionPersonas('sess-1');
    expect(out?.selectedPersonaKey).toBe('comedian');
    expect(out?.defaultPersonaKey).toBe('philosopher');
  });
});
