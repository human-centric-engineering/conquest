/**
 * The ingest non-question drop — the only path in the extract/verify/repair chain that DELETES.
 *
 * Anti-green-bar: every test here asserts what survives in the questionnaire and what the change
 * log can put back, not that the function returned an object. The two ways this can fail are both
 * silent. Dropping too much loses questions the document really asked, and a `beforeJson` written
 * in the wrong shape still renders in the change log while quietly making the revert impossible,
 * which nobody discovers until someone presses revert months later.
 *
 * @see app/api/v1/app/questionnaires/_lib/orchestrate-extraction.ts (dropNonQuestions)
 */

import { describe, it, expect, vi } from 'vitest';

// The module imports the Prisma client at top level (for the agent loads elsewhere in the file);
// dropNonQuestions itself is pure, so a bare stub is enough to import it.
vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { dropNonQuestions } from '@/app/api/v1/app/questionnaires/_lib/orchestrate-extraction';
import type { ExtractedQuestion } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import type { QuestionVerdict } from '@/lib/app/questionnaire/ingestion/verify-schema';

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function q(key: string, over: Partial<ExtractedQuestion> = {}): ExtractedQuestion {
  return {
    sectionOrdinal: 0,
    key,
    prompt: `Prompt for ${key}`,
    suggestedType: 'free_text',
    extractionConfidence: 0.6,
    ...over,
  };
}

function extraction(questions: ExtractedQuestion[]): ExtractQuestionnaireStructureData {
  return {
    sections: [
      { ordinal: 0, title: 'Opening' },
      { ordinal: 1, title: 'Growth' },
    ],
    questions,
    changes: [],
  };
}

/** The reported span: a chatbot line the extractor promoted to a question. */
const BOT_SCRIPT =
  "That's useful. Based on what you've said I want to go deeper on the areas below. " +
  "I'll ask some short scored statements, quick answers are fine.";

function suspect(key: string, detail?: string): QuestionVerdict {
  return { key, verdict: 'suspect', issue: 'not_a_question', ...(detail ? { detail } : {}) };
}

/** Nine real questions, so a small drop stays well under the 25% ceiling. */
function nineRealQuestions(): ExtractedQuestion[] {
  return Array.from({ length: 9 }, (_, i) => q(`real_${i}`));
}

describe('dropNonQuestions', () => {
  it('removes the flagged span and leaves every real question in place', () => {
    const ex = extraction([...nineRealQuestions(), q('bot_script', { prompt: BOT_SCRIPT })]);

    const result = dropNonQuestions(ex, [suspect('bot_script')], makeLog() as never);

    expect(result.droppedKeys).toEqual(['bot_script']);
    expect(result.extraction.questions.map((x) => x.key)).toEqual(
      nineRealQuestions().map((x) => x.key)
    );
  });

  it('files a prune_question change carrying everything the planner needs to restore it', () => {
    // The field NAMES here are the contract with `planPruneQuestion`/`toNewQuestion`. A rename
    // breaks revert silently: the row still renders, and restoring it yields a blank free_text.
    const ex = extraction([
      ...nineRealQuestions(),
      q('bot_script', {
        prompt: BOT_SCRIPT,
        sectionOrdinal: 1,
        suggestedType: 'single_choice',
        suggestedTypeConfig: { choices: [{ value: 'a', label: 'A' }] },
        guidelines: 'Read this out before the scored section.',
        rationale: 'Framing for the block below.',
        required: true,
        sourceQuote: `Bot script: ${BOT_SCRIPT}`,
      }),
    ]);

    const { extraction: out } = dropNonQuestions(
      ex,
      [suspect('bot_script', 'Interviewer script, not a question.')],
      makeLog() as never
    );

    expect(out.changes).toHaveLength(1);
    const change = out.changes[0];
    expect(change.changeType).toBe('prune_question');
    expect(change.targetEntityType).toBe('question');
    expect(change.afterJson).toBeNull();
    expect(change.sourceQuote).toBe(`Bot script: ${BOT_SCRIPT}`);
    expect(change.rationale).toContain('Interviewer script, not a question.');
    expect(change.beforeJson).toEqual({
      key: 'bot_script',
      prompt: BOT_SCRIPT,
      type: 'single_choice',
      typeConfig: { choices: [{ value: 'a', label: 'A' }] },
      sectionOrdinal: 1,
      sectionTitle: 'Growth',
      guidelines: 'Read this out before the scored section.',
      rationale: 'Framing for the block below.',
      required: true,
    });
  });

  it('still records a restorable prune when the question carried no optional fields', () => {
    const ex = extraction([...nineRealQuestions(), q('bot_script', { prompt: BOT_SCRIPT })]);

    const { extraction: out } = dropNonQuestions(ex, [suspect('bot_script')], makeLog() as never);

    // `prompt` is what makes the revert possible at all; the absent optionals must simply be
    // absent rather than written as undefined/null placeholders the planner would restore.
    expect(out.changes[0].beforeJson).toEqual({
      key: 'bot_script',
      prompt: BOT_SCRIPT,
      type: 'free_text',
      typeConfig: null,
      sectionOrdinal: 0,
      sectionTitle: 'Opening',
    });
    expect(out.changes[0].rationale).toContain('not a question');
  });

  it('drops nothing when the flagged count exceeds the ceiling', () => {
    // 12 questions → ceiling 3. Four flagged means the critic has misread the document (a page of
    // statements to rate is the usual way), so the whole drop is abandoned rather than applied.
    const ex = extraction(Array.from({ length: 12 }, (_, i) => q(`q${i}`)));
    const log = makeLog();

    const result = dropNonQuestions(
      ex,
      ['q0', 'q1', 'q2', 'q3'].map((k) => suspect(k)),
      log as never
    );

    expect(result.droppedKeys).toEqual([]);
    expect(result.extraction).toBe(ex);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('too many spans as non-questions'),
      expect.objectContaining({ flagged: 4, ceiling: 3, total: 12 })
    );
  });

  it('allows a handful on a short document, where the fraction alone would allow none', () => {
    // 8 questions → floor(8 * 0.25) = 2, but the floor of 3 governs. A short instrument with a
    // three-line intro script must still come out clean.
    const ex = extraction(Array.from({ length: 8 }, (_, i) => q(`q${i}`)));

    const result = dropNonQuestions(
      ex,
      ['q0', 'q1', 'q2'].map((k) => suspect(k)),
      makeLog() as never
    );

    expect(result.droppedKeys).toEqual(['q0', 'q1', 'q2']);
    expect(result.extraction.questions.map((x) => x.key)).toEqual(['q3', 'q4', 'q5', 'q6', 'q7']);
  });

  it('never empties the questionnaire, even inside the ceiling', () => {
    // 3 questions, all flagged: the floor of 3 permits it, so only the never-empty guard stops a
    // version that cannot be launched and gives the admin nothing to review.
    const ex = extraction([q('a'), q('b'), q('c')]);
    const log = makeLog();

    const result = dropNonQuestions(ex, [suspect('a'), suspect('b'), suspect('c')], log as never);

    expect(result.droppedKeys).toEqual([]);
    expect(result.extraction).toBe(ex);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('flagged every question'),
      expect.objectContaining({ total: 3 })
    );
  });

  it('ignores a verdict naming a question that does not exist', () => {
    // Verdict keys are model output. A hallucinated key must not count toward the ceiling, or a
    // critic inventing names could suppress a legitimate drop.
    const ex = extraction([...nineRealQuestions(), q('bot_script', { prompt: BOT_SCRIPT })]);

    const result = dropNonQuestions(
      ex,
      [suspect('bot_script'), suspect('ghost_1'), suspect('ghost_2'), suspect('ghost_3')],
      makeLog() as never
    );

    expect(result.droppedKeys).toEqual(['bot_script']);
    expect(result.extraction.questions).toHaveLength(9);
  });

  it('returns the extraction untouched when nothing was flagged', () => {
    const ex = extraction(nineRealQuestions());
    const result = dropNonQuestions(ex, [], makeLog() as never);

    expect(result.droppedKeys).toEqual([]);
    expect(result.extraction).toBe(ex);
  });

  it('leaves a section that held only the dropped span in place, now empty', () => {
    // Deliberate: an empty section is visible and one click to delete, whereas removing a section
    // the author expected to see is the more expensive mistake and a separate editorial decision.
    const ex = extraction([...nineRealQuestions(), q('bot_script', { sectionOrdinal: 1 })]);

    const { extraction: out } = dropNonQuestions(ex, [suspect('bot_script')], makeLog() as never);

    expect(out.sections.map((s) => s.ordinal)).toEqual([0, 1]);
    expect(out.questions.some((x) => x.sectionOrdinal === 1)).toBe(false);
  });

  it('appends to the existing change log rather than replacing it', () => {
    const ex: ExtractQuestionnaireStructureData = {
      ...extraction([...nineRealQuestions(), q('bot_script')]),
      changes: [
        { changeType: 'infer_goal', targetEntityType: 'version', afterJson: { goal: 'Assess' } },
      ],
    };

    const { extraction: out } = dropNonQuestions(ex, [suspect('bot_script')], makeLog() as never);

    expect(out.changes.map((c) => c.changeType)).toEqual(['infer_goal', 'prune_question']);
  });
});
