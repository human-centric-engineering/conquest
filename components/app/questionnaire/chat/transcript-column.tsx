'use client';

/**
 * TranscriptColumn — the reading column the conversation is read in.
 *
 * The scrolling box, its padding, the respondent's text scale and the reading measure, plus the
 * standard rhythm between the blocks inside it. That is arrangement, and since `transcript` split
 * into `history` + `currentExchange` it is arrangement that four layouts would otherwise each
 * declare for themselves — which is how one of them ends up with a different measure, or forgets
 * `.cq-chat-scale` and stops honouring the text-size stepper.
 *
 * The sibling of `ConversationFrame`, and the same argument: it takes ready-made nodes and
 * positions them. It builds nothing, fetches nothing, and reads no session state — so a layout
 * that uses it has still made every decision itself, and a layout that wants a different column
 * (Horizon centres its stage) either passes `centred` or writes its own.
 *
 * Children rather than named slots on purpose. The column's job is "stack these, in this rhythm,
 * in this measure"; naming the parts here would fix their ORDER as well, and the order is the
 * layout's to state — the pre-release notice sits above the history in every layout so far, but
 * that is a decision each of them makes, not one this file should make for them.
 */

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface TranscriptColumnProps {
  /**
   * Centre the stack in the column rather than starting it at the top — a one-question-at-a-time
   * stage rather than a running conversation. Uses auto margins rather than `justify-center`,
   * which clips the top of anything taller than the box instead of scrolling to it.
   */
  centred?: boolean;
  children: ReactNode;
  className?: string;
}

export function TranscriptColumn({ centred = false, children, className }: TranscriptColumnProps) {
  return (
    <div
      className={cn(
        'min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 2xl:px-10',
        centred && 'flex flex-col',
        className
      )}
    >
      {/* `cq-chat-scale` resolves the respondent's text-size preference from the `--cq-chat-scale`
          custom property SessionWorkspace sets; the turns inside inherit it rather than pinning
          their own size. `cq-chat-measure` is the line length — a multiple of that same preference
          and the viewport scale, so the measure stays constant in characters as the text grows. */}
      <div
        className={cn('cq-chat-scale cq-chat-measure flex flex-col gap-6', centred && 'my-auto')}
      >
        {children}
      </div>
    </div>
  );
}
