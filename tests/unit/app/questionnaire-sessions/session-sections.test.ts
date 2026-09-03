/**
 * Unit: reading a finished session's sections back (P21).
 *
 * Anti-green-bar: what is pinned here is the INERT ANSWER, not the happy path. Both callers (the
 * admin timeline and the report) mock this module, so without this file the three branches that
 * carry the feature's central promise — "off is inert" — are exercised nowhere but the live smoke,
 * which does not run in CI.
 *
 * The three are genuinely different causes with one required answer:
 *
 *  - the session no longer exists, so there is nothing to resolve;
 *  - it exists but was never sectioned (the version never opted in, or fewer than two sections
 *    resolved), which is every session predating the feature;
 *  - it resolved as sectioned but banked no run, which cannot be reported on.
 *
 * All three must produce {@link NO_SESSION_SECTIONS} rather than a partial answer, because every
 * caller reads that ONE flag and falls back to its flat behaviour.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/session-sections.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ buildTurnContext: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/turn-context', () => ({
  buildTurnContext: mocks.buildTurnContext,
}));

import {
  resolveSessionSections,
  NO_SESSION_SECTIONS,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/session-sections';
import type { InterviewSection } from '@/lib/app/questionnaire/sections/types';
import type { SectionRun } from '@/lib/app/questionnaire/sections/run';

const section = (key: string, label: string): InterviewSection => ({
  key,
  label,
  ordinal: 0,
  source: 'topics',
  questionKeys: [],
  dataSlotKeys: [],
});

const run: SectionRun = {
  v: 1,
  activeKey: 'ctx',
  sections: [
    {
      key: 'ctx',
      status: 'in_progress',
      openedAtTurn: 1,
      closedAtTurn: null,
      closeReason: null,
      reopenCount: 0,
      turnsSpent: 2,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSessionSections', () => {
  it('resolves to the inert answer for a session that no longer exists, rather than throwing', async () => {
    // Both callers are decorating a surface they are already rendering. Neither should fail over a
    // section timeline it turns out has nothing to say.
    mocks.buildTurnContext.mockResolvedValue(null);
    await expect(resolveSessionSections('gone')).resolves.toEqual(NO_SESSION_SECTIONS);
  });

  it('resolves to the inert answer for a session that was never sectioned', async () => {
    mocks.buildTurnContext.mockResolvedValue({
      sectionState: { active: false, sections: [], run: null },
    });
    await expect(resolveSessionSections('sess-1')).resolves.toEqual(NO_SESSION_SECTIONS);
  });

  it('resolves to the inert answer when sections are active but no run was banked', async () => {
    // A sectioned version whose respondent never took a turn. There is a section list, but nothing
    // happened in it, and a caller handed sections with a null run would have to invent a status.
    mocks.buildTurnContext.mockResolvedValue({
      sectionState: { active: true, sections: [section('ctx', 'Context')], run: null },
    });
    await expect(resolveSessionSections('sess-1')).resolves.toEqual(NO_SESSION_SECTIONS);
  });

  it('carries the resolved sections and the run through when the interview was sectioned', async () => {
    const sections = [section('ctx', 'Context'), section('prob', 'Problem')];
    mocks.buildTurnContext.mockResolvedValue({ sectionState: { active: true, sections, run } });

    const resolved = await resolveSessionSections('sess-1');

    // The LABELS are the point: the stored run holds keys only, which is why this goes through the
    // context seam instead of reading `sectionRun` directly.
    expect(resolved.active).toBe(true);
    expect(resolved.sections.map((s) => s.label)).toEqual(['Context', 'Problem']);
    expect(resolved.run).toBe(run);
  });

  it('goes through the one section seam, asking it for exactly this session', async () => {
    mocks.buildTurnContext.mockResolvedValue(null);
    await resolveSessionSections('sess-42');
    expect(mocks.buildTurnContext).toHaveBeenCalledWith('sess-42');
  });
});
