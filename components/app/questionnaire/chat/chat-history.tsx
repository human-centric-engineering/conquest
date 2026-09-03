'use client';

/**
 * ChatHistory — everything behind the current exchange, at rest.
 *
 * The earlier legs of an Experience run under `stitched` continuity, then this leg's own settled
 * turns: every message up to the respondent's most recent one. Nothing here animates, and nothing
 * here is waiting on a clock — by the time a turn falls behind the current exchange the respondent
 * has already answered it, which is only possible once the reveal queue let the composer open.
 *
 * The half that made `transcript` two slots. Horizon shows one question at a time and puts this
 * behind a gesture; every other layout stacks it straight above `currentExchange` in the same
 * reading column (see `TranscriptColumn`), where the boundary between the two is invisible — which
 * is why both halves render a turn through the same primitives rather than each having its own idea
 * of what a turn looks like.
 *
 * Draws no scroll container, no padding and no measure of its own: whoever places it supplies the
 * column, exactly as `ChatTranscript` never drew its own card.
 */

import { useConversation } from '@/components/app/questionnaire/chat/conversation-context';
import {
  SettledAssistantTurn,
  UserBubble,
} from '@/components/app/questionnaire/chat/transcript-turns';
import { SeamDivider } from '@/components/app/questionnaire/experiences/seam-divider';
import { cn } from '@/lib/utils';
import type { GlossaryEntry } from '@/lib/app/questionnaire/glossary/types';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import type { StitchedHistory } from '@/lib/app/questionnaire/experiences/run/types';
import type { ReasoningPlacement } from '@/lib/app/questionnaire/types';
import { turnInSection } from '@/lib/app/questionnaire/chat/exchange';

export interface ChatHistoryProps {
  /** The shared stream state, owned by `SessionWorkspace`. Read for `turns` alone. */
  stream: UseQuestionnaireSessionStreamReturn;
  /**
   * Definitions / glossary (P16): the version's live terms, underlined in the interviewer's
   * messages. Never applied to the respondent's own bubbles.
   */
  glossary?: readonly GlossaryEntry[];
  /** `overlay` | `inline`, or null/undefined when "watch it think" is off for this version. */
  reasoningPlacement?: ReasoningPlacement | null;
  /**
   * Experiences, `stitched` continuity (P15.3): the earlier legs of this run, replayed above this
   * leg's own history. Read-only and settled — never animated, never part of the reveal queue.
   */
  stitchedHistory?: StitchedHistory | null;
  /**
   * The divider label introducing the LIVE leg, when history precedes it. `null` suppresses every
   * seam divider (the author chose the seamless marker); `undefined` means not stitched at all.
   */
  stitchedSeamLabel?: string | null;
  /**
   * Sectioned interviews (P21): show only the history belonging to this section.
   *
   * Undefined on every unsectioned interview, where the whole history renders as it always has.
   * `CurrentExchange` takes the same key and applies the same predicate: a section move can leave
   * the previous section's last exchange sitting past the history boundary, and half a filtered
   * transcript is worse than none.
   *
   * A turn carrying no key at all (recorded before P21, or before this session was sectioned) is
   * KEPT rather than hidden: it is part of the conversation, and hiding it would make the transcript
   * lie about what was said.
   */
  sectionKey?: string | null;
  /**
   * Sectioned interviews (P21): where a turn carrying NO section of its own belongs — the run's
   * first section. See {@link turnInSection}; the surface passes it so the client-built greeting
   * does not reappear at the top of every section.
   */
  untaggedSectionKey?: string | null;
  className?: string;
}

export function ChatHistory({
  stream,
  glossary,
  reasoningPlacement,
  stitchedHistory,
  stitchedSeamLabel,
  sectionKey,
  untaggedSectionKey,
  className,
}: ChatHistoryProps) {
  const { turns } = stream;
  // Where the current exchange begins — clamped to the reveal cursor by the provider, so a turn
  // still typing itself in can never be yanked back here mid-reveal (its `onDone` would never fire
  // and the queue would stall with the composer shut). See conversation-context.tsx.
  const { historyEnd } = useConversation();

  const segments = stitchedHistory?.segments ?? [];
  const settled = turns
    .slice(0, historyEnd)
    // P21: this section's history. A no-op when unsectioned, and an untagged turn is kept. The
    // same predicate `CurrentExchange` applies, so the two halves of one transcript cannot disagree
    // about what a section move hides.
    .filter((turn) => turnInSection(turn, sectionKey, untaggedSectionKey));

  // Nothing behind the current exchange: render no box at all rather than an empty one, so a
  // column that spaces its children with a gap does not open a gap around nothing. The container
  // ALSO resolves this slot to `null` in that case — belt and braces, since a layout that puts the
  // history behind a gesture must not offer the gesture when there is nothing to open.
  if (segments.length === 0 && settled.length === 0) return null;

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {/* Experiences, `stitched` continuity (P15.3): the earlier legs of this run, replayed above
          the live conversation so the journey reads as one. Rendered as its own block rather than
          concatenated into `turns` — the reveal cursor, the typewriter and the inspector all index
          that array, and history must settle instantly and animate nothing. `stitchedSeamLabel` is
          null when the author chose the seamless marker. */}
      {segments.map((segment, s) => (
        <div key={`seg-${s}`} className="flex flex-col gap-6">
          {stitchedSeamLabel !== null && s > 0 && <SeamDivider label={segment.stepTitle} />}
          {segment.turns.map((turn, t) =>
            turn.role === 'user' ? (
              <UserBubble key={`seg-${s}-t-${t}`} content={turn.content} />
            ) : (
              <SettledAssistantTurn
                key={`seg-${s}-t-${t}`}
                content={turn.content}
                warnings={turn.warnings}
                reasoning={turn.reasoning}
                reasoningPlacement={reasoningPlacement}
                glossary={glossary}
              />
            )
          )}
        </div>
      ))}
      {/* The divider introducing the LIVE leg — shown only when history precedes it. */}
      {stitchedSeamLabel !== null && stitchedSeamLabel !== undefined && segments.length > 0 && (
        <SeamDivider label={stitchedSeamLabel} />
      )}
      {settled.map((turn, i) =>
        turn.role === 'user' ? (
          <UserBubble key={i} content={turn.content} />
        ) : (
          <SettledAssistantTurn
            key={i}
            content={turn.content}
            warnings={turn.warnings}
            reasoning={turn.reasoning}
            reasoningPlacement={reasoningPlacement}
            glossary={glossary}
          />
        )
      )}
    </div>
  );
}
