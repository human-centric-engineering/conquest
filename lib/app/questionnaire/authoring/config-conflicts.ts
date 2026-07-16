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

import type { CaptureMode, PresentationMode } from '@/lib/app/questionnaire/types';

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
}

/**
 * Inspect the config and return every active conflict, in a stable order (errors first, then warnings,
 * then info — the detector appends in that rough priority already). An empty array means no conflicts.
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

  return conflicts;
}
