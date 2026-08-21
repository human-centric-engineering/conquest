/**
 * Unit test: version-config conflict detection (authoring).
 *
 * Pure detector — no mocks. One case per rule (present ↔ absent), plus the "clean config → none" and
 * a couple of guard cases (capture off suppresses capture conflicts; non-form presentation suppresses
 * the form-only family). Each conflict is identified by its stable id.
 */

import { describe, it, expect } from 'vitest';

import {
  detectConfigConflicts,
  type ConfigConflictInput,
} from '@/lib/app/questionnaire/authoring/config-conflicts';
import type { HouseRuleKind } from '@/lib/app/questionnaire/types';

/** A coherent baseline — no conflicts. Override per case. */
function input(over: Partial<ConfigConflictInput> = {}): ConfigConflictInput {
  return {
    anonymousMode: false,
    presentationMode: 'both',
    captureEnabled: false,
    captureMode: 'form',
    profileFields: [],
    personaSelectionEnabled: false,
    reasoningStreamEnabled: false,
    voiceInputEnabled: false,
    attachmentInputEnabled: false,
    minQuestionsAnswered: 0,
    questionCount: 10,
    sensitivityAwareness: false,
    supportMessage: '',
    interviewerStrategyEnabled: false,
    interviewerApproach: 'funnel',
    openingMode: 'auto',
    openingExamples: [],
    houseRulesEnabled: false,
    houseRules: [],
    ...over,
  };
}

/** One enabled house rule — the shape most house-rule cases below vary. */
const houseRule = (
  kind: HouseRuleKind,
  text: string,
  trigger?: string
): { kind: HouseRuleKind; enabled: boolean; text: string; trigger?: string } => ({
  kind,
  enabled: true,
  text,
  ...(trigger ? { trigger } : {}),
});

const ids = (over: Partial<ConfigConflictInput>) =>
  detectConfigConflicts(input(over)).map((c) => c.id);

describe('detectConfigConflicts', () => {
  it('returns no conflicts for a coherent config', () => {
    expect(detectConfigConflicts(input())).toEqual([]);
  });

  describe('anonymous mode vs profile capture', () => {
    it('flags capture configured on an anonymous version', () => {
      const conflicts = detectConfigConflicts(
        input({ anonymousMode: true, captureEnabled: true, profileFields: [{}] })
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        id: 'anonymous-hides-capture',
        severity: 'error',
        sectionId: 'profile-fields',
      });
    });

    it('does not flag when capture is off (even if anonymous)', () => {
      expect(
        ids({ anonymousMode: true, captureEnabled: false, profileFields: [{}] })
      ).not.toContain('anonymous-hides-capture');
    });

    it('does not flag when capture is on but there are no fields', () => {
      expect(ids({ anonymousMode: true, captureEnabled: true, profileFields: [] })).not.toContain(
        'anonymous-hides-capture'
      );
    });
  });

  describe('form-only presentation family', () => {
    it('flags a conversational-placement field in a form-only questionnaire', () => {
      expect(
        ids({
          presentationMode: 'form',
          captureEnabled: true,
          captureMode: 'form',
          profileFields: [{ captureVia: 'conversational' }],
        })
      ).toContain('form-only-conversational-capture');
    });

    it('flags fields inheriting a conversational default in form-only', () => {
      expect(
        ids({
          presentationMode: 'form',
          captureEnabled: true,
          captureMode: 'conversational',
          profileFields: [{}],
        })
      ).toContain('form-only-conversational-capture');
    });

    it('does NOT flag conversational-capture conflict when presentation includes chat', () => {
      expect(
        ids({
          presentationMode: 'both',
          captureEnabled: true,
          captureMode: 'conversational',
          profileFields: [{}],
        })
      ).not.toContain('form-only-conversational-capture');
    });

    it('flags persona selection in form-only', () => {
      expect(ids({ presentationMode: 'form', personaSelectionEnabled: true })).toContain(
        'form-only-persona'
      );
    });

    it('flags reasoning stream in form-only', () => {
      expect(ids({ presentationMode: 'form', reasoningStreamEnabled: true })).toContain(
        'form-only-reasoning'
      );
    });

    it('flags composer inputs in form-only (voice and/or attachments)', () => {
      expect(ids({ presentationMode: 'form', voiceInputEnabled: true })).toContain(
        'form-only-composer'
      );
      const both = detectConfigConflicts(
        input({ presentationMode: 'form', voiceInputEnabled: true, attachmentInputEnabled: true })
      ).find((c) => c.id === 'form-only-composer');
      expect(both?.title).toMatch(/voice input and attachments/i);
    });

    it('raises none of the form-only family for a chat/both questionnaire', () => {
      const conflicts = ids({
        presentationMode: 'both',
        personaSelectionEnabled: true,
        reasoningStreamEnabled: true,
        voiceInputEnabled: true,
        attachmentInputEnabled: true,
      });
      expect(conflicts).toEqual([]);
    });
  });

  describe('completion + safeguarding', () => {
    it('flags a minimum-questions floor above the question count', () => {
      expect(ids({ minQuestionsAnswered: 12, questionCount: 10 })).toContain(
        'min-questions-unreachable'
      );
    });

    it('does not flag when the minimum is within the count (or count unknown)', () => {
      expect(ids({ minQuestionsAnswered: 10, questionCount: 10 })).not.toContain(
        'min-questions-unreachable'
      );
      expect(ids({ minQuestionsAnswered: 5, questionCount: 0 })).not.toContain(
        'min-questions-unreachable'
      );
    });

    it('flags sensitivity awareness with no support message', () => {
      const conflicts = detectConfigConflicts(
        input({ sensitivityAwareness: true, supportMessage: '   ' })
      );
      expect(conflicts.map((c) => c.id)).toContain('sensitivity-no-support');
      expect(conflicts.find((c) => c.id === 'sensitivity-no-support')?.severity).toBe('info');
    });

    it('does not flag sensitivity when a support message is present', () => {
      expect(
        ids({ sensitivityAwareness: true, supportMessage: 'Call the helpline on 123.' })
      ).not.toContain('sensitivity-no-support');
    });
  });

  it('surfaces multiple simultaneous conflicts', () => {
    const conflicts = ids({
      presentationMode: 'form',
      anonymousMode: true,
      captureEnabled: true,
      profileFields: [{ captureVia: 'conversational' }],
      reasoningStreamEnabled: true,
    });
    expect(conflicts).toEqual(
      expect.arrayContaining([
        'anonymous-hides-capture',
        'form-only-conversational-capture',
        'form-only-reasoning',
      ])
    );
  });
});

describe('detectConfigConflicts — opening examples', () => {
  /** Guided openings, switched on, with whatever examples the case supplies. */
  const guided = (openingExamples: string[], over: Partial<ConfigConflictInput> = {}) =>
    ids({
      interviewerStrategyEnabled: true,
      openingMode: 'examples',
      openingExamples,
      ...over,
    });

  it('notes guided openings switched on with nothing written', () => {
    expect(guided([])).toContain('opening-examples-empty');
    expect(guided(['Tell me about your week.'])).not.toContain('opening-examples-empty');
  });

  /**
   * Must agree with `usesGuidedOpening()`, which is what the runtime checks before swapping out the
   * interviewer's own framings menu. A whitespace-only row is not an example there either.
   */
  it('treats whitespace-only examples as nothing written', () => {
    expect(guided(['   ', ''])).toContain('opening-examples-empty');
  });

  it('says nothing while the mode is auto, however many examples are stored', () => {
    const stored = ['Tell me about your week.'];
    expect(guided(stored, { openingMode: 'auto' })).not.toContain('opening-examples-empty');
    expect(guided([], { openingMode: 'auto' })).not.toContain('opening-examples-empty');
  });

  it('says nothing while the whole strategy block is off', () => {
    expect(guided([], { interviewerStrategyEnabled: false })).not.toContain(
      'opening-examples-empty'
    );
  });

  it('notes that examples cannot apply under the targeted approach', () => {
    const written = ['Tell me about your week.'];
    expect(guided(written, { interviewerApproach: 'targeted' })).toContain(
      'opening-examples-targeted'
    );
    expect(guided(written, { interviewerApproach: 'funnel' })).not.toContain(
      'opening-examples-targeted'
    );
    expect(guided(written, { interviewerApproach: 'open' })).not.toContain(
      'opening-examples-targeted'
    );
  });

  it('does not stack both notes — with nothing written there is nothing to be unused', () => {
    const both = guided([], { interviewerApproach: 'targeted' });
    expect(both).toContain('opening-examples-empty');
    expect(both).not.toContain('opening-examples-targeted');
  });

  it('anchors both notes on the interviewer-strategy section', () => {
    const conflicts = detectConfigConflicts(
      input({ interviewerStrategyEnabled: true, openingMode: 'examples', openingExamples: [] })
    );
    const note = conflicts.find((c) => c.id === 'opening-examples-empty');
    expect(note?.sectionId).toBe('interviewer-strategy');
    // Informational: an inert setting is not a mistake, and an `error` here would read as blocking.
    expect(note?.severity).toBe('info');
  });
});

describe('detectConfigConflicts — house rules', () => {
  /** Turn the block on with the given rules. */
  const withRules = (
    rules: ReturnType<typeof houseRule>[],
    over: Partial<ConfigConflictInput> = {}
  ) => ids({ houseRulesEnabled: true, houseRules: rules, ...over });

  it('checks nothing while the block is switched off', () => {
    // A rule that would otherwise fire several checks, parked behind the master switch.
    const loud = houseRule('always', 'Tell them it is completely anonymous and use bullet points.');
    expect(ids({ houseRulesEnabled: false, houseRules: [loud] })).toEqual([]);
  });

  it('ignores an individually disabled rule — a draft is not a mistake', () => {
    const draft = { ...houseRule('always', 'Reply using bullet points.'), enabled: false };
    expect(withRules([draft])).not.toContain('house-rules-format-override');
  });

  it('ignores a rule with only whitespace for text', () => {
    expect(withRules([houseRule('always', '   ')])).toContain('house-rules-empty');
  });

  it('notes when the block is on with nothing switched on', () => {
    expect(withRules([])).toContain('house-rules-empty');
    expect(withRules([houseRule('never', 'Give advice.')])).not.toContain('house-rules-empty');
  });

  it('notes that rules cannot apply to a form-only questionnaire', () => {
    const rules = [houseRule('never', 'Give advice.')];
    expect(withRules(rules, { presentationMode: 'form' })).toContain('form-only-house-rules');
    expect(withRules(rules, { presentationMode: 'both' })).not.toContain('form-only-house-rules');
  });

  describe('anonymity', () => {
    it('warns when a rule promises anonymity but the questionnaire is not anonymous', () => {
      const rule = houseRule(
        'if_asked',
        'Yes — answers are completely anonymous.',
        'is this anonymous'
      );
      expect(withRules([rule], { anonymousMode: false })).toContain(
        'house-rules-overpromise-anonymity'
      );
      // Same rule on an actually-anonymous questionnaire is simply true.
      expect(withRules([rule], { anonymousMode: true })).not.toContain(
        'house-rules-overpromise-anonymity'
      );
    });

    it('reads only the rule text, never the trigger', () => {
      // A trigger is what the RESPONDENT asks about, not an instruction the interviewer follows.
      // Matching on it told admins their perfectly good "if asked how answers are scored" rule had
      // no effect — the exact noise the module's own rule 3 exists to prevent.
      const scoringTrigger = houseRule(
        'if_asked',
        'They are not scored — the team reads every answer in full.',
        'how their answers are scored'
      );
      expect(withRules([scoringTrigger])).not.toContain('house-rules-engine-controlled');

      const anonTrigger = houseRule(
        'if_asked',
        'Yes — nobody outside the team.',
        'is this anonymous'
      );
      expect(withRules([anonTrigger], { anonymousMode: false })).not.toContain(
        'house-rules-overpromise-anonymity'
      );
    });

    it('does not treat a "never" rule about confidentiality as an over-promise', () => {
      // "Never claim answers are confidential" is the OPPOSITE of over-promising.
      const rule = houseRule('never', 'Claim answers are confidential or untraceable.');
      expect(withRules([rule], { anonymousMode: false })).not.toContain(
        'house-rules-overpromise-anonymity'
      );
    });

    it('warns when a rule asks for identifying details on an anonymous questionnaire', () => {
      const rule = houseRule('always', 'Ask for their name and email before starting.');
      expect(withRules([rule], { anonymousMode: true })).toContain(
        'house-rules-identity-vs-anonymous'
      );
      expect(withRules([rule], { anonymousMode: false })).not.toContain(
        'house-rules-identity-vs-anonymous'
      );
    });

    it('does not flag a "never ask for names" rule under anonymous mode', () => {
      // This rule is exactly right for an anonymous questionnaire — warning about it would be the
      // panel arguing with a correct decision, which is how admins learn to ignore warnings.
      const rule = houseRule('never', 'Ask for the names of other people.');
      expect(withRules([rule], { anonymousMode: true })).not.toContain(
        'house-rules-identity-vs-anonymous'
      );
    });
  });

  it('warns when a rule points at support that is not configured', () => {
    const rule = houseRule('always', 'Offer them the support line if they seem distressed.');
    // Safeguarding off entirely…
    expect(withRules([rule], { sensitivityAwareness: false })).toContain(
      'house-rules-support-not-configured'
    );
    // …or on but with no message to show.
    expect(withRules([rule], { sensitivityAwareness: true, supportMessage: '  ' })).toContain(
      'house-rules-support-not-configured'
    );
    // Configured properly ⇒ silent.
    expect(
      withRules([rule], { sensitivityAwareness: true, supportMessage: 'Call 0800 000 0000.' })
    ).not.toContain('house-rules-support-not-configured');
  });

  it('does not tell an admin to configure support they deliberately forbade', () => {
    // "Never point them at a support line" + no support message configured is coherent, not a
    // conflict. Warning here would be the panel arguing with a correct decision.
    const rule = houseRule('never', 'Offer them the support line or a helpline.');
    expect(withRules([rule], { sensitivityAwareness: false })).not.toContain(
      'house-rules-support-not-configured'
    );
  });

  it('does not flag an "if asked" answer as an instruction the interviewer cannot follow', () => {
    // An if_asked rule's text is what the interviewer SAYS, not what it does — so a keyword there
    // describes the answer, not a request.
    expect(
      withRules([houseRule('if_asked', 'Answers are not scored.', 'whether answers are scored')])
    ).not.toContain('house-rules-engine-controlled');
    expect(
      withRules([houseRule('if_asked', 'Yes, bullet points are fine.', 'how to lay out an answer')])
    ).not.toContain('house-rules-format-override');
  });

  it.each([
    ['scoring', 'Score each answer out of ten.'],
    ['question order', 'Ask the questions in the order they appear.'],
    ['skipping', 'Skip the questions about pay.'],
    ['report content', 'Include their answers in the report.'],
  ])('warns about a rule directing %s — the interviewer does not control it', (_label, text) => {
    // The highest-value check: these read as perfectly reasonable instructions, the phraser cannot
    // honour any of them, and without this nothing tells the admin.
    expect(withRules([houseRule('always', text)])).toContain('house-rules-engine-controlled');
  });

  it.each([
    // "in order to" is one of the commonest phrases in English. Matching it would make the
    // engine-controlled check fire on ordinary rules and train admins to ignore the panel.
    'Ask a follow-up in order to understand what they mean.',
    // "points" as in "the points they raise", not a score.
    'Acknowledge the points they raise before moving on.',
  ])('does not fire the engine-controlled check on ordinary wording: %s', (text) => {
    expect(withRules([houseRule('always', text)])).not.toContain('house-rules-engine-controlled');
  });

  it('leaves an ordinary conversational rule alone', () => {
    // The guard against a noisy panel: a normal rule must trip nothing at all.
    expect(
      withRules([
        houseRule('always', 'Ask for a concrete recent example when an answer stays general.'),
      ])
    ).toEqual([]);
  });

  it('warns about a rule asking for a different reply layout', () => {
    expect(withRules([houseRule('always', 'Reply using bullet points.')])).toContain(
      'house-rules-format-override'
    );
    expect(withRules([houseRule('always', 'Reply as JSON.')])).toContain(
      'house-rules-format-override'
    );
  });

  it('warns about a rule asking for several questions in one turn', () => {
    expect(withRules([houseRule('always', 'Ask two questions at a time to save time.')])).toContain(
      'house-rules-multi-question'
    );
    expect(withRules([houseRule('always', 'Cover multiple questions per message.')])).toContain(
      'house-rules-multi-question'
    );
  });

  it('anchors every house-rule conflict to the house-rules section', () => {
    // The section id is what routes a warning to its inline slot; a typo would silently orphan it.
    const conflicts = detectConfigConflicts(
      input({
        houseRulesEnabled: true,
        houseRules: [houseRule('always', 'Score them and reply in bullet points.')],
      })
    );
    const houseRuleConflicts = conflicts.filter((c) => c.id.startsWith('house-rules-'));
    expect(houseRuleConflicts.length).toBeGreaterThan(0);
    expect(houseRuleConflicts.every((c) => c.sectionId === 'house-rules')).toBe(true);
  });

  it('orders conflicts errors → warnings → info regardless of check order', () => {
    // The house-rule checks append an `info` before the `warning` ones run, so this ordering comes
    // from the sort rather than from append order — and the card renders in the returned order.
    const conflicts = detectConfigConflicts(
      input({
        presentationMode: 'form',
        houseRulesEnabled: true,
        houseRules: [houseRule('always', 'Reply using bullet points.')],
      })
    );
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const ranks = conflicts.map((c) => rank[c.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(conflicts.some((c) => c.severity === 'info')).toBe(true);
    expect(conflicts.some((c) => c.severity === 'warning')).toBe(true);
  });

  it('never raises a house-rule conflict as a blocking error', () => {
    // These are keyword matches over free text and will sometimes be wrong. A false positive that
    // looks like a blocking mistake is worse than a missed warning.
    const conflicts = detectConfigConflicts(
      input({
        houseRulesEnabled: true,
        houseRules: [
          houseRule('always', 'Score each answer and use bullet points and ask two questions.'),
        ],
      })
    );
    expect(conflicts.filter((c) => c.severity === 'error')).toEqual([]);
  });
});
