/**
 * Unit test: helpers on the evaluation run-routes seam (F5.3) — `parseStructureSnapshot`
 * (degrade-on-malform), `effectiveOp` (override wins, malformed-override fallback), and
 * `buildScopedFindingView`'s target stamping (terminal findings included).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// These helpers don't touch the DB, but the module imports the prisma client + structure loader
// at load time — stub both so the unit can import cleanly.
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/evaluation-structure', () => ({
  buildEvaluationStructure: vi.fn(),
}));

import {
  effectiveOp,
  parseStructureSnapshot,
  buildScopedFindingView,
  type FindingRow,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes';
import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';
import type { VersionStructureInput } from '@/lib/app/questionnaire/evaluation';

describe('parseStructureSnapshot', () => {
  it('returns null for an absent snapshot (pre-F5.3 run)', () => {
    expect(parseStructureSnapshot(null, 'run-1')).toBeNull();
    expect(parseStructureSnapshot(undefined, 'run-1')).toBeNull();
  });

  it('parses a valid snapshot and re-narrows the audience', () => {
    const snap = {
      goal: 'Goal',
      audience: { role: 'engineer', bogusField: 'dropped' },
      sections: [{ title: 'S', questions: [] }],
    };
    const parsed = parseStructureSnapshot(snap, 'run-1');
    expect(parsed).not.toBeNull();
    expect(parsed?.goal).toBe('Goal');
    expect(parsed?.audience).toEqual({ role: 'engineer' }); // unknown sub-field dropped
  });

  it('degrades a malformed snapshot to null (does not throw)', () => {
    expect(parseStructureSnapshot({ sections: 'not-an-array' }, 'run-1')).toBeNull();
  });
});

describe('effectiveOp', () => {
  it('returns the proposedEdit when there is no override', () => {
    expect(effectiveOp({ proposedEdit: { op: 'delete_question' }, editedOverride: null })).toEqual({
      op: 'delete_question',
    });
  });

  it('prefers a valid editedOverride over the judge proposedEdit', () => {
    expect(
      effectiveOp({
        proposedEdit: { op: 'delete_question' },
        editedOverride: { op: 'replace_prompt', prompt: 'Edited' },
      })
    ).toEqual({ op: 'replace_prompt', prompt: 'Edited' });
  });

  it('falls back to proposedEdit when the override is malformed', () => {
    expect(
      effectiveOp({ proposedEdit: { op: 'delete_question' }, editedOverride: { op: 'nonsense' } })
    ).toEqual({ op: 'delete_question' });
  });

  it('returns null when neither is a valid op', () => {
    expect(effectiveOp({ proposedEdit: null, editedOverride: null })).toBeNull();
  });
});

/** A minimal live structure so a question target has a section and position to resolve against. */
function structure(): VersionStructureInput {
  return {
    goal: 'Understand onboarding friction',
    audience: { expertiseLevel: 'intermediate', role: 'new hire' },
    sections: [
      {
        title: 'Background',
        questions: [
          { key: 'q_role', prompt: 'What is your role?', type: 'free_text', required: true },
        ],
      },
    ],
  };
}

function findingRow(over?: Partial<FindingRow>): FindingRow {
  return {
    id: 'f1',
    dimension: 'clarity',
    ordinal: 1,
    targetKey: 'q_role',
    severity: 'medium',
    proposedChange: 'Clarify the prompt',
    rationale: 'Ambiguous',
    sourceQuote: null,
    proposedEdit: { op: 'replace_prompt', prompt: 'What is your job title?' },
    editedOverride: null,
    applyInstruction: null,
    status: 'pending',
    decidedByUserId: null,
    decidedAt: null,
    appliedAt: null,
    appliedToVersionId: null,
    ...over,
  };
}

function scoped(over?: Partial<FindingRow>) {
  return {
    row: findingRow(over),
    versionId: 'v1',
    questionnaireId: 'qn-1',
    snapshot: structure(),
  };
}

describe('buildScopedFindingView — target stamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildEvaluationStructure).mockResolvedValue(structure());
  });

  it('names the question a pending finding is about', async () => {
    const view = await buildScopedFindingView(scoped());
    expect(view.target).toMatchObject({
      kind: 'question',
      key: 'q_role',
      sectionTitle: 'Background',
    });
  });

  it.each(['applied', 'declined'])('still names the question for a %s finding', async (status) => {
    // The terminal branch used to early-return before the structure was loaded, so an applied
    // finding rendered as a bare key chip. Staleness is meaningless once terminal; the target
    // is not — the reviewer still needs to know which question was changed.
    const view = await buildScopedFindingView(scoped({ status }));
    expect(view.status).toBe(status);
    expect(view.target).toMatchObject({ kind: 'question', key: 'q_role' });
    // Terminal findings are never marked stale.
    expect(view.stale).toBe(false);
  });

  it('degrades to a null target when the live structure fails to load and no snapshot exists', async () => {
    vi.mocked(buildEvaluationStructure).mockRejectedValue(new Error('structure gone'));
    const view = await buildScopedFindingView({ ...scoped(), snapshot: null });
    expect(view.target).toBeNull();
  });
});

describe('buildScopedFindingView — destination stamping', () => {
  /** Two sections, so "the last one" is a different answer from "the only one". */
  function twoSections(): VersionStructureInput {
    return {
      ...structure(),
      sections: [...structure().sections, { title: 'Experience', questions: [] }],
    };
  }

  const ADD = {
    op: 'add_question' as const,
    prompt: 'How supported did you feel?',
    type: 'free_text' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildEvaluationStructure).mockResolvedValue(twoSections());
  });

  it('leaves the destination null for an op that creates nothing', async () => {
    // The default fixture is a `replace_prompt`, which inherits its position from the question it
    // edits. A destination here would put a placement sentence on a card that places nothing.
    const view = await buildScopedFindingView(scoped());
    expect(view.destination).toBeNull();
  });

  it('reports the last section, marked as a default, when nothing named one', async () => {
    // The wiring, not the resolver: `resolveAddDestination` is unit-tested on its own, and passing
    // it the wrong op or the wrong structure here would still leave that green.
    const view = await buildScopedFindingView(scoped({ targetKey: 'goal', proposedEdit: ADD }));
    expect(view.destination).toEqual({
      sectionTitle: 'Experience',
      sectionPosition: 2,
      origin: 'default',
    });
  });

  it('reports the section the judge named', async () => {
    const view = await buildScopedFindingView(
      scoped({ targetKey: 'goal', proposedEdit: { ...ADD, sectionKey: 'Background' } })
    );
    expect(view.destination).toEqual({
      sectionTitle: 'Background',
      sectionPosition: 1,
      origin: 'chosen',
    });
  });

  it("follows the reviewer's redirect, not the judge's original", async () => {
    // The EFFECTIVE op. This is what the redirect picker writes, and the card re-renders straight
    // from this response. Reading `proposedEdit` here would answer a reviewer who has just moved
    // a question with the section they moved it out of, in the same breath.
    const view = await buildScopedFindingView(
      scoped({
        targetKey: 'goal',
        proposedEdit: { ...ADD, sectionKey: 'Background' },
        editedOverride: { ...ADD, sectionKey: 'Experience' },
      })
    );
    expect(view.destination).toMatchObject({ sectionTitle: 'Experience', origin: 'chosen' });
  });

  it('stamps the destination on a terminal finding too', async () => {
    // Same reason `target` is stamped for one: an applied add still has to say where it went.
    const view = await buildScopedFindingView(
      scoped({
        status: 'applied',
        targetKey: 'goal',
        proposedEdit: { ...ADD, sectionKey: 'Background' },
      })
    );
    expect(view.destination).toMatchObject({ sectionTitle: 'Background', origin: 'chosen' });
  });

  it('says nothing at all when the live structure could not be loaded', async () => {
    // Not `origin: 'none'`. That reads on the card as "this questionnaire has no sections", which
    // is a claim about the questionnaire rather than about our failure to look at it.
    vi.mocked(buildEvaluationStructure).mockRejectedValue(new Error('structure gone'));
    const view = await buildScopedFindingView({
      ...scoped({ targetKey: 'goal', proposedEdit: ADD }),
      snapshot: null,
    });
    expect(view.destination).toBeNull();
  });
});
