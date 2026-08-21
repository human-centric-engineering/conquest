/**
 * Version-config conflict detection (authoring).
 *
 * A questionnaire's settings span several independent axes (presentation, identity, capture, tone,
 * safeguarding…). Some combinations are contradictory or silently no-op at runtime — e.g. profile
 * fields configured on an anonymous version are never collected, or a "conversation" that's actually
 * form-only can't run the interviewer. Left unsurfaced, an admin sets something and it just doesn't
 * happen. This pure detector inspects the *current* editor config and returns the active conflicts so
 * the config editor can flag them inline (per section) and in a summary banner, live as the admin edits.
 *
 * Each rule is grounded in the actual runtime gating (see the reference in each rule's comment). Pure:
 * no Prisma / React / IO — the same input the editor holds is enough. Non-blocking: these WARN, they
 * never prevent saving (some combinations are deliberate mid-edit states).
 */

import type {
  CaptureMode,
  HouseRuleKind,
  InterviewerApproach,
  InterviewerOpeningMode,
  PresentationMode,
} from '@/lib/app/questionnaire/types';

export type ConflictSeverity = 'error' | 'warning' | 'info';

export interface ConfigConflict {
  /** Stable id (for keys / tests). */
  id: string;
  severity: ConflictSeverity;
  /** The SettingsGroup anchor id where the alert is shown — the section of the affected/ignored setting. */
  sectionId: string;
  /** Short headline. */
  title: string;
  /** Admin-facing explanation + how to resolve. */
  message: string;
}

/** The slice of editor config the rules read. Numbers are already parsed (blank → 0). */
export interface ConfigConflictInput {
  anonymousMode: boolean;
  presentationMode: PresentationMode;
  /** Respondent-profile capture turned on AND at least one field configured. */
  captureEnabled: boolean;
  captureMode: CaptureMode;
  profileFields: ReadonlyArray<{ captureVia?: CaptureMode }>;
  personaSelectionEnabled: boolean;
  reasoningStreamEnabled: boolean;
  voiceInputEnabled: boolean;
  attachmentInputEnabled: boolean;
  minQuestionsAnswered: number;
  /** Number of questions in the questionnaire (0 when unknown). */
  questionCount: number;
  sensitivityAwareness: boolean;
  supportMessage: string;
  /** Interviewer-strategy master switch — off ⇒ the block is never sent, so nothing is checked. */
  interviewerStrategyEnabled: boolean;
  /** The questioning approach; decides whether an open opening exists for examples to shape. */
  interviewerApproach: InterviewerApproach;
  /** Where the opening question's framing comes from. */
  openingMode: InterviewerOpeningMode;
  /** The admin's example openers (all of them; the detector filters the blanks itself). */
  openingExamples: ReadonlyArray<string>;
  /** House-rules master switch — off ⇒ no rule can have any effect, so none are checked. */
  houseRulesEnabled: boolean;
  /** The version's house rules (all of them; the detector filters to the enabled ones itself). */
  houseRules: ReadonlyArray<{
    kind: HouseRuleKind;
    enabled: boolean;
    text: string;
    trigger?: string;
  }>;
}

/* ── House-rule text matching ─────────────────────────────────────────────────
 *
 * The house-rule checks below read free text an admin wrote, so they are keyword matches and will
 * never be exact. Three rules keep that honest:
 *
 *   1. **Never `error`.** A false positive must not look like a blocking mistake. These warn.
 *   2. **Word the message as "may not".** The detector is guessing at intent; the admin is not.
 *   3. **Prefer a missed warning to a noisy one.** Patterns are anchored on word boundaries and
 *      phrases rather than loose stems — an admin who learns to ignore this panel is worse off than
 *      one who never saw the warning.
 */

/**
 * Does any of `patterns` appear in the rule's text?
 *
 * **Text only — never the trigger.** A trigger is what the *respondent* raises, not an instruction
 * the interviewer follows, so a keyword there says nothing about what the rule asks the interviewer
 * to do. Searching it produced exactly the noise rule 3 above warns against: an `if_asked` rule
 * triggered on "how their answers are scored" tripped the engine-controlled check, telling the admin
 * their perfectly good rule had no effect.
 */
function mentions(rule: { text: string }, patterns: readonly RegExp[]): boolean {
  const haystack = rule.text.toLowerCase();
  return patterns.some((pattern) => pattern.test(haystack));
}

/** Claims about anonymity / confidentiality the interviewer would be making on the client's behalf. */
const ANONYMITY_CLAIM = [
  /\banonymous(ly)?\b/,
  /\banonymised\b/,
  /\banonymized\b/,
  /\bconfidential(ly|ity)?\b/,
  /\buntraceable\b/,
  /\bcan(’|')?t be traced\b/,
  /\bcannot be traced\b/,
  /\bnobody will know\b/,
  /\bno one will know\b/,
] as const;

/** Asking the respondent to identify themselves. */
const IDENTITY_REQUEST = [
  /\bnames?\b/,
  /\be-?mail\b/,
  /\bphone number\b/,
  /\bcontact details\b/,
  /\bjob title\b/,
  /\bidentify themsel(f|ves)\b/,
  /\bwho they are\b/,
] as const;

/** Pointing the respondent at a support service the safeguarding settings are supposed to supply. */
const SUPPORT_RESOURCE = [
  /\bsupport (link|line|service|resource|contact|details)\b/,
  // `help ?line` already subsumes "helpline"; a separate pattern for it was dead.
  /\bhelp ?line\b/,
  /\bsignpost\b/,
] as const;

/**
 * Things the deterministic orchestrator owns, not the interviewer. This is the highest-value check
 * here: an admin writes a perfectly reasonable-sounding instruction, the phraser has no ability to
 * honour it, and nothing anywhere tells them. The same trap `respondent-report.md` documents.
 */
const ENGINE_CONTROLLED = [
  /\bscor(e|es|ed|ing)\b/,
  // NOT a bare `\bpoints\b`: "acknowledge the points they raise" is ordinary interviewing, and
  // matching it fired this check on a perfectly good rule. `scor*` already covers real scoring.
  /\bskip\b/,
  /\bquestion order\b/,
  /\border of (the )?questions\b/,
  // "…in the order they appear". Deliberately not `\bin order\b`, which would match the extremely
  // common "in order to" and make this check fire on half the rules an admin writes.
  /\bin the order\b/,
  /\bquestions in order\b/,
  /\bwhich questions?\b/,
  /\bnext question\b/,
  /\bask (all|every) question\b/,
  /\b(the|their|a) (final )?report\b/,
] as const;

/** Reply-shape instructions `<output_format>` will override. */
const FORMAT_OVERRIDE = [
  // The trailing `\b` after an optional group does not match "bullets" — hence the explicit stem.
  /\bbullets?\b/,
  /\bbullet(ed| point| points)\b/,
  /\bnumbered list\b/,
  /\bheadings?\b/,
  /\bjson\b/,
  /\bmarkdown\b/,
  /\ba table\b/,
] as const;

/** Asking for more than one question in a turn — the one rule the prompt never relaxes. */
const MULTI_QUESTION = [
  // Digits as well as words — "ask 2 questions at a time" is at least as likely as "two".
  /\b(several|multiple|two|three|[2-9]) questions\b/,
  /\bmore than one question\b/,
  /\ball (the |of the )?questions at once\b/,
  /\bquestions at once\b/,
] as const;

/** Presentation order — errors first, then warnings, then info. */
const SEVERITY_ORDER: Record<ConflictSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Inspect the config and return every active conflict, ordered errors → warnings → info.
 *
 * The ordering is applied by a stable sort at the end rather than relied on from append order: the
 * house-rule checks append an `info` (block on but empty, or form-only) before the `warning` checks
 * run, so a form-only questionnaire with a keyword-tripping rule used to render its info above its
 * warning. Sorting makes the promise true however the checks are ordered in future.
 *
 * An empty array means no conflicts.
 */
export function detectConfigConflicts(input: ConfigConflictInput): ConfigConflict[] {
  const conflicts: ConfigConflict[] = [];
  const captureOn = input.captureEnabled && input.profileFields.length > 0;
  const formOnly = input.presentationMode === 'form';

  // 1 — Anonymous mode suppresses profile capture entirely (`resolve-capture.ts` returns null when
  //     `anonymousMode`). The admin configured fields that will never be collected.
  if (captureOn && input.anonymousMode) {
    conflicts.push({
      id: 'anonymous-hides-capture',
      severity: 'error',
      sectionId: 'profile-fields',
      title: 'Profile fields won’t be collected',
      message:
        'Anonymous mode is on, so identifying profile details are never collected — an anonymous ' +
        'questionnaire keeps responses unlinked to a person. Turn off Anonymous mode (Access & ' +
        'invitations) to collect these, or remove the fields.',
    });
  }

  // 2 — A form-only questionnaire never runs the interviewer, so any field collected "in conversation"
  //     (its `captureVia`, else the default `captureMode`) can never be gathered.
  const hasConversationalField =
    captureOn &&
    input.profileFields.some((f) => (f.captureVia ?? input.captureMode) === 'conversational');
  if (formOnly && hasConversationalField) {
    conflicts.push({
      id: 'form-only-conversational-capture',
      severity: 'error',
      sectionId: 'profile-fields',
      title: 'Conversational fields will never be asked',
      message:
        'This questionnaire is form-only, so there’s no conversation to gather fields “in ' +
        'conversation”. Set those fields’ placement to “Form”, or enable the conversation ' +
        '(Respondent experience → Presentation).',
    });
  }

  // 3 — The interviewer-persona picker rides the chat carousel; a form-only version has no chat, so
  //     `showPersona` (which requires `showChat`) is always false.
  if (formOnly && input.personaSelectionEnabled) {
    conflicts.push({
      id: 'form-only-persona',
      severity: 'warning',
      sectionId: 'tone',
      title: 'Interviewer selection has no effect',
      message:
        'Respondents can’t choose an interviewer in a form-only questionnaire — there’s no ' +
        'conversation. It applies once the conversation is enabled (Respondent experience → Presentation).',
    });
  }

  // 4 — The "watch it think" reasoning stream renders only in the chat surface.
  if (formOnly && input.reasoningStreamEnabled) {
    conflicts.push({
      id: 'form-only-reasoning',
      severity: 'warning',
      sectionId: 'reasoning',
      title: 'Reasoning stream won’t appear',
      message:
        'The reasoning stream only shows during the conversation, so it never appears in a ' +
        'form-only questionnaire.',
    });
  }

  // 5 — Voice / attachment inputs live in the chat composer, which form-only never shows.
  if (formOnly && (input.voiceInputEnabled || input.attachmentInputEnabled)) {
    const which =
      input.voiceInputEnabled && input.attachmentInputEnabled
        ? 'Voice input and attachments'
        : input.voiceInputEnabled
          ? 'Voice input'
          : 'Attachments';
    conflicts.push({
      id: 'form-only-composer',
      severity: 'warning',
      sectionId: 'experience',
      title: `${which} can’t be used`,
      message: `${which} live in the chat composer, which a form-only questionnaire doesn’t show. They apply once the conversation is enabled.`,
    });
  }

  // 6 — A minimum-questions floor above the questionnaire's size can never be satisfied.
  if (input.questionCount > 0 && input.minQuestionsAnswered > input.questionCount) {
    conflicts.push({
      id: 'min-questions-unreachable',
      severity: 'warning',
      sectionId: 'questions',
      title: 'Minimum can never be reached',
      message: `The minimum questions to answer (${input.minQuestionsAnswered}) is more than this questionnaire has (${input.questionCount}), so completion can never be met by that rule.`,
    });
  }

  // 7 — Sensitivity awareness with no support message shows no signpost (an empty message disables it).
  if (input.sensitivityAwareness && input.supportMessage.trim() === '') {
    conflicts.push({
      id: 'sensitivity-no-support',
      severity: 'info',
      sectionId: 'safeguarding',
      title: 'No support signpost will show',
      message:
        'Sensitivity awareness is on, but with no support message there’s nothing to show a ' +
        'respondent who raises something sensitive. Add a support message.',
    });
  }

  /* ── Interviewer strategy: opening examples ──────────────────────────────────
   *
   * Both checks are `info`: neither is a mistake, and both describe a setting that is simply inert
   * rather than wrong. They exist because an admin who has written openers reasonably believes they
   * are steering the conversation, and silence would let that belief stand when it isn't true.
   */
  if (input.interviewerStrategyEnabled && input.openingMode === 'examples') {
    const usableExamples = input.openingExamples.filter((example) => example.trim() !== '');

    // 8 — Guided openings switched on with nothing written. Mirrors `usesGuidedOpening()`, which is
    //     what the runtime actually checks before swapping out the interviewer's own framings menu.
    if (usableExamples.length === 0) {
      conflicts.push({
        id: 'opening-examples-empty',
        severity: 'info',
        sectionId: 'interviewer-strategy',
        title: 'No example opening questions yet',
        message:
          'Opening questions are set to be guided by examples, but none are written, so the ' +
          'interviewer will still choose its own opening. Add an example, or switch back to ' +
          'letting it choose.',
      });
    }

    // 9 — Examples written under an approach that has no open opening for them to shape. The
    //     targeted approach asks one specific question from the first turn, so there is no broad
    //     invitation for an example to be a model of.
    if (usableExamples.length > 0 && input.interviewerApproach === 'targeted') {
      conflicts.push({
        id: 'opening-examples-targeted',
        severity: 'info',
        sectionId: 'interviewer-strategy',
        title: 'Example openings won’t be used',
        message:
          'The targeted approach asks one specific question from the very first turn, so there is ' +
          'no broad opening for your examples to shape. Switch the approach to Funnel or Open ' +
          'throughout to use them.',
      });
    }
  }

  /* ── House rules ────────────────────────────────────────────────────────────
   *
   * Only ENABLED rules are checked, and only while the block itself is on — a parked rule is a
   * draft, and warning about a draft trains the admin to ignore the panel.
   */
  const activeRules = input.houseRulesEnabled
    ? input.houseRules.filter((rule) => rule.enabled && rule.text.trim() !== '')
    : [];

  if (input.houseRulesEnabled) {
    // 10 — House rules on with nothing to say. Not a mistake, but the admin probably meant to finish.
    if (activeRules.length === 0) {
      conflicts.push({
        id: 'house-rules-empty',
        severity: 'info',
        sectionId: 'house-rules',
        title: 'No house rules are switched on',
        message:
          'House rules are turned on but none are in use, so nothing is added to the interviewer. ' +
          'Add a rule, or switch this off.',
      });
    }

    // 11 — A form-only questionnaire never runs the interviewer, so no rule can take effect. Same
    //     family as checks 2–5 above.
    if (formOnly && activeRules.length > 0) {
      conflicts.push({
        id: 'form-only-house-rules',
        severity: 'info',
        sectionId: 'house-rules',
        title: 'House rules won’t apply',
        message:
          'House rules shape the interviewer, and a form-only questionnaire has no conversation. ' +
          'They apply once the conversation is enabled (Respondent experience → Presentation).',
      });
    }
  }

  // 12 — A rule promising anonymity on a questionnaire that isn't anonymous. The one that matters
  //      most: over-promising anonymity is a claim the client has to stand behind afterwards.
  const anonymityClaims = activeRules.filter(
    (rule) => rule.kind !== 'never' && mentions(rule, ANONYMITY_CLAIM)
  );
  if (anonymityClaims.length > 0 && !input.anonymousMode) {
    conflicts.push({
      id: 'house-rules-overpromise-anonymity',
      severity: 'warning',
      sectionId: 'house-rules',
      title: 'A rule may promise more anonymity than this questionnaire offers',
      message:
        'Anonymous mode is off, so answers are linked to the respondent. Check that any rule ' +
        'mentioning anonymity or confidentiality says only what your invitation and privacy notice ' +
        'actually say — or turn on Anonymous mode (Access & invitations).',
    });
  }

  // 13 — The mirror image: asking for identifying details on an anonymous questionnaire. `never`
  //      rules are excluded — "never ask for names" is exactly right under anonymous mode, not a
  //      conflict, and flagging it would be the panel arguing with a correct decision.
  // Only `always` can instruct the interviewer to ASK for identity. `never` is the correct rule
  // under anonymous mode, and an `if_asked` rule's text is an ANSWER ("no, we don't collect names")
  // — flagging either would be the panel arguing with a correct decision.
  const identityRequests = activeRules.filter(
    (rule) => rule.kind === 'always' && mentions(rule, IDENTITY_REQUEST)
  );
  if (identityRequests.length > 0 && input.anonymousMode) {
    conflicts.push({
      id: 'house-rules-identity-vs-anonymous',
      severity: 'warning',
      sectionId: 'house-rules',
      title: 'A rule may ask for details this questionnaire doesn’t collect',
      message:
        'Anonymous mode is on, so identifying details are never collected. A rule asking for a ' +
        'name, email, or contact details works against that — reword it, or turn off Anonymous ' +
        'mode (Access & invitations).',
    });
  }

  // 14 — Pointing at a support service that safeguarding isn't configured to provide.
  // `never` excluded for the same reason as 10 and 11: "never point them at a support line" is a
  // deliberate instruction, and telling that admin to go configure a support message is nonsense.
  const supportMentions = activeRules.filter(
    (rule) => rule.kind !== 'never' && mentions(rule, SUPPORT_RESOURCE)
  );
  if (
    supportMentions.length > 0 &&
    (!input.sensitivityAwareness || input.supportMessage.trim() === '')
  ) {
    conflicts.push({
      id: 'house-rules-support-not-configured',
      severity: 'warning',
      sectionId: 'house-rules',
      title: 'A rule points at support that isn’t set up',
      message:
        'A rule refers to a support service, but there’s no support message configured for this ' +
        'questionnaire — so there’s nothing for the interviewer to point to. Add one under Answer ' +
        'quality & safeguarding.',
    });
  }

  // 15 — Instructions the phraser structurally cannot honour. The highest-value check: without it
  //      the admin has no way to learn their rule is being ignored.
  // `if_asked` excluded: its text is what the interviewer SAYS to a respondent, not an
  // instruction it follows, so a keyword hit there describes the answer rather than a request.
  const engineControlled = activeRules.filter(
    (rule) => rule.kind !== 'if_asked' && mentions(rule, ENGINE_CONTROLLED)
  );
  if (engineControlled.length > 0) {
    conflicts.push({
      id: 'house-rules-engine-controlled',
      severity: 'warning',
      sectionId: 'house-rules',
      title: 'A rule may be asking for something the interviewer doesn’t control',
      message:
        'Scoring, which questions get asked and in what order, and what goes in the report are all ' +
        'decided outside the conversation — the interviewer can’t change them, so a rule about them ' +
        'has no effect. Use the Questions & completion, Definitions, or report settings instead.',
    });
  }

  // 16 — Reply-shape instructions that `<output_format>` overrides (it sits after house rules).
  // `if_asked` excluded: its text is what the interviewer SAYS to a respondent, not an
  // instruction it follows, so a keyword hit there describes the answer rather than a request.
  const formatOverrides = activeRules.filter(
    (rule) => rule.kind !== 'if_asked' && mentions(rule, FORMAT_OVERRIDE)
  );
  if (formatOverrides.length > 0) {
    conflicts.push({
      id: 'house-rules-format-override',
      severity: 'warning',
      sectionId: 'house-rules',
      title: 'A rule about layout won’t be followed',
      message:
        'The interviewer always replies in short conversational paragraphs — no lists, headings, or ' +
        'tables — so a rule asking for a different layout is overridden.',
    });
  }

  // 17 — Asking for more than one question a turn. The prompt's hardest rule; the only sanctioned
  //      exception is the "batch related questions" tactic under Interviewer strategy.
  // `if_asked` excluded: its text is what the interviewer SAYS to a respondent, not an
  // instruction it follows, so a keyword hit there describes the answer rather than a request.
  const multiQuestion = activeRules.filter(
    (rule) => rule.kind !== 'if_asked' && mentions(rule, MULTI_QUESTION)
  );
  if (multiQuestion.length > 0) {
    conflicts.push({
      id: 'house-rules-multi-question',
      severity: 'warning',
      sectionId: 'house-rules',
      title: 'A rule asking for several questions at once won’t be followed',
      message:
        'The interviewer asks one thing at a time, and a house rule can’t override that. To let it ' +
        'group closely-related gaps, use “Batch related questions” under Interviewer strategy.',
    });
  }

  // Stable within a severity (Array.prototype.sort is stable), so each band keeps check order.
  return conflicts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
