/**
 * Respondent intro / splash copy — pure derivation from a version's settings.
 *
 * The splash explains HOW the questionnaire works (varies by {@link PresentationMode}) and WHAT the
 * respondent receives at the end (varies by {@link RespondentReportSettings}), plus a few practical
 * notes (honesty, anonymity, voice). None of this copy is stored — it is derived from config at
 * runtime so it always matches the live settings. The admin-authored "about this questionnaire"
 * background section is separate (stored, optionally cohort-overridden) and rendered above this.
 *
 * Pure: no Prisma / Next / I/O. The unit tests pin the full mode × report-mode × delivery matrix.
 * British-English spelling, matching the rest of the app surface.
 */

import type { PresentationMode, RespondentReportSettings } from '@/lib/app/questionnaire/types';

/** One titled prose block on the splash. */
export interface IntroSection {
  heading: string;
  body: string;
}

/** The derived, ready-to-render copy for the splash (everything except the stored background). */
export interface IntroCopy {
  /** "How it works" — always present; varies by presentation mode. */
  howItWorks: IntroSection;
  /** "What you'll get at the end" — null when the respondent report is off. */
  whatYouGet: IntroSection | null;
  /** Short practical notes (honesty always; anonymity / voice when applicable). */
  goodToKnow: string[];
  /** The proceed-button label (admin override, else a per-mode default). */
  buttonLabel: string;
}

/** Inputs the copy derives from — the resolved, runtime-effective version settings. */
export interface IntroCopyInput {
  presentationMode: PresentationMode;
  report: RespondentReportSettings;
  anonymousMode: boolean;
  voiceEnabled: boolean;
  /** Admin-authored button label; `''` = use the per-mode default. */
  buttonLabelOverride: string;
}

const HOW_IT_WORKS: Record<PresentationMode, IntroSection> = {
  chat: {
    heading: 'How it works',
    body: 'This is a conversation, not a form. Rather than filling in boxes, you’ll chat with a guide that asks one question at a time. Answer in your own words — a full sentence or a quick phrase, whatever feels natural. It listens, follows up where useful, and keeps track so you don’t have to.',
  },
  form: {
    heading: 'How it works',
    body: 'You’ll work through a set of questions grouped into sections, choosing or typing the answer that fits. Move between sections freely and review everything before you finish.',
  },
  both: {
    heading: 'How it works',
    body: 'It’s your choice: answer through a natural conversation or fill in a structured form — and switch between the two at any time. Start whichever feels easier; your answers carry across both.',
  },
};

const BUTTON_DEFAULTS: Record<PresentationMode, string> = {
  chat: 'Start the conversation',
  form: 'Start the questionnaire',
  both: 'Get started',
};

/** Build the " … to view on screen and download as a PDF" tail from the delivery toggles. */
function deliveryClause(delivery: RespondentReportSettings['delivery']): string {
  if (delivery.onScreen && delivery.download) return ', to view on screen and download as a PDF';
  if (delivery.onScreen) return ', to view on screen';
  if (delivery.download) return ', which you can download as a PDF';
  return '';
}

/** Build the "What you'll get at the end" section, or null when the report is off. */
function whatYouGet(report: RespondentReportSettings): IntroSection | null {
  if (!report.enabled) return null;
  const tail = deliveryClause(report.delivery);
  const heading = 'What you’ll get at the end';

  switch (report.mode) {
    case 'raw':
      return {
        heading,
        body: `When you finish, you’ll get a clear summary of everything you shared${tail}.`,
      };
    case 'raw_plus_insights':
      return {
        heading,
        body: `When you finish, you’ll receive a summary of your answers alongside a tailored insights section drawn from what you shared${tail}. It’s prepared just after you submit, so it may take a moment.`,
      };
    case 'narrative':
      return {
        heading,
        body: `When you finish, your answers are woven into a personalised written report — analysis and observations in flowing prose, not just a list${tail}. It’s prepared just after you submit, so it may take a moment.`,
      };
    default:
      return null;
  }
}

/** Practical notes: honesty always, anonymity / voice when those settings apply. */
function goodToKnow(input: IntroCopyInput): string[] {
  const notes = ['There are no right or wrong answers — just answer honestly.'];
  if (input.anonymousMode) {
    notes.push(
      'This questionnaire is anonymous — your name and contact details won’t be passed on.'
    );
  }
  if (input.voiceEnabled) {
    notes.push('You can type your replies, or tap the mic to speak your answers.');
  }
  return notes;
}

/**
 * Derive the splash copy from a version's effective settings. Pure + deterministic so it's safe to
 * call server-side (page render / intro endpoint) and to unit-test exhaustively.
 */
export function buildIntroCopy(input: IntroCopyInput): IntroCopy {
  const buttonLabel = input.buttonLabelOverride.trim() || BUTTON_DEFAULTS[input.presentationMode];
  return {
    howItWorks: HOW_IT_WORKS[input.presentationMode],
    whatYouGet: whatYouGet(input.report),
    goodToKnow: goodToKnow(input),
    buttonLabel,
  };
}
