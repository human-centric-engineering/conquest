'use client';

/**
 * ResumeByRefEntry — a subtle, collapsed "continue with your code" affordance for the public
 * questionnaire surface footer (session resume, cross-device).
 *
 * A fresh landing on `/q/[versionId]` auto-starts a new session, so a respondent returning on a
 * DIFFERENT device (no remembered session on this one) has no welcome-back gate. This quiet footer
 * link lets them reveal the {@link ResumeByRefForm} and continue by reference code without cluttering
 * the first-time experience. Rendered only for the public anonymous path with resume enabled.
 */

import { useState } from 'react';

import { ResumeByRefForm } from '@/components/app/questionnaire/chat/resume-by-ref-form';

export interface ResumeByRefEntryProps {
  versionId: string;
}

export function ResumeByRefEntry({ versionId }: ResumeByRefEntryProps) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
      >
        Started on another device? Continue with your code
      </button>
    );
  }

  return (
    <ResumeByRefForm
      versionId={versionId}
      label="Enter your session reference code to continue:"
      className="items-center"
    />
  );
}
