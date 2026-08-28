/**
 * The respondent surface's per-version configuration, as a single resolved bundle.
 *
 * Every respondent surface needs the same set of answers before it can paint a session: which
 * affordances exist (voice, attachments, inline correction), which surfaces the respondent
 * completes through (`presentationMode`, `answerPanelScope`), how the interviewer's thinking is
 * shown, whose brand the conversation wears, and which words carry definitions. The page-rendered
 * surfaces (`/q/[versionId]`, `/x/[publicRef]`) resolve all of that server-side and hand it down as
 * props, re-resolving on every server render — which is why a `/x` handoff to a leg running a
 * DIFFERENT questionnaire correctly re-themes and re-gates: continuing there is a `router.refresh`.
 *
 * A CLIENT-BOOTED surface has no such moment. The facilitated-meeting participant surface
 * (P15.5) mounts once and then swaps sessions in place as breakouts start, so nothing ever
 * re-runs a server component — and until this bundle existed it simply ran the workspace on its
 * prop defaults. Every authored choice was therefore ignored in a breakout: a version with voice,
 * attachments or inline correction switched ON showed none of them, `presentationMode: 'chat'`
 * still got a Form tab, a `hidden` answer panel still got a panel, and the reasoning stream (which
 * a version with no config row gets by default) never appeared at all.
 *
 * ## Why this is keyed on the SESSION, not the version or the run
 *
 * The obvious alternative was to widen the meeting's join payload. It does not work: the
 * participant's session does not exist at join — it is minted lazily when a breakout starts — so
 * the payload that could carry config is not the payload that reveals the session. There are three
 * separate moments a session id arrives (join, the participant poll, choosing a breakout room),
 * and a per-room questionnaire (`AppExperienceBreakoutRoom.versionId`) means two participants in
 * the SAME breakout can legitimately need different config. Keying on the session collapses all of
 * that to one rule: when the session id changes, re-read the surface.
 *
 * Pure contract — no Prisma, no React. The DB seam is `./resolve-surface-config`; the wire
 * fetcher is `./boot-fetchers`. Split for the same reason `header/types` and `header/resolve` are:
 * the client components that consume this shape must not pull a Prisma import into their bundle.
 *
 * @see .context/app/questionnaire/experience-meetings.md
 */

import type { GlossaryAppendixView, GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';
import type { BandHeader } from '@/lib/app/questionnaire/header/types';
import type { ResolvedTheme } from '@/lib/app/questionnaire/theming';
import type {
  AnswerSlotPanelScope,
  PresentationMode,
  ReasoningPlacement,
  RespondentLayout,
} from '@/lib/app/questionnaire/types';

/**
 * Everything a client-booted respondent surface needs to paint one session correctly.
 *
 * Deliberately the RESOLVED values, not the raw config row: `reasoningPlacement` is already null
 * when the feature is off, and `glossary` is already `[]` when respondent hints are off, so no
 * consumer carries a flag of its own or re-derives a default. That is the same contract the
 * page-rendered surfaces get from the per-field resolvers in `chat/anonymity.ts`, and
 * `tests/unit/lib/app/questionnaire/session/resolve-respondent-surface.test.ts` pins the two together
 * so they cannot drift.
 *
 * What is deliberately NOT here: the pre-chat gates (intro splash, persona picker, profile
 * capture) and the durable-resume machinery. Those have their own session-scoped boot reads
 * already, and the one surface this bundle exists for suppresses them on purpose — see
 * `meeting-participant-boot.tsx`.
 */
export interface RespondentSurfaceConfig {
  /** Show the voice-input affordance (`config.voiceEnabled`; platform default ON). */
  voiceInputEnabled: boolean;
  /** Show the attachment affordance (`config.attachmentsEnabled`; platform default off). */
  attachmentInputEnabled: boolean;
  /** How the respondent completes: `chat`, raw `form`, or `both`. */
  presentationMode: PresentationMode;
  /** How the surface is ARRANGED (F-layouts). Defaults to `classic` — see RESPONDENT_LAYOUTS. */
  respondentLayout: RespondentLayout;
  /** How much of the live answer panel shows; `hidden` is the chat-only surface. */
  answerPanelScope: AnswerSlotPanelScope;
  /**
   * The ladder INDEX the text-size stepper opens on (`config.chatTextSize`, already resolved to a
   * number). The opening rung only — a respondent who has ever stepped keeps their stored size and
   * never consults this.
   */
  chatTextScaleIndex: number;
  /** Resolved "watch it think" placement, or null when the version has the feature off. */
  reasoningPlacement: ReasoningPlacement | null;
  /** Base dwell (ms) the reasoning summary stays open for up to two steps. */
  reasoningDwellMs: number;
  /** Extra dwell (ms) per reasoning step beyond two. */
  reasoningPerItemMs: number;
  /** Show the "fix this answer" gesture in the chat and on the panel rows. */
  inlineCorrectionEnabled: boolean;
  /** Show the "N% completed" text beside the progress bar (the bar always renders). */
  showProgressPercentText: boolean;
  /** The version runs PII-free — drives the opening turn's reassurance and the band's pill. */
  anonymous: boolean;
  /** The brand the conversation wears, ConQuest defaults already filled in. */
  theme: ResolvedTheme;
  /** The band's title + round window, or null when the session does not resolve one. */
  header: BandHeader | null;
  /** Live terms for the in-chat underline/popover; `[]` when respondent hints are off. */
  glossary: GlossaryEntry[];
  /** The completion screen's definitions appendix; null when its own switch is off. */
  glossaryAppendix: GlossaryAppendixView | null;
}
