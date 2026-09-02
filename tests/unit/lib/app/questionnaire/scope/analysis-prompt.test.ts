/**
 * Routing Analyst prompt builder — unit tests (P17.4).
 *
 * Two properties carry real weight here:
 *
 *   1. **Optional blocks cost nothing when absent, but the analyst is told plainly when it is
 *      working without a document or data slots** — unlike the Glossary Analyst's silent omission,
 *      this prompt always emits a DOCUMENT and DATA SLOTS section, just with a different message
 *      when the input is missing (`fromDocument` depends on the analyst knowing which case it's in).
 *   2. **Existing topics actually reach the model**, with their key, phase, source and criteria, so
 *      a re-run revises rather than duplicates — the analyst is told to reuse a key when it means
 *      the same topic.
 *
 * @see lib/app/questionnaire/scope/analysis-prompt.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildRoutingAnalysisPrompt,
  buildRoutingAnalysisRetryMessage,
} from '@/lib/app/questionnaire/scope/analysis-prompt';
import { LIGHT_DEPTH_MEMBER_COUNT, type Topic } from '@/lib/app/questionnaire/scope/types';

const QUESTIONS = [
  { key: 'q1', prompt: 'How many partners does your firm work through?', sectionTitle: 'Channel' },
  { key: 'q2', prompt: 'Describe your renewal process.' },
];

const DATA_SLOTS = [
  { key: 'channel_type', name: 'Channel type', theme: 'Go-to-market' },
  { key: 'company_size', name: 'Company size' },
];

function existingTopic(over: Partial<Topic> = {}): Topic {
  return {
    id: 'id-partner_channel',
    key: 'partner_channel',
    label: 'Partner channel',
    description: null,
    phase: 'conditional',
    criteria: 'They sell through partners or resellers',
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: [] },
    ordinal: 0,
    source: 'analyst',
    trigger: null,
    ...over,
  };
}

/** The user turn — everything variable lives there; the system turn is the fixed rubric. */
function userContent(messages: ReturnType<typeof buildRoutingAnalysisPrompt>): string {
  const user = messages.find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

describe('buildRoutingAnalysisPrompt', () => {
  it('returns a system rubric followed by one user turn', () => {
    const messages = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('includes every question prompt with its section title', () => {
    const content = userContent(buildRoutingAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).toContain('q1 [Channel]: How many partners does your firm work through?');
    expect(content).toContain('q2: Describe your renewal process.');
  });

  it('omits the goal and audience blocks when absent', () => {
    const content = userContent(buildRoutingAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).not.toContain('QUESTIONNAIRE GOAL');
    expect(content).not.toContain('AUDIENCE');
  });

  it('includes the goal and audience when supplied', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        goal: 'Assess channel readiness.',
        audience: { segment: 'B2B sales leaders' },
      })
    );
    expect(content).toContain('QUESTIONNAIRE GOAL');
    expect(content).toContain('Assess channel readiness.');
    expect(content).toContain('B2B sales leaders');
  });

  it('treats a null goal and audience as absent rather than printing "null"', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({ questions: QUESTIONS, goal: null, audience: null })
    );
    expect(content).not.toContain('QUESTIONNAIRE GOAL');
    expect(content).not.toContain('AUDIENCE');
    expect(content).not.toContain('null');
  });

  it('marks the instrument for the analyst to read first, and names the file', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        documents: [
          {
            role: 'primary',
            fileName: 'channel-instrument.pdf',
            text: 'Only ask the Partner Channel section if they sell through resellers.',
          },
        ],
      })
    );
    expect(content).toContain('THE INSTRUMENT (channel-instrument.pdf)');
    expect(content).toContain("Read the author's guidance in it first:");
    expect(content).toContain(
      'Only ask the Partner Channel section if they sell through resellers.'
    );
  });

  it('still marks the instrument when no filename is known', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        documents: [{ role: 'primary', text: 'Route by company size.' }],
      })
    );
    expect(content).toContain('THE INSTRUMENT —');
    expect(content).not.toContain('THE INSTRUMENT (');
  });

  it('says what a supporting document IS, and forbids inventing question keys from it', () => {
    // An analyst shown two documents with the same header has no way to tell guidance about an
    // instrument from a second instrument, and will happily propose topics for questions that do
    // not exist.
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        documents: [
          { role: 'primary', fileName: 'bank.md', text: 'Q1. How many partners?' },
          { role: 'supplementary', fileName: 'routing-memo.md', text: 'Resellers only.' },
        ],
      })
    );
    expect(content).toContain('SUPPORTING DOCUMENT (routing-memo.md)');
    expect(content).toContain('It carries guidance, not questions.');
    expect(content).toContain('never invent a question key from it');
    // The contradiction rule is the restraint half: report it, do not resolve it quietly.
    expect(content).toContain('report the disagreement in "gaps"');
  });

  it('says a supporting document was cut short, so nothing is quoted across the seam', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        documents: [
          { role: 'supplementary', fileName: 'long-memo.md', text: 'Part one…', truncated: true },
        ],
      })
    );
    expect(content).toContain('CUT SHORT where marked');
    expect(content).toContain('did not see all of it');
  });

  it('names a supporting document it could not afford to show, rather than hiding it', () => {
    // Silence here would be the worst outcome: the analyst reports confidently on an instrument
    // whose routing page it never saw, and nothing in the proposal says so.
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        documents: [{ role: 'supplementary', fileName: 'overflow.md', text: '', omitted: true }],
      })
    );
    expect(content).toContain('SUPPORTING DOCUMENT (overflow.md)');
    expect(content).toContain('NOT shown to you');
    expect(content).toContain('your reading of this instrument is incomplete');
  });

  it('does not mention supporting documents when there are none', () => {
    // The instrument-only prompt is what every version before F17.29 sent, and most versions still
    // send. A paragraph of rules about companion documents on a version that has none is spend.
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        documents: [{ role: 'primary', fileName: 'only.md', text: 'One file.' }],
      })
    );
    expect(content).not.toContain('SUPPORTING DOCUMENT');
    expect(content).not.toContain('describe ONE instrument between them');
  });

  it('tells the analyst plainly when no document is attached, rather than omitting the section', () => {
    const content = userContent(buildRoutingAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).toContain('SOURCE DOCUMENT: none is attached to this version.');
    expect(content).toContain('set "fromDocument" false');
  });

  it('lists data slots with their theme when present', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({ questions: QUESTIONS, dataSlots: DATA_SLOTS })
    );
    expect(content).toContain('DATA SLOTS (use these keys exactly):');
    expect(content).toContain('channel_type [Go-to-market]: Channel type');
    expect(content).toContain('company_size: Company size');
  });

  it('tells the analyst to propose question-only topics when there are no data slots', () => {
    const content = userContent(buildRoutingAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).toContain(
      'DATA SLOTS: none. Propose topics whose membership is questions alone.'
    );
    expect(content).not.toContain('DATA SLOTS (use these keys exactly)');
  });

  it('also falls back to the no-data-slots message when given an empty array', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({ questions: QUESTIONS, dataSlots: [] })
    );
    expect(content).toContain(
      'DATA SLOTS: none. Propose topics whose membership is questions alone.'
    );
  });

  it('lists existing topics with their key, phase, source and criteria, telling the analyst to reuse keys', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        existingTopics: [existingTopic()],
      })
    );
    expect(content).toContain('TOPICS ALREADY ON THIS VERSION');
    expect(content).toContain('Reuse a key');
    expect(content).toContain(
      '- partner_channel (conditional, analyst): Partner channel — include when: They sell through partners or resellers'
    );
  });

  it('omits the "include when" clause for an existing topic with no criteria', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        existingTopics: [existingTopic({ key: 'core_ops', criteria: null, phase: 'core' })],
      })
    );
    expect(content).toContain('- core_ops (core, analyst): Partner channel');
    expect(content).not.toContain('include when');
  });

  it('omits the existing-topics block when the list is empty', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({ questions: QUESTIONS, existingTopics: [] })
    );
    expect(content).not.toContain('TOPICS ALREADY ON THIS VERSION');
  });

  it('includes the administrator note for this run, trimmed', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        instructions: '  The routing rules are on the Guardrails tab.  ',
      })
    );
    expect(content).toContain("ADMINISTRATOR'S NOTE FOR THIS RUN:");
    expect(content).toContain('The routing rules are on the Guardrails tab.');
    // Trimmed — no leading/trailing whitespace carried into the rendered block.
    expect(content).not.toContain('RUN:\n  The routing');
  });

  it('omits the administrator note block when it is only whitespace', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({ questions: QUESTIONS, instructions: '   ' })
    );
    expect(content).not.toContain("ADMINISTRATOR'S NOTE FOR THIS RUN");
  });

  it('omits the administrator note block when absent', () => {
    const content = userContent(buildRoutingAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).not.toContain("ADMINISTRATOR'S NOTE FOR THIS RUN");
  });

  it('states the phase vocabulary, the quoting-versus-inferring rule and the output contract', () => {
    const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
    const rubric = typeof system.content === 'string' ? system.content : '';
    // The grounding instruction is the load-bearing half of this prompt.
    expect(rubric).toContain('OMIT "sourceQuote" entirely');
    expect(rubric).toContain('Set "fromDocument" true only when');
    expect(rubric).toContain('"opening"');
    expect(rubric).toContain('"core"');
    expect(rubric).toContain('"conditional"');
    expect(rubric).toContain('"closing"');
    expect(rubric).toContain('Propose at most 40 topics');
    expect(rubric).toContain('Output ONLY a single JSON object');
  });

  it('states the gaps rubric — required quote, capped count', () => {
    const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
    const rubric = typeof system.content === 'string' ? system.content : '';
    expect(rubric).toContain('## Gaps');
    expect(rubric).toContain('"sourceQuote" is REQUIRED');
    expect(rubric).toContain('Report at most 15 gaps');
    expect(rubric).toContain('"gaps"');
  });

  // Corpus doc 04 (R005) filed five gaps on one run and none on the next, from one file on one
  // build. Both readings were available in the prompt: the gap test used to open with "the
  // condition names something not in DATA SLOTS", and at ingest DATA SLOTS is ALWAYS empty (slots
  // are generated by a later, separate pass), so every conditional topic satisfied it. The bar is
  // now "cannot express it at all", which no successfully-criteria'd topic can meet.
  describe('a condition that WAS expressed is not a gap', () => {
    const rubric = () => {
      const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
      return typeof system.content === 'string' ? system.content : '';
    };

    it('sets the bar at inexpressible, not merely un-ruleable', () => {
      expect(rubric()).toContain('cannot express it AT ALL');
    });

    it('says outright that a criteria-ed topic is not also a gap', () => {
      expect(rubric()).toContain(
        "**A condition you DID express as a conditional topic's criteria is not a gap.**"
      );
    });

    it('names the empty-DATA-SLOTS case, which is every ingest', () => {
      const text = rubric();
      expect(text).toContain('is NOT on its own a gap');
      expect(text).toContain('data slot behind a condition is NOT on its own a gap');
    });

    it('no longer offers "not in DATA SLOTS" as a stand-alone reason to gap', () => {
      // The regression this guards: reinstating that clause makes gapping every conditional topic
      // a defensible reading again, and `gaps[]` is the signal docs 07/08/10 are scored on.
      expect(rubric()).not.toContain('the condition names something not in DATA SLOTS');
    });

    it('still keeps the reasons that ARE gaps — including the mid-interview one', () => {
      const text = rubric();
      expect(text).toContain('no question captures');
      expect(text).toContain('contradicts another instruction');
      expect(text).toContain('mid-interview rather than at the opening');
      expect(text).toContain('too vague to act on');
    });
  });

  /**
   * T07 — the corpus's one confirmed-critical finding, and the reason the rule above needed two
   * exceptions carved out of it.
   *
   * The R005 fix ("a condition you DID express is not a gap") was right for what it was aimed at,
   * and it also told the analyst not to declare a trigger it had just converted. Doc 07 coerced all
   * five triggered blocks on four runs across two builds, doc 08 coerced its estate-planning
   * trigger, and doc 10 coerced four escalation triggers — every run filing ONE gap about "the
   * mechanism" and then presenting the blocks as ordinary conditional topics.
   *
   * These tests do NOT assert that the coercion stops. It cannot stop until scope can be revisited
   * mid-interview, which is a product decision and a feature, not a prompt. They pin the half that
   * is fixable now: that the coercion is DECLARED, per block, in the array the corpus scores.
   */
  describe('a trigger that fires mid-interview must be declared per block (T07)', () => {
    const rubric = () => {
      const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
      return typeof system.content === 'string' ? system.content : '';
    };

    it('carves the timing case out of the "expressed is not a gap" rule', () => {
      const text = rubric();
      expect(text).toContain('Three exceptions to that');
      expect(text).toContain('what you wrote does not mean what the document said');
    });

    it('names the trigger phrasings the corpus actually contains', () => {
      const text = rubric();
      // Doc 07 ("at any stage", "even while answering something else"), doc 10 ("whenever they
      // surface", "even in passing"), doc 08 ("only ever asked where the client raises it").
      for (const phrase of [
        'at any stage',
        'at any point',
        'whenever they surface',
        'even in passing',
        'even while answering something else',
      ]) {
        expect(text).toContain(phrase);
      }
    });

    it('still tells it to propose the topic, because an orphaned block is worse', () => {
      const text = rubric();
      expect(text).toContain('STILL PROPOSE THE TOPIC');
      // validate.ts: with scope active a question belonging to no topic can never be asked.
      expect(text).toContain('could then never be asked at all');
    });

    it('demands one gap per block, not one about the mechanism', () => {
      const text = rubric();
      expect(text).toContain('ONE GAP PER BLOCK');
      expect(text).toContain('One gap about "the mechanism" is NOT enough');
    });

    it('makes the analyst state what will actually happen at runtime', () => {
      const text = rubric();
      expect(text).toContain('settled ONCE, when the opening finishes');
      expect(text).toContain('included only if the condition is already apparent by then');
    });
  });

  /**
   * The doc 10 half. Its critical failure is "the terminating screener absent from gaps[] — a stop
   * condition discarded", and R010 saw exactly that: the screener became an `opening` topic WITH
   * QUESTIONS on both runs, so the facts were captured and the consequence ("stop the review") was
   * thrown away. SCOPE_RULE_ACTIONS is `include | exclude` — nothing can halt an interview — so this
   * is inexpressible under the existing bar; the analyst simply did not recognise it as such.
   */
  describe('an instruction that ends the interview must be gapped (T07, doc 10)', () => {
    const rubric = () => {
      const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
      return typeof system.content === 'string' ? system.content : '';
    };

    it('names the stop phrasings doc 10 uses', () => {
      const text = rubric();
      expect(text).toContain('stop the review');
      expect(text).toContain('end the conversation here');
    });

    it('says why excluding every topic is not the same thing', () => {
      expect(rubric()).toContain('excluding every topic is not the same thing');
    });

    it('closes the loophole of turning a screener into ordinary opening questions', () => {
      const text = rubric();
      expect(text).toContain('captures the fact and discards the consequence');
      expect(text).toContain('the review will continue regardless of the answer');
    });
  });

  /**
   * The doc 08 half of the same finding. "Do not pick a side quietly" existed, but only in the
   * branch that fires when a SUPPLEMENTARY document is attached — so a document that contradicts
   * itself (doc 08's front-sheet table versus its page-2 adviser notes, four times) never triggered
   * it, and the analyst resolved all four in favour of the notes without ever saying they conflict.
   */
  describe('a document that contradicts itself must surface the conflict (T07, doc 08)', () => {
    const rubric = () => {
      const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
      return typeof system.content === 'string' ? system.content : '';
    };

    it('applies the no-quiet-resolution rule inside one document', () => {
      const text = rubric();
      expect(text).toContain('WITHIN a single document, not only between two documents');
    });

    it('requires both sides quoted, so the admin can see the choice made for them', () => {
      const text = rubric();
      expect(text).toContain('quoting BOTH places');
      expect(text).toContain('a choice was made on their behalf');
    });
  });
});

describe('buildRoutingAnalysisRetryMessage', () => {
  it('names the required shape without echoing the malformed output', () => {
    const message = buildRoutingAnalysisRetryMessage();
    expect(message).toContain('"topics"');
    expect(message).toContain('lowercase_snake_case');
    expect(message).toContain('"criteria"');
    expect(message).toContain('"gaps"');
    expect(message).toContain('"fromDocument"');
    expect(message).toContain('No prose, no code fences');
  });
});

describe('the rubric the analyst kept getting wrong (F17.23)', () => {
  /** The system turn — where SYSTEM_RULES lives. */
  const rubric = () => buildRoutingAnalysisPrompt({ questions: QUESTIONS })[0].content;

  describe('depth', () => {
    it('forbids light on every phase that runs for everyone, by name', () => {
      const text = rubric();
      expect(text).toContain('NEVER set "light" on an "opening", "core" or "closing" topic');
    });

    it('says what light actually costs, in members rather than adjectives', () => {
      // The old rubric called light "a sample of the most important few", which reads as a
      // refinement rather than a deletion — and the analyst proposed it on openings twice on real
      // instruments. Naming the number is what makes the instruction checkable.
      expect(rubric()).toContain(`${LIGHT_DEPTH_MEMBER_COUNT} highest-weighted questions`);
    });

    it('names full as the answer when the document says nothing about depth', () => {
      expect(rubric()).toContain('If the document says nothing about depth, use "full"');
    });
  });

  describe('the two settings that are not topics', () => {
    it('teaches both fields', () => {
      const text = rubric();
      expect(text).toContain('"fallbackTopicKeys"');
      expect(text).toContain('"checkTopicPreference"');
    });

    it('says the fallback list is used only when nothing else was chosen', () => {
      // The distinction that matters: it is not a preference ordering, and folding it into topic
      // criteria instead (which is what the analyst used to do) is a different runtime path.
      expect(rubric()).toContain('ONLY when nothing else was chosen');
    });

    it('tells the analyst to omit them rather than guess, like maxConditionalTopics', () => {
      expect(rubric()).toContain('OMIT the field');
    });

    it('stops them being reported as unformalizable gaps', () => {
      // `plannerInstructions` joined this list when it became proposable — same argument, same
      // sentence, so it is extended rather than duplicated.
      expect(rubric()).toContain(
        'Do NOT report a gap for anything "fallbackTopicKeys", "checkTopicPreference" or "plannerInstructions" can express'
      );
    });

    it('puts both keys in the output template', () => {
      const text = rubric();
      expect(text).toContain('"fallbackTopicKeys": [');
      expect(text).toContain('"checkTopicPreference": [');
    });
  });
});

describe('the trigger record, and the voice its cues have to be in (F17.31a)', () => {
  const rubric = () => buildRoutingAnalysisPrompt({ questions: QUESTIONS })[0].content;

  it('asks for the trigger alongside the gap, not instead of it', () => {
    const text = rubric();
    expect(text).toContain('ALSO fill the topic\'s "trigger" field');
    expect(text).toContain('does not replace the gap');
  });

  it("sends the instruction's own words to condition and sourceQuote", () => {
    expect(rubric()).toContain("the instruction's own words belong in");
  });

  it("demands cues in the RESPONDENT's voice, and forbids lifting the instruction", () => {
    // The first live run of doc 07 came back with "someone they live with", "have lived with" and
    // "tenancy block has already been completed" — faithful to the document, and not one of them a
    // phrase anybody says while answering a question. Cue voice is what an eventual gate's recall
    // rests on, so the instruction is pinned here rather than left to drift.
    const text = rubric();
    expect(text).toContain('the words the RESPONDENT would say');
    expect(text).toContain('Do NOT lift phrases from the instruction');
    expect(text).toContain('third person');
  });

  it('teaches the transformation with an example from no domain the corpus measures', () => {
    // A worked example is what makes this land, and a housing- or safeguarding-flavoured one would
    // hand the routing corpus' hardest documents their own answer. Deliberately unrelated.
    expect(rubric()).toContain('dietary restriction');
  });

  it('carries "trigger" in the output shape, not only in the prose above it', () => {
    // Models follow the literal JSON template far more reliably than an instruction a hundred lines
    // earlier. With the field absent from the template the analyst emits it inconsistently or not
    // at all, and every other part of F17.31a is downstream of it being emitted.
    const content = rubric();
    const text = typeof content === 'string' ? content : '';
    const template = text.slice(text.indexOf('Output ONLY a single JSON object'));

    expect(template).toContain('"trigger"');
    expect(template).toContain('"condition"');
    expect(template).toContain('"cues"');
    // Nearly every topic has no trigger, so the template must say so — otherwise the shape reads
    // as required and the analyst invents one per topic.
    expect(template).toContain('OMIT ENTIRELY unless TIMING applies');
  });
});

describe('criteria is the only field that reaches the runtime', () => {
  /**
   * The defect this suite pins: `askPlanner` renders a candidate topic as key + name +
   * `choose when: <criteria>` and sends nothing else. A precedence rule the analyst faithfully
   * quoted into `sourceQuote` — but did not fold into the criteria — therefore changes what no
   * respondent is ever asked. The rubric has to say so, because the failure is invisible on the
   * review surface: the admin can SEE the quote, so the proposal looks complete.
   */
  function rubric(): string {
    const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
    return typeof system.content === 'string' ? system.content : '';
  }

  it('tells the analyst that only the criteria is shown when the topic is judged', () => {
    expect(rubric()).toContain('NOTHING ELSE');
  });

  it('names the four kinds of material that must be folded into the criteria', () => {
    const content = rubric();
    // Not a vocabulary to match against — the four things a document says ABOUT a condition that
    // change how it should be judged. Each was previously stranded in sourceQuote.
    expect(content).toContain('WHAT POINTS TO IT');
    expect(content).toContain('PRECEDENCE AND EXCLUSIVITY');
    expect(content).toContain('STRENGTH');
    expect(content).toContain('HOW TO TREAT IT');
  });

  it('requires the material to be found by comprehension, not by matching a heading', () => {
    const content = rubric();
    expect(content).toContain('FIND THIS MATERIAL BY READING IT, NOT BY LOOKING FOR A LABEL');
    // The user's own instruments label this column differently every time; a rubric that named
    // "listen for" or "notes" as the thing to find would be the keyword-matching this replaced.
    expect(content).toContain('never by what it is called');
  });

  it('says a tie-break between two competing topics must appear on BOTH of them', () => {
    const content = rubric();
    expect(content).toContain('Where two topics compete');
    expect(content).toContain('criteria of BOTH topics');
  });

  it('guards against padding — completeness is the goal, not length', () => {
    expect(rubric()).toContain('length is not the goal');
  });
});

describe('the administrator note is not buried', () => {
  /**
   * It used to be the LAST block in the user turn, appended after the whole instrument, every
   * question and every existing topic — so an explicit steer sat behind tens of thousands of
   * characters, and the rubric never acknowledged it could exist at all. Both halves are fixed:
   * the rubric names it, and it leads the turn.
   */
  it('places the note before the document and question blocks', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        goal: 'Qualify inbound leads',
        documents: [{ role: 'primary', fileName: 'lead-gen.md', text: 'Routing table follows.' }],
        instructions: 'The routing rules are in the notes column.',
      })
    );
    const noteAt = content.indexOf("ADMINISTRATOR'S NOTE FOR THIS RUN:");
    expect(noteAt).toBeGreaterThanOrEqual(0);
    expect(noteAt).toBeLessThan(content.indexOf('THE INSTRUMENT'));
    expect(noteAt).toBeLessThan(content.indexOf('QUESTIONS (use these keys exactly):'));
  });

  it('tells the analyst in the rubric that such a note may arrive, and to follow it', () => {
    const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
    const content = typeof system.content === 'string' ? system.content : '';
    expect(content).toContain('ADMINISTRATOR');
    expect(content).toContain('FOLLOW IT');
    // Following a steer must not become licence to invent routing the document never stated.
    expect(content).toContain('does not license inventing');
  });
});

describe('the criteria shape the renderer already recovers', () => {
  /**
   * `scope/criteria-format.ts` parses criteria into a bulleted list with a `term` and a `priority`
   * chip per signal — it has always been able to draw that shape, but nothing told the analyst to
   * produce it, so richer criteria would have arrived as one grey paragraph. The three priority
   * spellings here must stay in step with `PRIORITY` in that module.
   */
  function rubric(): string {
    const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
    return typeof system.content === 'string' ? system.content : '';
  }

  it('asks for one line per signal as a bulleted list', () => {
    expect(rubric()).toContain('ONE LINE PER SIGNAL');
  });

  it('names the exact priority spellings criteria-format parses', () => {
    const content = rubric();
    // `PRIORITY = /\s*\((high|medium|low)[\s-]*priority\)\s*/i` — anything else renders as prose.
    expect(content).toContain('(high priority)');
    expect(content).toContain('(medium priority)');
    expect(content).toContain('(low priority)');
  });

  it('forbids inventing a weight the document never stated', () => {
    expect(rubric()).toContain('leave the marker off rather than');
  });

  it('keeps a plain paragraph legal, so the shape never distorts the author', () => {
    expect(rubric()).toContain('never distort what the author said to fit the shape');
  });
});

describe('cross-cutting guidance is proposable (Extra guidance)', () => {
  /**
   * `plannerInstructions` used to be deliberately un-proposable, on the reasoning that "an analyst
   * writing its own steering is a loop worth not building". It steers the PLANNER — a different
   * agent, at a different point in the session — and documents state this kind of guidance
   * routinely, so with nowhere to put it the analyst filed it as an unformalizable `gap`. That is
   * the exact defect F17.23 fixed for `fallbackTopicKeys` / `checkTopicPreference`.
   */
  function rubric(): string {
    const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
    return typeof system.content === 'string' ? system.content : '';
  }

  it('gives cross-cutting guidance a home and says why topics cannot hold it', () => {
    const content = rubric();
    expect(content).toContain('Guidance that is about no single topic');
    expect(content).toContain('plannerInstructions');
  });

  it('is in the output contract', () => {
    expect(rubric()).toContain('"plannerInstructions"');
  });

  it('omits rather than defaults when the document is silent', () => {
    const content = rubric();
    expect(content).toContain('OMIT the field');
    expect(content).toContain('silence is the common and correct');
  });

  it('rules out the three things it is not, so it does not become a dumping ground', () => {
    const content = rubric();
    // A condition about ONE topic belongs in criteria — the field the runtime actually reads.
    expect(content).toContain('NOT a place for a condition about one topic');
    expect(content).toContain('NOT a summary of what you already wrote');
    // Phrasing/tone has its own settings; guidance about it here is silently inert.
    expect(content).toContain('NOT tone or wording');
  });

  it('stops it being double-reported as a gap', () => {
    expect(rubric()).toContain(
      'Cross-cutting guidance in particular is NOT a gap just because it fits no single topic'
    );
  });
});
