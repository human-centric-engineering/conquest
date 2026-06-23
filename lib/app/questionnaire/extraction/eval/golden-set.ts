/**
 * Golden set for answer-extraction calibration.
 *
 * A small, hand-labelled corpus of real-shaped extraction turns, each annotated with what a
 * CORRECTLY-CALIBRATED extractor should return. It exists because the extractor's confidence /
 * provenance judgements were being tuned by anecdote — one prompt clause per bug report, never
 * measured — so fixes for one case silently regressed another. This set turns "is it reliable?"
 * into a number: `scripts/eval/extraction.ts` runs the live model over these fixtures and
 * {@link scoreFixture} grades the output.
 *
 * Each fixture is a real {@link ExtractionContext} (so it runs through `buildAnswerExtractionPrompt`
 * unchanged) plus {@link GoldenExpectation}s. Labels are kept to the DEFENSIBLE, unambiguous cases —
 * the anchors calibration must not get wrong — not contestable edge calls. Fixtures flagged
 * `knownGap` are cases the current chat-tier prompt is expected to FAIL; closing them is the goal of
 * the calibration work, and the runner reports them apart from genuine regressions.
 *
 * Pure data — no Prisma, no LLM. The `expectations` reference keys present in each context.
 */

import type { ExtractionContext } from '@/lib/app/questionnaire/extraction/types';
import type { ConfidenceBand } from '@/lib/app/questionnaire/extraction/eval/score';
import type { AnswerProvenance } from '@/lib/app/questionnaire/types';

/** One labelled outcome a correctly-calibrated extractor should produce for a fixture. */
export interface GoldenExpectation {
  /** The answer's `slotKey` or the fill's `dataSlotKey`. */
  key: string;
  /** Which output array it should appear in. */
  kind: 'answer' | 'dataSlotFill';
  /** The provenance it should carry — the axis that mislabels a STATED answer as `inferred`. */
  provenance: AnswerProvenance;
  /** The coarse confidence band it should land in — the axis that under-scores clear answers. */
  band: ConfidenceBand;
  /** Whether the downstream coverage rule should treat it as answered (so it isn't re-asked). */
  covered: boolean;
}

/** One calibration fixture: a real extraction context + the labels it should produce. */
export interface GoldenFixture {
  id: string;
  /** One line on what this case probes. */
  note: string;
  context: ExtractionContext;
  expectations: GoldenExpectation[];
  /** Keys that must NOT be emitted — a genuine non-answer must not invent a fill. */
  forbiddenKeys?: string[];
  /** A case the current prompt is expected to fail; closing it is the calibration target. */
  knownGap?: boolean;
}

/** Build a free-text question candidate. */
function freeText(key: string, prompt: string): ExtractionContext['candidateSlots'][number] {
  return { key, type: 'free_text', typeConfig: null, prompt, required: false };
}

/** Build a likert question candidate with bounds. */
function likert(
  key: string,
  prompt: string,
  min: number,
  max: number
): ExtractionContext['candidateSlots'][number] {
  return { key, type: 'likert', typeConfig: { min, max }, prompt, required: false };
}

/** Build a numeric question candidate. */
function numeric(key: string, prompt: string): ExtractionContext['candidateSlots'][number] {
  return { key, type: 'numeric', typeConfig: null, prompt, required: false };
}

/** Minimal context scaffold — every fixture overrides the parts it exercises. */
function ctx(
  over: Partial<ExtractionContext> & Pick<ExtractionContext, 'userMessage'>
): ExtractionContext {
  return {
    activeQuestionKey: null,
    candidateSlots: [],
    answered: [],
    sessionId: 'golden',
    ...over,
  };
}

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    id: 'recommend-extremely-unlikely',
    note: 'The reported bug, now the Phase-B target: a blunt, direct NPS answer must be a covered DIRECT fill (clear band), not an under-scored inference. NOT flagged knownGap — the rewritten prompt should pass it, so a live failure surfaces as a real regression (the signal that would gate the Phase-C model-tier decision).',
    context: ctx({
      userMessage: 'extremely unlikely',
      activeQuestionKey: null,
      candidateSlots: [
        numeric('nps', 'How likely are you to recommend the workplace to others? (0–10)'),
      ],
      dataSlotCandidates: [
        {
          key: 'workplace_recommendation',
          name: 'Workplace Recommendation',
          description: 'How likely the respondent is to recommend the workplace to others.',
          theme: 'Advocacy',
          mappedQuestionKeys: ['nps'],
        },
      ],
      recentMessages: ['Agent: How likely would you be to recommend the workplace to others?'],
    }),
    expectations: [
      // The data slot is a position they STATED outright — direct, clear, covered.
      {
        key: 'workplace_recommendation',
        kind: 'dataSlotFill',
        provenance: 'direct',
        band: 'clear',
        covered: true,
      },
      // The mapped numeric value (near 0) is legitimately INFERRED — they didn't state a number —
      // but the position pins it firmly, so it still clears coverage.
      { key: 'nps', kind: 'answer', provenance: 'inferred', band: 'clear', covered: true },
    ],
  },
  {
    id: 'direct-free-text-blocker',
    note: 'A plainly-stated free-text answer is direct + clear, even on first mention (clarity, not corroboration).',
    context: ctx({
      userMessage: 'My manager micromanages every task and it kills my motivation.',
      activeQuestionKey: 'blocker',
      candidateSlots: [freeText('blocker', 'What gets in the way of your best work?')],
    }),
    expectations: [
      { key: 'blocker', kind: 'answer', provenance: 'direct', band: 'clear', covered: true },
    ],
  },
  {
    id: 'likert-stated-number',
    note: 'When the respondent names the scale point outright, it is DIRECT (the value was stated).',
    context: ctx({
      userMessage: "Honestly a 2 — I'm very dissatisfied.",
      activeQuestionKey: 'satisfaction',
      candidateSlots: [likert('satisfaction', 'How satisfied are you at work? (1–5)', 1, 5)],
    }),
    expectations: [
      { key: 'satisfaction', kind: 'answer', provenance: 'direct', band: 'clear', covered: true },
    ],
  },
  {
    id: 'likert-inferred-from-sentiment',
    note: 'A strong sentiment with no stated number maps to the scale by inference — provenance inferred, but the dread firmly pins the bottom of the scale, so it lands clear + covered.',
    context: ctx({
      userMessage: 'I dread every single shift here.',
      activeQuestionKey: 'satisfaction',
      candidateSlots: [likert('satisfaction', 'How satisfied are you at work? (1–5)', 1, 5)],
    }),
    expectations: [
      {
        key: 'satisfaction',
        kind: 'answer',
        provenance: 'inferred',
        band: 'clear',
        covered: true,
      },
    ],
  },
  {
    id: 'first-mention-no-corroboration',
    note: 'A clear first statement is clear — it must not be dragged to partial merely for being uncorroborated.',
    context: ctx({
      userMessage: 'Pay is my number one issue, full stop.',
      activeQuestionKey: 'top_concern',
      candidateSlots: [
        freeText('top_concern', 'What matters most to you about your job right now?'),
      ],
    }),
    expectations: [
      { key: 'top_concern', kind: 'answer', provenance: 'direct', band: 'clear', covered: true },
    ],
  },
  {
    id: 'side-effect-second-slot',
    note: 'One message answers the active question and a second slot — both are stated, both direct + covered.',
    context: ctx({
      userMessage: "I'm a senior nurse and I've been here six years.",
      activeQuestionKey: 'role',
      candidateSlots: [
        freeText('role', 'What is your role?'),
        numeric('tenure_years', 'How many years have you worked here?'),
      ],
    }),
    expectations: [
      { key: 'role', kind: 'answer', provenance: 'direct', band: 'clear', covered: true },
      { key: 'tenure_years', kind: 'answer', provenance: 'direct', band: 'clear', covered: true },
    ],
  },
  {
    id: 'genuine-dont-know',
    note: 'A genuine non-answer must extract nothing — no invented fill, no covered slot.',
    context: ctx({
      userMessage: "I don't really know, to be honest.",
      activeQuestionKey: 'top_concern',
      candidateSlots: [
        freeText('top_concern', 'What matters most to you about your job right now?'),
      ],
    }),
    expectations: [],
    forbiddenKeys: ['top_concern'],
  },
  {
    id: 'question-back-not-an-answer',
    note: 'Asking a question back is not an answer — nothing is extracted.',
    context: ctx({
      userMessage: 'Sorry, what do you mean by that exactly?',
      activeQuestionKey: 'blocker',
      candidateSlots: [freeText('blocker', 'What gets in the way of your best work?')],
    }),
    expectations: [],
    forbiddenKeys: ['blocker'],
  },
  {
    id: 'terse-closed-stays-high',
    note: 'Closed-question carve-out: a complete, unambiguous CLOSED answer is direct + clear + covered even when terse — brevity is not low confidence for a closed type. Guards against the rewrite over-correcting and marking terse closed answers down.',
    context: ctx({
      userMessage: '5',
      activeQuestionKey: 'satisfaction',
      candidateSlots: [likert('satisfaction', 'How satisfied are you at work? (1–5)', 1, 5)],
      recentMessages: ['Agent: On a scale of 1 to 5, how satisfied are you at work?'],
    }),
    expectations: [
      { key: 'satisfaction', kind: 'answer', provenance: 'direct', band: 'clear', covered: true },
    ],
  },
  {
    id: 'terse-qualitative-is-partial',
    note: 'The nuance the rewrite adds: direct ≠ high confidence. A terse, vague FREE_TEXT answer is directly stated (so covered, not re-asked) but THIN — it lands in the partial band so the selector can choose to deepen it rather than treat it as a confident capture.',
    context: ctx({
      userMessage: "Yeah, it's alright I guess.",
      activeQuestionKey: 'culture',
      candidateSlots: [freeText('culture', 'How would you describe the team culture here?')],
    }),
    expectations: [
      { key: 'culture', kind: 'answer', provenance: 'direct', band: 'partial', covered: true },
    ],
  },
  {
    id: 'tangential-inference-is-unclear',
    note: 'The new low end: a position reached only by a weak, tangential inference should land in the unclear band and stay NOT covered (inferred + sub-threshold), so it remains eligible for a deepening follow-up. Flagged knownGap — emitting (and correctly low-scoring) a tangential fill is the calibration target, and a model miss here is reported apart from genuine regressions rather than gating the suite.',
    context: ctx({
      userMessage: 'We only just switched over to the new CRM last month.',
      activeQuestionKey: 'tools',
      candidateSlots: [freeText('tools', 'What tools do you use day to day?')],
      dataSlotCandidates: [
        {
          key: 'change_readiness',
          name: 'Change Readiness',
          description: 'How well the organisation adapts to and absorbs change.',
          theme: 'Organisation',
        },
      ],
      recentMessages: ['Agent: What tools do you use day to day?'],
    }),
    expectations: [
      {
        key: 'change_readiness',
        kind: 'dataSlotFill',
        provenance: 'inferred',
        band: 'unclear',
        covered: false,
      },
    ],
    knownGap: true,
  },
];
