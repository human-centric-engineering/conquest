import { describe, expect, it } from 'vitest';

import { EXTRACTOR_EMITTED_PROVENANCES } from '@/lib/app/questionnaire/types';
import {
  attachmentsToContentParts,
  buildAnswerExtractionPrompt,
  buildAnswerExtractionRetryMessage,
} from '@/lib/app/questionnaire/extraction/extraction-prompt';
import type { ContentPart } from '@/lib/orchestration/llm/types';
import { choiceSlot, ctx, slot } from '@/tests/unit/lib/app/questionnaire/extraction/_fixtures';

function userContent(messages: ReturnType<typeof buildAnswerExtractionPrompt>): string {
  const user = messages.find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

describe('buildAnswerExtractionPrompt', () => {
  it('emits a system rules message and a user message', () => {
    const messages = buildAnswerExtractionPrompt(ctx({ candidateSlots: [slot({ key: 'q1' })] }));
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('wraps the rule blocks in named XML sections (data-slot section only with data slots)', () => {
    const withoutDataSlots = buildAnswerExtractionPrompt(
      ctx({ candidateSlots: [slot({ key: 'q1' })] })
    );
    const system =
      typeof withoutDataSlots[0]?.content === 'string' ? withoutDataSlots[0].content : '';
    expect(system).toContain('<extraction_rules>');
    expect(system).not.toContain('<data_slot_rules>');

    const withDataSlots = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })] }),
      dataSlotCandidates: [
        { key: 'd1', name: 'Demographics', theme: 'about', description: 'age + gender' },
      ],
    });
    const sys2 = typeof withDataSlots[0]?.content === 'string' ? withDataSlots[0].content : '';
    expect(sys2).toContain('<data_slot_rules>');
  });

  it('lists every emittable provenance label in the system rules', () => {
    const messages = buildAnswerExtractionPrompt(ctx({ candidateSlots: [slot({ key: 'q1' })] }));
    const system = typeof messages[0]?.content === 'string' ? messages[0].content : '';
    for (const label of EXTRACTOR_EMITTED_PROVENANCES) {
      expect(system).toContain(label);
    }
    // Never offers the F4.4-only label.
    expect(system).not.toContain('refined');
  });

  it('instructs the model to map meaning onto options/scale (buckets, likert sentiment, catch-all)', () => {
    const messages = buildAnswerExtractionPrompt(ctx({ candidateSlots: [slot({ key: 'q1' })] }));
    const system = typeof messages[0]?.content === 'string' ? messages[0].content : '';
    // Returns the slug, not the label or raw words.
    expect(system).toMatch(/the slug.*NEVER its label/i);
    // Quantities/durations → the range bucket.
    expect(system).toMatch(/option whose RANGE contains them/i);
    // likert from sentiment strength, never a numeric rating prompt.
    expect(system).toMatch(/do NOT expect, or wait for, a numeric rating/i);
    // On-topic-but-unlisted → the catch-all option.
    expect(system).toMatch(/catch-all option/i);
  });

  it('appends the focused commit-to-a-fit framing only when forceFit is set', () => {
    const base = ctx({ candidateSlots: [slot({ key: 'department', type: 'single_choice' })] });
    const without = buildAnswerExtractionPrompt(base);
    const withFit = buildAnswerExtractionPrompt({ ...base, forceFit: true });
    const sysOf = (m: ReturnType<typeof buildAnswerExtractionPrompt>) =>
      typeof m[0]?.content === 'string' ? m[0].content : '';
    expect(sysOf(without)).not.toMatch(/FOCUSED RESOLUTION/i);
    const sys = sysOf(withFit);
    expect(sys).toMatch(/FOCUSED RESOLUTION/i);
    // Commit to the closest genuine fit rather than omit.
    expect(sys).toMatch(/Prefer committing to the closest genuine fit/i);
  });

  it('omits the sensitivity block by default (zero added prompt when the feature is off)', () => {
    const messages = buildAnswerExtractionPrompt(ctx({ candidateSlots: [slot({ key: 'q1' })] }));
    const system = typeof messages[0]?.content === 'string' ? messages[0].content : '';
    expect(system).not.toMatch(/Sensitivity awareness/i);
  });

  it('appends the sensitivity block only when sensitivityAware is set', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({ candidateSlots: [slot({ key: 'q1' })], sensitivityAware: true })
    );
    const system = typeof messages[0]?.content === 'string' ? messages[0].content : '';
    expect(system).toMatch(/Sensitivity awareness/i);
    expect(system).toMatch(/"sensitivity"/);
  });

  it('carries the active key, candidate prompts, and the respondent message', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [slot({ key: 'name', prompt: 'What is your name?' })],
        activeQuestionKey: 'name',
        userMessage: 'I am Dana',
      })
    );
    const content = userContent(messages);
    expect(content).toContain('Active question key: name');
    expect(content).toContain('What is your name?');
    expect(content).toContain('I am Dana');
  });

  it('frames an open prompt (no "Active question key") in data-slot mode', () => {
    // activeQuestionKey: null → data-slot mode: the respondent is answering an open conversational
    // prompt, so the extractor is told there is no single active question (vs naming one).
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [slot({ key: 'name', prompt: 'What is your name?' })],
        activeQuestionKey: null,
        userMessage: 'I am Dana',
      })
    );
    const content = userContent(messages);
    expect(content).not.toContain('Active question key');
    expect(content).toContain('there is no single active question');
    // Still lists the candidate questions to extract background answers into.
    expect(content).toContain('What is your name?');
  });

  it('renders choice options for a choice slot', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({ candidateSlots: [choiceSlot('colour', 'single_choice', 'red', 'blue')] })
    );
    const content = userContent(messages);
    expect(content).toContain('options:');
    expect(content).toContain('red');
    expect(content).toContain('blue');
  });

  it('includes the transcript only when recent messages are supplied', () => {
    const withTranscript = buildAnswerExtractionPrompt(
      ctx({ candidateSlots: [slot({ key: 'q1' })], recentMessages: ['earlier turn'] })
    );
    expect(userContent(withTranscript)).toContain('earlier turn');

    const without = buildAnswerExtractionPrompt(ctx({ candidateSlots: [slot({ key: 'q1' })] }));
    expect(userContent(without)).not.toContain('Recent conversation');
  });

  it('marks a required slot and renders its guidelines', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [slot({ key: 'q1', required: true, guidelines: 'Use full legal name' })],
      })
    );
    const content = userContent(messages);
    expect(content).toContain('required: true');
    expect(content).toContain('guidelines: Use full legal name');
  });

  it('renders a likert slot scale as min–max', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [slot({ key: 'rating', type: 'likert', typeConfig: { min: 1, max: 7 } })],
      })
    );
    expect(userContent(messages)).toContain('scale: 1–7');
  });

  it('renders a choice option with no label as the bare value', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [
          slot({
            key: 'colour',
            type: 'single_choice',
            typeConfig: { choices: [{ value: 'red' }] },
          }),
        ],
      })
    );
    const content = userContent(messages);
    expect(content).toContain('options: red');
    expect(content).not.toContain('red (');
  });
});

describe('buildAnswerExtractionPrompt — attachments', () => {
  it('keeps the user content a plain string when there are no attachments', () => {
    const messages = buildAnswerExtractionPrompt(ctx({ candidateSlots: [slot({ key: 'q1' })] }));
    expect(typeof messages[1]?.content).toBe('string');
  });

  it('makes the user content multimodal (text + parts) when attachments are present', () => {
    const messages = buildAnswerExtractionPrompt(
      ctx({
        candidateSlots: [slot({ key: 'q1' })],
        userMessage: 'see attached',
        attachments: [
          { name: 'photo.png', mediaType: 'image/png', data: 'aW1n' },
          { name: 'cv.pdf', mediaType: 'application/pdf', data: 'cGRm' },
        ],
      })
    );
    const content = messages[1]?.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as ContentPart[];
    // First part is the text (carrying the message + an attachment note); then one part per file.
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('see attached');
    expect((parts[0] as { text: string }).text).toContain('attached 2 file');
    expect(parts[1]).toMatchObject({ type: 'image' });
    expect(parts[2]).toMatchObject({ type: 'document', name: 'cv.pdf' });
  });
});

describe('attachmentsToContentParts', () => {
  it('maps images to image parts and everything else to named document parts', () => {
    const parts = attachmentsToContentParts([
      { name: 'a.webp', mediaType: 'image/webp', data: 'aW1n' },
      { name: 'notes.txt', mediaType: 'text/plain', data: 'dHh0' },
    ]);
    expect(parts[0]).toEqual({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/webp', data: 'aW1n' },
    });
    expect(parts[1]).toEqual({
      type: 'document',
      source: { type: 'base64', mediaType: 'text/plain', data: 'dHh0' },
      name: 'notes.txt',
    });
  });
});

describe('buildAnswerExtractionPrompt — data slots', () => {
  function systemContent(messages: ReturnType<typeof buildAnswerExtractionPrompt>): string {
    const sys = messages.find((m) => m.role === 'system');
    return typeof sys?.content === 'string' ? sys.content : '';
  }

  it('lists data-slot candidates and demands specific, non-meta paraphrases', () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })], activeQuestionKey: null }),
      dataSlotCandidates: [
        {
          key: 'demographics',
          name: 'Employee Demographics',
          description: 'Age + gender',
          theme: 'About',
        },
      ],
    });
    expect(userContent(messages)).toContain('demographics');
    const system = systemContent(messages);
    // The rules must steer away from meta-summaries toward the actual values.
    expect(system).toContain('25-year-old male');
    expect(system).toMatch(/specifics/i);
  });

  it('keeps the data-slot value in the respondent’s natural words, not the form slug/label', () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })], activeQuestionKey: null }),
      dataSlotCandidates: [
        { key: 'demographics', name: 'Employee Demographics', description: 'd', theme: 'About' },
      ],
    });
    const system = systemContent(messages);
    // The data slot records "Marketing" (their word), not the mapped form option "other".
    expect(system).toMatch(/own words/i);
    expect(system).toMatch(/NEVER the form's option code or label/i);
    expect(system).toContain('Marketing');
    // And a direct-question answer that corrects a recorded slot must update the slot too.
    expect(system).toMatch(/answers a DIRECT question whose subject a slot already recorded/i);
  });

  it('forbids absence fills and demands hedged, low-confidence inferences', () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })], activeQuestionKey: null }),
      dataSlotCandidates: [
        { key: 'demographics', name: 'Employee Demographics', description: 'd', theme: 'About' },
      ],
    });
    const system = systemContent(messages);
    // Issue #2: never record what's missing — omit the slot so the panel shows "Not covered yet".
    expect(system).toMatch(/ABSENCE/i);
    expect(system).toContain('Not covered yet');
    // Issue #1: inferred fills must be hedged, not asserted as fact, and honestly low confidence.
    expect(system).toMatch(/HEDGED/i);
    expect(system).toMatch(/≤ 0\.4/);
  });

  it('demands a substantive, evidence-bearing rationale (what was asked + what they said)', () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })], activeQuestionKey: null }),
      dataSlotCandidates: [
        { key: 'blockers', name: 'Work Blockers', description: 'd', theme: 'Wellbeing' },
      ],
    });
    const system = systemContent(messages);
    // The rationale must carry the actual evidence, framed "When asked about <topic>, <subject>…".
    expect(system).toMatch(/When asked about/i);
    expect(system).toMatch(/EVIDENCE/i);
    // The old meta-statement pattern is explicitly forbidden, not held up as correct.
    expect(system).toMatch(/FORBIDDEN/i);
    expect(system).toMatch(/informs this topic.*WRONG/i);
    // Subject wording must be gender-neutral and varied, not always "They".
    expect(system).toMatch(/gender-neutral/i);
    expect(system).toMatch(/the respondent/i);
  });

  it("renders a slot's current fill so the model can update/correct it", () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })], activeQuestionKey: null }),
      dataSlotCandidates: [
        {
          key: 'demographics',
          name: 'Employee Demographics',
          description: 'Age + gender',
          theme: 'About',
          current: {
            value: { age: 25, gender: 'male' },
            paraphrase: 'A 25-year-old male.',
            confidence: 0.9,
          },
        },
      ],
    });
    const content = userContent(messages);
    expect(content).toContain('current: A 25-year-old male.');
    expect(systemContent(messages)).toMatch(/CORRECTS?/);
  });

  it('instructs the model to re-scan every slot and keep the paraphrase a superset', () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })], activeQuestionKey: null }),
      dataSlotCandidates: [{ key: 'demographics', name: 'Demo', description: 'd', theme: 'About' }],
    });
    const system = systemContent(messages);
    expect(system).toMatch(/RE-SCAN EVERY slot/i);
    expect(system).toMatch(/SUPERSET/i);
  });

  it("renders a slot's mapped questions and demands the model also answer them", () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({
        candidateSlots: [slot({ key: 'satisfaction' }), slot({ key: 'morale' })],
        activeQuestionKey: 'satisfaction',
      }),
      dataSlotCandidates: [
        {
          key: 'role_satisfaction',
          name: 'Role Satisfaction',
          description: 'How they feel about their role',
          theme: 'Wellbeing',
          mappedQuestionKeys: ['satisfaction', 'morale'],
        },
      ],
    });
    // The slot line names the questions it captures.
    expect(userContent(messages)).toContain('answers questions: satisfaction, morale');
    const system = systemContent(messages);
    // The rules tell the model to ALSO answer the mapped questions, with the appropriateness gate.
    expect(system).toMatch(/ANSWER THE MAPPED QUESTIONS/i);
    expect(system).toMatch(/APPROPRIATENESS GATE/i);
    // Inferred/synthesised, never "direct" — they did not state the typed value.
    expect(system).toMatch(/NEVER "direct"/i);
  });

  it('omits the mapped-questions line when a slot maps to nothing', () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })], activeQuestionKey: null }),
      dataSlotCandidates: [{ key: 'demographics', name: 'Demo', description: 'd', theme: 'About' }],
    });
    expect(userContent(messages)).not.toContain('answers questions:');
  });

  it('renders a park status line and demands a best-effort inference for a parked slot', () => {
    const messages = buildAnswerExtractionPrompt({
      ...ctx({ candidateSlots: [slot({ key: 'q1' })], activeQuestionKey: null }),
      dataSlotCandidates: [
        {
          key: 'blockers',
          name: 'Workplace Blockers',
          description: 'What gets in the way',
          theme: 'Wellbeing',
          parkPending: true,
          attempts: 2,
        },
      ],
    });
    const content = userContent(messages);
    expect(content).toMatch(/status: asked 2× without a clear answer/);
    expect(content).toMatch(/BEST-EFFORT inference/i);
    // The system rules require a fill for such a slot rather than leaving it empty.
    expect(systemContent(messages)).toMatch(/MUST output a fill/i);
  });
});

describe('buildAnswerExtractionRetryMessage', () => {
  it('names the invalid field paths when provided', () => {
    const msg = buildAnswerExtractionRetryMessage(['answers.0.confidence']);
    expect(msg).toContain('answers.0.confidence');
  });
  it('falls back to a generic message when no paths are given', () => {
    const msg = buildAnswerExtractionRetryMessage([]);
    expect(msg).toMatch(/not valid JSON/);
  });
});
