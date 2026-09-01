import { describe, expect, it } from 'vitest';

import {
  resolveAddDestination,
  resolveFindingTarget,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-target';
import type { ProposedEdit, VersionStructureInput } from '@/lib/app/questionnaire/evaluation';

/** A two-section structure so section membership and position both have something to prove. */
function structure(overrides?: Partial<VersionStructureInput>): VersionStructureInput {
  return {
    goal: 'Understand onboarding friction',
    audience: { expertiseLevel: 'intermediate', role: 'new hire' },
    sections: [
      {
        title: 'Background',
        questions: [
          { key: 'q_role', prompt: 'What is your role?', type: 'free_text', required: true },
          { key: 'q_team', prompt: 'Which team?', type: 'single_choice', required: false },
        ],
      },
      {
        title: 'Experience',
        questions: [
          {
            key: 'q_ramp',
            prompt: 'How long did ramp-up take?',
            type: 'free_text',
            required: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('resolveFindingTarget — questions', () => {
  it('names the question, its section, and its 1-based position', () => {
    const target = resolveFindingTarget('q_team', structure(), structure());
    expect(target).toEqual({
      kind: 'question',
      key: 'q_team',
      label: 'Which team?',
      sectionTitle: 'Background',
      position: 2,
      sectionPosition: 1,
      questionType: 'single_choice',
      // Both null: this fixture has no routing overlay, which is what a version with Conditional
      // Topics off looks like — the default, and most of the product.
      routingReach: null,
      topicLabel: null,
      removed: false,
    });
  });

  it('reports the containing section’s 1-based index, so questions order across sections', () => {
    // `position` alone cannot order these two: both are the 1st/2nd of their own section.
    const first = resolveFindingTarget('q_role', structure(), structure());
    const later = resolveFindingTarget('q_ramp', structure(), structure());
    expect(first).toMatchObject({ sectionPosition: 1, position: 1 });
    expect(later).toMatchObject({ sectionPosition: 2, position: 1 });
  });

  it('resolves against the live structure, not the run snapshot, when the prompt was reworded', () => {
    const snapshot = structure();
    const current = structure({
      sections: [
        {
          title: 'Background',
          questions: [
            { key: 'q_role', prompt: 'What is your job title?', type: 'free_text', required: true },
          ],
        },
      ],
    });
    const target = resolveFindingTarget('q_role', current, snapshot);
    expect(target?.label).toBe('What is your job title?');
    expect(target?.removed).toBe(false);
  });

  it('falls back to the snapshot and flags removed when the question is gone from the live structure', () => {
    const current = structure({
      sections: [{ title: 'Background', questions: [] }],
    });
    const target = resolveFindingTarget('q_role', current, structure());
    expect(target).toMatchObject({
      kind: 'question',
      label: 'What is your role?',
      sectionTitle: 'Background',
      removed: true,
    });
  });

  it('reports the position within the question’s own section, not the whole structure', () => {
    const target = resolveFindingTarget('q_ramp', structure(), structure());
    expect(target).toMatchObject({ sectionTitle: 'Experience', position: 1 });
  });
});

describe('resolveFindingTarget — non-question targets', () => {
  it('labels the version-level goal and audience', () => {
    expect(resolveFindingTarget('goal', structure(), null)).toMatchObject({
      kind: 'goal',
      label: 'Questionnaire goal',
    });
    expect(resolveFindingTarget('audience', structure(), null)).toMatchObject({
      kind: 'audience',
      label: 'Target audience',
    });
  });

  it('strips the section: prefix and keeps the title as the label', () => {
    expect(resolveFindingTarget('section:Background', structure(), null)).toMatchObject({
      kind: 'section',
      label: 'Background',
      sectionPosition: 1,
      removed: false,
    });
    expect(resolveFindingTarget('section:Experience', structure(), null)).toMatchObject({
      sectionPosition: 2,
    });
  });

  it('leaves the version-level targets unpositioned', () => {
    expect(resolveFindingTarget('goal', structure(), null)).toMatchObject({
      sectionPosition: null,
      position: null,
    });
  });

  it('flags a section whose title no longer exists live', () => {
    const current = structure({ sections: [{ title: 'Renamed', questions: [] }] });
    expect(resolveFindingTarget('section:Background', current, structure())).toMatchObject({
      kind: 'section',
      label: 'Background',
      removed: true,
    });
  });
});

describe('resolveFindingTarget — degradation', () => {
  it('degrades an unresolvable key to kind unknown rather than throwing', () => {
    const target = resolveFindingTarget('q_invented_by_the_judge', structure(), structure());
    expect(target).toMatchObject({
      kind: 'unknown',
      key: 'q_invented_by_the_judge',
      label: 'q_invented_by_the_judge',
    });
  });

  it('returns null when there is no structure at all to resolve against', () => {
    expect(resolveFindingTarget('q_role', null, null)).toBeNull();
  });

  it('resolves from the snapshot alone when the live structure failed to load', () => {
    expect(resolveFindingTarget('q_role', null, structure())).toMatchObject({
      kind: 'question',
      label: 'What is your role?',
      removed: true,
    });
  });
});

/**
 * Routing reach on the review card (F17.34).
 *
 * The reviewer's question is "who is actually asked this?", and phase alone does not answer it: a
 * question can belong to several topics, and if any of them always runs then so does the question.
 * The gate on `routing.enabled` is the other half — ingest seeds a `core` topic per section on
 * every questionnaire, so "has topics" would chip every card in the product.
 */
describe('resolveFindingTarget — routing reach', () => {
  function routed(
    topicsByQuestion: Record<string, string[]>,
    topics: { key: string; label: string; phase: string }[]
  ): VersionStructureInput {
    const base = structure();
    return {
      ...base,
      routing: {
        enabled: true,
        maxConditionalTopics: 3,
        topics: topics.map((t) => ({ ...t, depth: 'full', questionCount: 1 })),
        conditionalQuestionCount: 1,
      },
      sections: base.sections.map((s) => ({
        ...s,
        questions: s.questions.map((q) => ({ ...q, topicKeys: topicsByQuestion[q.key] ?? [] })),
      })),
    };
  }

  it('is null on a version with no routing overlay at all', () => {
    const target = resolveFindingTarget('q_team', structure(), structure());
    expect(target).toMatchObject({ routingReach: null, topicLabel: null });
  });

  it('reads "always" for a question in an opening, core or closing topic', () => {
    for (const phase of ['opening', 'core', 'closing']) {
      const s = routed({ q_team: ['t'] }, [{ key: 't', label: 'Spine', phase }]);
      expect(resolveFindingTarget('q_team', s, s)).toMatchObject({
        routingReach: 'always',
        topicLabel: 'Spine',
      });
    }
  });

  it('reads "conditional" for a question only a conditional topic claims', () => {
    const s = routed({ q_team: ['t'] }, [
      { key: 't', label: 'Talent depth', phase: 'conditional' },
    ]);

    expect(resolveFindingTarget('q_team', s, s)).toMatchObject({
      routingReach: 'conditional',
      topicLabel: 'Talent depth',
    });
  });

  it('reads "always" when ANY owning topic always runs, whatever the others say', () => {
    // The reviewer's question is who is asked it, not what its topics are called. A question in
    // both a core and a conditional topic is asked of everyone; reporting one topic's phase would
    // call that "conditional" and invite a delete on a question nobody can skip.
    const s = routed({ q_team: ['spine', 'depth'] }, [
      { key: 'spine', label: 'Spine', phase: 'core' },
      { key: 'depth', label: 'Depth', phase: 'conditional' },
    ]);

    expect(resolveFindingTarget('q_team', s, s)).toMatchObject({
      routingReach: 'always',
      topicLabel: 'Spine, Depth',
    });
  });

  it('reads "never" for a question no topic claims', () => {
    const s = routed({}, [{ key: 't', label: 'Spine', phase: 'core' }]);

    expect(resolveFindingTarget('q_team', s, s)).toMatchObject({
      routingReach: 'never',
      topicLabel: null,
    });
  });

  it('falls back to the snapshot for a question deleted since the run', () => {
    // Otherwise a removed question would report as unreachable rather than as removed.
    const snapshot = routed({ q_team: ['t'] }, [{ key: 't', label: 'Spine', phase: 'core' }]);
    const live = { ...snapshot, sections: [] };

    expect(resolveFindingTarget('q_team', live, snapshot)).toMatchObject({
      removed: true,
      routingReach: 'always',
      topicLabel: 'Spine',
    });
  });

  it('stays null for goal, audience and section targets', () => {
    const s = routed({ q_team: ['t'] }, [{ key: 't', label: 'Spine', phase: 'core' }]);

    for (const key of ['goal', 'audience', 'section:Background']) {
      expect(resolveFindingTarget(key, s, s)).toMatchObject({
        routingReach: null,
        topicLabel: null,
      });
    }
  });
});

describe('resolveAddDestination', () => {
  /** The coverage judge's shape: a gap targeted at `goal`, with a drafted question attached. */
  function addOp(over: Partial<Extract<ProposedEdit, { op: 'add_question' }>> = {}): ProposedEdit {
    return {
      op: 'add_question',
      prompt: 'How supported did you feel?',
      type: 'free_text',
      ...over,
    };
  }

  it('names the section the judge chose, with its position', () => {
    const dest = resolveAddDestination(addOp({ sectionKey: 'Background' }), 'goal', structure());
    expect(dest).toEqual({ sectionTitle: 'Background', sectionPosition: 1, origin: 'chosen' });
  });

  it('reports the LAST section, flagged as a default, when the judge named none', () => {
    // The whole point of the field. `applyAddQuestion` appends to the last section when nothing
    // names one, and before this the reviewer had no way to know that: the card previewed the
    // prompt, the type and the guidelines and said nothing about where it would land.
    const dest = resolveAddDestination(addOp(), 'goal', structure());
    expect(dest).toEqual({ sectionTitle: 'Experience', sectionPosition: 2, origin: 'default' });
  });

  it('honours a section-targeted finding when the op names no section', () => {
    // The second of apply's three rules (`resolveTargetSectionTitle`). Reading only `sectionKey`
    // here would call this a default and tell the reviewer it lands in "Experience".
    const dest = resolveAddDestination(addOp(), 'section:Background', structure());
    expect(dest).toEqual({ sectionTitle: 'Background', sectionPosition: 1, origin: 'chosen' });
  });

  it('prefers the op over the target when both name a section', () => {
    // Apply checks `sectionKey` first, so anything else here would be a card that promises one
    // destination and writes into another.
    const dest = resolveAddDestination(
      addOp({ sectionKey: 'Experience' }),
      'section:Background',
      structure()
    );
    expect(dest?.sectionTitle).toBe('Experience');
  });

  it('keeps the name but drops the position when the section is gone', () => {
    // Also the condition `deriveFindingState` reports as stale, so the card is already blocking
    // Apply. Naming it anyway is what tells the reviewer WHICH section went missing.
    const dest = resolveAddDestination(addOp({ sectionKey: 'Deleted' }), 'goal', structure());
    expect(dest).toEqual({ sectionTitle: 'Deleted', sectionPosition: null, origin: 'chosen' });
  });

  it('drops the position when the title matches two sections', () => {
    // Apply refuses an ambiguous title (`op_invalid`), so numbering the first of them would show a
    // certainty the apply engine itself does not have.
    const twice = structure({
      sections: [
        { title: 'Background', questions: [] },
        { title: 'Background', questions: [] },
      ],
    });
    const dest = resolveAddDestination(addOp({ sectionKey: 'Background' }), 'goal', twice);
    expect(dest).toEqual({ sectionTitle: 'Background', sectionPosition: null, origin: 'chosen' });
  });

  it('says there is nowhere to put it when the version has no sections', () => {
    // Apply answers `needs_authoring`. Reporting a default section here would name one that does
    // not exist.
    const dest = resolveAddDestination(addOp(), 'goal', structure({ sections: [] }));
    expect(dest).toEqual({ sectionTitle: null, sectionPosition: null, origin: 'none' });
  });

  it('still says nowhere when the version has no sections but the judge named one', () => {
    // Apply calls this `target_gone` rather than `needs_authoring`, but both are refusals and
    // neither is a place. Naming the judge's dead section would offer the reviewer a destination
    // that cannot exist on a questionnaire with no sections at all.
    const dest = resolveAddDestination(
      addOp({ sectionKey: 'Background' }),
      'goal',
      structure({ sections: [] })
    );
    expect(dest).toEqual({ sectionTitle: null, sectionPosition: null, origin: 'none' });
  });

  it('says NOTHING, rather than "no sections", when the structure could not be loaded', () => {
    // Not `origin: 'none'`. The card renders that as "This questionnaire has no sections", which
    // is a claim about the questionnaire; a failed load is a fact about us. `loadCurrentStructure
    // Safe` returns null on any DB hiccup, so this is a live path, not a theoretical one.
    expect(resolveAddDestination(addOp(), 'goal', null)).toBeNull();
  });

  it('is null for any other op, and for a prose-only finding', () => {
    // A destination on a `replace_prompt` would render a placement sentence on a card that creates
    // nothing; every other op inherits its position from the question it acts on.
    expect(resolveAddDestination({ op: 'delete_question' }, 'q_role', structure())).toBeNull();
    expect(resolveAddDestination(null, 'goal', structure())).toBeNull();
  });
});
