/**
 * `buildSectionState` — the single seam the runtime reads.
 *
 * The first describe block is the one that matters most: **the inert gate**. Every version that
 * never opted in, and every one resolving to fewer than two sections, must come back with `active`
 * false and everything else empty, because that is what makes the whole feature invisible to the
 * questionnaires already in the field.
 */

import { describe, expect, it } from 'vitest';

import { buildSectionState, type SectionStateInput } from '@/lib/app/questionnaire/sections/state';
import { DEFAULT_SECTIONED_INTERVIEW_SETTINGS } from '@/lib/app/questionnaire/sections/settings';
import {
  openSection,
  reconcileSectionRun,
  recordTurnInSection,
} from '@/lib/app/questionnaire/sections/run';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type { QuestionView } from '@/lib/app/questionnaire/selection/types';
import type { Topic } from '@/lib/app/questionnaire/scope/types';

function question(key: string, sectionId = 'sec'): QuestionView {
  return {
    id: `id_${key}`,
    key,
    sectionId,
    sectionOrdinal: 0,
    ordinal: 0,
    weight: 1,
    required: false,
    type: 'free_text',
    tagIds: [],
  };
}

function topic(key: string, ordinal: number, questionKeys: string[]): Topic {
  return {
    id: `t_${key}`,
    key,
    label: key,
    description: null,
    phase: 'core',
    criteria: null,
    depth: 'full',
    members: { questionKeys, dataSlotKeys: [] },
    ordinal,
    source: 'seeded',
    trigger: null,
  };
}

const TOPICS = [topic('a', 0, ['q1']), topic('b', 1, ['q2'])];
const QUESTIONS = [question('q1'), question('q2')];

function input(overrides: Partial<SectionStateInput> = {}): SectionStateInput {
  return {
    config: DEFAULT_QUESTIONNAIRE_CONFIG,
    settings: { ...DEFAULT_SECTIONED_INTERVIEW_SETTINGS, enabled: true },
    topics: TOPICS,
    conditionalTopicsEnabled: true,
    dataSlots: [],
    documentSections: [],
    questions: QUESTIONS,
    answered: [],
    storedRun: null,
    sessionId: 'sess_1',
    ...overrides,
  };
}

describe('the inert gate', () => {
  it('is inert when the feature is off', () => {
    const state = buildSectionState(input({ settings: DEFAULT_SECTIONED_INTERVIEW_SETTINGS }));
    expect(state).toEqual({
      active: false,
      sections: [],
      run: null,
      activeSection: null,
      isSectionOpening: false,
      close: null,
      allClosed: false,
    });
  });

  it('is inert when only one section resolves', () => {
    expect(buildSectionState(input({ topics: [topic('only', 0, ['q1'])] })).active).toBe(false);
  });

  it('is inert when no grouping supplies anything', () => {
    expect(buildSectionState(input({ topics: [], conditionalTopicsEnabled: false })).active).toBe(
      false
    );
  });

  it('is inert for a stored run it cannot read, rather than trusting it', () => {
    // A corrupt blob must not leave the respondent bounded to a section nobody wrote. It reads as
    // "no run yet", and the run is rebuilt from the sections that actually resolve.
    const state = buildSectionState(input({ storedRun: { v: 99, sections: [{ key: 'a' }] } }));
    expect(state.active).toBe(true);
    expect(state.run?.sections.every((s) => s.status === 'not_started')).toBe(true);
  });
});

describe('the active section', () => {
  it('starts at the first section when the run has never been written', () => {
    const state = buildSectionState(input());
    expect(state.activeSection?.key).toBe('a');
    expect(state.isSectionOpening).toBe(true);
  });

  it('stops being an opening once a turn has been charged to the section', () => {
    const run = recordTurnInSection(
      openSection(
        reconcileSectionRun(null, [
          {
            key: 'a',
            label: 'a',
            ordinal: 0,
            source: 'topics',
            questionKeys: ['q1'],
            dataSlotKeys: [],
          },
          {
            key: 'b',
            label: 'b',
            ordinal: 1,
            source: 'topics',
            questionKeys: ['q2'],
            dataSlotKeys: [],
          },
        ]),
        'a',
        0
      ),
      'a'
    );
    const state = buildSectionState(input({ storedRun: run }));
    expect(state.activeSection?.key).toBe('a');
    expect(state.isSectionOpening).toBe(false);
  });

  it('reports every section closed with no active section left', () => {
    const state = buildSectionState(
      input({
        storedRun: {
          v: 1,
          activeKey: null,
          sections: [
            { key: 'a', status: 'closed', closedAtTurn: 1, closeReason: 'respondent' },
            { key: 'b', status: 'closed', closedAtTurn: 2, closeReason: 'respondent' },
          ],
        },
      })
    );
    expect(state.allClosed).toBe(true);
    expect(state.activeSection).toBeNull();
    expect(state.close).toBeNull();
  });
});

describe('scope composition', () => {
  it('narrows a section to what scope allowed, and can never widen it', () => {
    const state = buildSectionState(
      input({
        topics: [topic('a', 0, ['q1', 'q_out']), topic('b', 1, ['q2'])],
        questions: [...QUESTIONS, question('q_out')],
        scope: { questionKeys: new Set(['q1', 'q2']), dataSlotKeys: new Set() },
      })
    );
    expect(state.sections.find((s) => s.key === 'a')?.questionKeys).toEqual(['q1']);
  });

  it('falls back to unsectioned when scope leaves fewer than two sections', () => {
    const state = buildSectionState(
      input({ scope: { questionKeys: new Set(['q1']), dataSlotKeys: new Set() } })
    );
    expect(state.active).toBe(false);
  });
});

describe('the close gate on the active section', () => {
  it('is assessed against the active section alone', () => {
    const state = buildSectionState(
      input({ answered: [{ questionId: 'id_q1', confidence: 0.9 }] })
    );
    // Section a holds only q1, which is answered, so it may close even though q2 is untouched.
    expect(state.activeSection?.key).toBe('a');
    expect(state.close?.canClose).toBe(true);
  });

  it("does not let another section's answers close this one", () => {
    const state = buildSectionState(
      input({ answered: [{ questionId: 'id_q2', confidence: 0.9 }] })
    );
    expect(state.activeSection?.key).toBe('a');
    expect(state.close?.canClose).toBe(false);
  });
});

describe('invariant 2: sections never redefine done', () => {
  // This is the bug this block exists for. The first build of `buildTurnContext` narrowed
  // `base.questions` to the active section, which also narrowed the SUBMIT GATE and the progress
  // bar — so a session offered to submit the moment its first section was covered, and showed 100%
  // with every other section still to come.
  //
  // The fix is that the section-bounded list is a SECOND list (`sectionQuestions`), read only where
  // a question is being chosen. These assertions pin the shape that makes that possible: the state
  // this module returns carries the section's membership and nothing else, and every measurement
  // upstream keeps reading the full set it was given.
  it('carries the section membership without touching the questions it was given', () => {
    const questions = [...QUESTIONS, question('q3')];
    const state = buildSectionState(
      input({
        topics: [topic('a', 0, ['q1']), topic('b', 1, ['q2', 'q3'])],
        questions,
      })
    );
    expect(state.activeSection?.questionKeys).toEqual(['q1']);
    // The input list is untouched: the caller still holds every question, which is what the submit
    // gate, the coverage figure and the progress bar go on reading.
    expect(questions).toHaveLength(3);
  });

  it('assesses the section gate without claiming the session is done', () => {
    const state = buildSectionState(
      input({ answered: [{ questionId: 'id_q1', confidence: 0.9 }] })
    );
    // Section a is closeable...
    expect(state.close?.canClose).toBe(true);
    // ...and the whole interview plainly is not: q2 has no answer, and nothing in this state says
    // otherwise. `allClosed` is the only "the instrument is worked through" signal this module
    // emits, and it is about sections, not about completion.
    expect(state.allClosed).toBe(false);
  });
});

describe('the branches the seam resolves for itself', () => {
  it('treats a data slot with no mapped questions as mapping to nothing', () => {
    // `mappedQuestionKeys` is optional on the input, and a theme-sourced section built from a slot
    // that omits it must resolve to an empty question list rather than crashing on the read.
    const state = buildSectionState(
      input({
        settings: {
          ...DEFAULT_SECTIONED_INTERVIEW_SETTINGS,
          enabled: true,
          source: 'themes',
        },
        topics: [],
        conditionalTopicsEnabled: false,
        dataSlots: [
          { key: 'ds1', theme: 'alpha', ordinal: 0 },
          { key: 'ds2', theme: 'beta', ordinal: 1, mappedQuestionKeys: ['q2'] },
        ],
      })
    );
    expect(state.active).toBe(true);
    expect(state.sections.map((section) => section.key)).toEqual(['alpha', 'beta']);
    expect(state.sections[0].questionKeys).toEqual([]);
    expect(state.sections[1].questionKeys).toEqual(['q2']);
  });

  it('narrows the sections to the scope when one is supplied', () => {
    const state = buildSectionState(
      input({
        scope: { questionKeys: new Set(['q2']), dataSlotKeys: new Set<string>() },
      })
    );
    // Only topic b survives, and one section is below the floor, so the whole feature goes inert.
    expect(state.active).toBe(false);
  });

  it('opens the first section when the stored run names no active one', () => {
    const state = buildSectionState(input({ storedRun: { v: 1, activeKey: null, sections: [] } }));
    expect(state.activeSection?.key).toBe('a');
    expect(state.isSectionOpening).toBe(true);
  });

  it('reports allClosed with no active section once every section is finished', () => {
    let run = reconcileSectionRun(null, buildSectionState(input()).sections);
    run = {
      ...run,
      activeKey: null,
      sections: run.sections.map((entry) => ({
        ...entry,
        status: 'closed' as const,
        closedAtTurn: 1,
        closeReason: 'respondent' as const,
      })),
    };
    const state = buildSectionState(input({ storedRun: run }));
    expect(state.active).toBe(true);
    expect(state.activeSection).toBeNull();
    expect(state.allClosed).toBe(true);
    expect(state.close).toBeNull();
    expect(state.isSectionOpening).toBe(false);
  });

  it('stops calling a section opening once a turn has been charged to it', () => {
    const fresh = buildSectionState(input());
    const spoken = recordTurnInSection(openSection(fresh.run!, 'a', 0), 'a');
    const state = buildSectionState(input({ storedRun: spoken }));
    expect(state.activeSection?.key).toBe('a');
    expect(state.isSectionOpening).toBe(false);
  });
});
