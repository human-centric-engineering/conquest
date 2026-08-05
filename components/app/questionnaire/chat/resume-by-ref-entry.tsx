'use client';

/**
 * ResumeByRefEntry — the "continue on this device" affordance for the public questionnaire surface
 * footer (session resume, cross-device).
 *
 * A fresh landing on `/q/[versionId]` auto-starts a new session, so a respondent returning on a
 * DIFFERENT device (no remembered session on this one) gets no welcome-back gate — this quiet
 * footer control is their only door back in. It stays a single unobtrusive line so it never
 * competes with the conversation, then opens a DIALOG rather than expanding in place: the footer
 * strip sits hard against the bottom of the viewport, and entering a code read off another screen
 * deserves a focused panel that survives the mobile keyboard, not a two-line squeeze under the
 * chat. The dialog also answers the question the bare field never did — *where do I find my code*.
 *
 * Rendered only for the public anonymous path with resume enabled.
 *
 * @see components/app/questionnaire/chat/resume-by-ref-form.tsx
 */

import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ResumeByRefForm } from '@/components/app/questionnaire/chat/resume-by-ref-form';

const ACCENT = 'var(--app-accent-color, var(--cq-accent, var(--color-primary)))';

export interface ResumeByRefEntryProps {
  versionId: string;
  /**
   * The page's resolved brand CSS variables. The dialog renders through a portal on `document.body`,
   * outside `BrandThemeProvider`'s wrapper, so the client's `--app-*` values have to be re-applied
   * here or a white-labelled questionnaire would open a platform-coloured panel.
   */
  brandStyle?: Record<string, string>;
}

export function ResumeByRefEntry({ versionId, brandStyle }: ResumeByRefEntryProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-full border border-current/15 px-3 py-1.5 text-xs transition-colors hover:border-current/35"
        >
          <MonitorSmartphone className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
          Started on another device? Continue with your code
        </button>
      </DialogTrigger>

      <DialogContent
        data-surface="respondent"
        style={brandStyle}
        className="max-w-md gap-0 p-7 sm:rounded-2xl"
      >
        <DialogHeader className="text-center sm:text-center">
          <span
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl"
            style={{
              color: ACCENT,
              backgroundColor: `color-mix(in srgb, ${ACCENT} 12%, transparent)`,
            }}
          >
            <MonitorSmartphone className="h-6 w-6" aria-hidden="true" />
          </span>
          <DialogTitle className="text-xl tracking-tight">Pick up where you left off</DialogTitle>
          <DialogDescription className="leading-relaxed">
            Enter your reference code and the conversation you started elsewhere continues here —
            every answer you have already given comes with it.
          </DialogDescription>
        </DialogHeader>

        {/* No explicit focus call: Radix moves focus to the first tabbable element on open, and
            the code field is it. */}
        <div className="mt-6">
          <ResumeByRefForm versionId={versionId} />
        </div>

        {/* Answers the question the code field on its own always left hanging. */}
        <p className="text-muted-foreground bg-muted/40 mt-6 rounded-xl px-4 py-3 text-center text-xs leading-relaxed">
          Your code is on the other device, at the bottom of the conversation, shown as{' '}
          <span className="text-foreground font-mono font-semibold whitespace-nowrap">
            Ref: 7F3K-9M2P
          </span>
          .
        </p>
      </DialogContent>
    </Dialog>
  );
}
