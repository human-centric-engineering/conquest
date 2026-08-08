'use client';

/**
 * "Publish to client knowledge base" (P16) — an explicit, one-way admin action.
 *
 * Deliberately behind a confirm dialog that NAMES the client and states the blast radius, because
 * this is the one write in the whole feature that escapes the version boundary:
 *
 *  - the knowledge base is scoped per demo CLIENT, a glossary per VERSION, so two questionnaires
 *    for one client that define a term differently will both be retrievable for either;
 *  - there is no unpublish — removing a published glossary is a manual step in the knowledge-base
 *    admin;
 *  - it cannot be forked back.
 *
 * The report writer already receives the glossary directly from the database, correctly
 * version-scoped. This buys reach into OTHER client-scoped agents and nothing else — which is why
 * the dialog says so rather than presenting it as an obvious next step.
 */

import { useState } from 'react';
import { Loader2, Share2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { API } from '@/lib/api/endpoints';
import { apiClient } from '@/lib/api/client';

export interface GlossaryPublishButtonProps {
  questionnaireId: string;
  versionId: string;
  /** The attributed client's name, or null when the questionnaire has none (the action is then off). */
  clientName: string | null;
  /** Accepted terms — nothing to publish when zero. */
  acceptedCount: number;
  disabled?: boolean;
}

export function GlossaryPublishButton({
  questionnaireId,
  versionId,
  clientName,
  acceptedCount,
  disabled = false,
}: GlossaryPublishButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Nothing to publish, or nowhere to publish it. Rendering a disabled control with no explanation
  // is worse than rendering nothing.
  if (acceptedCount === 0) return null;

  const publish = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await apiClient.post<{ documentName: string; termCount: number }>(
        API.APP.QUESTIONNAIRES.versionGlossaryPublish(questionnaireId, versionId),
        {}
      );
      setResult(
        `Published “${data.documentName}” — ${data.termCount} ${data.termCount === 1 ? 'term' : 'terms'} are now in ${clientName ?? 'the client'}’s knowledge base.`
      );
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish the glossary.');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || busy || !clientName}
        title={
          clientName
            ? undefined
            : 'Attribute this questionnaire to a client first — the knowledge base is scoped per client.'
        }
        onClick={() => setOpen(true)}
      >
        {busy ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Share2 className="mr-1 h-3.5 w-3.5" />
        )}
        Publish to client knowledge base
      </Button>

      {error && <p className="text-destructive mt-2 text-sm">{error}</p>}
      {result && <p className="text-muted-foreground mt-2 text-sm">{result}</p>}

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Publish this glossary to {clientName ?? 'the client'}&rsquo;s knowledge base?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This copies the {acceptedCount} accepted {acceptedCount === 1 ? 'term' : 'terms'}{' '}
                  into <span className="font-medium">{clientName}</span>&rsquo;s private knowledge
                  base as a document.
                </p>
                <p>
                  It will be visible to{' '}
                  <span className="font-medium">
                    every agent scoped to that client, across all of their questionnaires
                  </span>{' '}
                  — not just this one. If another questionnaire defines the same term differently,
                  both definitions will be retrievable and there is no way to tell them apart at
                  retrieval time.
                </p>
                <p>
                  It is <span className="font-medium">not removed automatically</span> — deleting it
                  later is a manual step in the knowledge base.
                </p>
                <p className="text-muted-foreground">
                  You don&rsquo;t need this for reports: report generation already reads these
                  definitions directly from this version.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void publish()}>
              Publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
