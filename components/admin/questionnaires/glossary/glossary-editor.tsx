'use client';

/**
 * Glossary editor — the Definitions tab's curation surface (P16).
 *
 * Holds the version's whole curated set and saves it as a REPLACE-SET: the review UI already has
 * every term in hand, and one fork per save beats N when the version is launched.
 *
 * Terms are grouped by curation state rather than listed flat, because the three states are three
 * different jobs: proposals need adjudicating, accepted terms are live and worth re-reading, and
 * rejected terms are kept only so a later analyst re-run doesn't re-propose what you already
 * turned down.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Plus, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SaveButton } from '@/components/admin/questionnaires/save-button';
import { useUnsavedChangesWarning } from '@/lib/hooks/use-unsaved-changes-warning';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import type { GlossaryAnalysisEvent } from '@/lib/app/questionnaire/glossary/analysis-events';
import {
  authoringMutate,
  AuthoringError,
  ForkCancelledError,
} from '@/components/admin/questionnaires/authoring-mutate';
import {
  GLOSSARY_MAX_TERMS_PER_VERSION,
  normalizeGlossarySurface,
  type GlossaryDocumentView,
  type GlossaryTermView,
} from '@/lib/app/questionnaire/glossary';
import { GlossaryPublishButton } from '@/components/admin/questionnaires/glossary/glossary-publish-button';
import { GlossaryDocumentCard } from '@/components/admin/questionnaires/glossary/glossary-document-card';
import { GlossaryTermCard } from '@/components/admin/questionnaires/glossary/glossary-term-card';
import {
  blankTerm,
  toDraftTerm,
  toSavePayload,
  type DraftTerm,
} from '@/components/admin/questionnaires/glossary/glossary-types';

export interface GlossaryEditorProps {
  questionnaireId: string;
  versionId: string;
  initialTerms: GlossaryTermView[];
  initialDocument: GlossaryDocumentView | null;
  /** Questions in the version — a glossary over an empty structure has nothing to define. */
  questionCount: number;
  /**
   * The attributed demo client's name, or null. Gates the opt-in "publish to client knowledge
   * base" action, which is meaningless without a client corpus to publish into.
   */
  clientName?: string | null;
}

/** Serialise the working set so an unsaved-changes check is a string compare, not a deep diff. */
function fingerprint(terms: DraftTerm[]): string {
  return JSON.stringify(toSavePayload(terms));
}

export function GlossaryEditor({
  questionnaireId,
  versionId,
  initialTerms,
  initialDocument,
  questionCount,
  clientName = null,
}: GlossaryEditorProps) {
  const router = useRouter();
  const [terms, setTerms] = useState<DraftTerm[]>(() => initialTerms.map(toDraftTerm));
  const [savedFingerprint, setSavedFingerprint] = useState<string>(() =>
    fingerprint(initialTerms.map(toDraftTerm))
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<string | null>(null);

  const dirty = fingerprint(terms) !== savedFingerprint;
  useUnsavedChangesWarning(dirty);

  /**
   * First-wins map of normalised surface → the display form that claimed it, so a duplicate is
   * flagged on the card that repeats it rather than the one that got there first. Uses the same
   * `normalizeGlossarySurface` the server and the matcher use, so what the editor calls a
   * duplicate is exactly what the save schema will reject.
   */
  const duplicateLabels = useMemo(() => {
    const firstBySurface = new Map<string, string>();
    const flagged = new Map<string, string>();
    for (const term of terms) {
      const normalized = normalizeGlossarySurface(term.term);
      if (normalized.length === 0) continue;
      const first = firstBySurface.get(normalized);
      if (first === undefined) {
        firstBySurface.set(normalized, term.term);
      } else {
        flagged.set(term.id, first);
      }
    }
    return flagged;
  }, [terms]);

  const groups = useMemo(
    () => ({
      proposed: terms.filter((term) => term.status === 'proposed'),
      accepted: terms.filter((term) => term.status === 'accepted'),
      rejected: terms.filter((term) => term.status === 'rejected'),
    }),
    [terms]
  );

  const updateTerm = (next: DraftTerm) =>
    setTerms((prev) => prev.map((term) => (term.id === next.id ? next : term)));

  const removeTerm = (id: string) => setTerms((prev) => prev.filter((term) => term.id !== id));

  const addTerm = () => {
    setTerms((prev) => [...prev, blankTerm()]);
    setNotice(null);
    setError(null);
  };

  /**
   * Run the Glossary Analyst and reload the proposals it wrote.
   *
   * Deliberately NOT merged into the in-memory working set: the run persists `proposed` rows
   * server-side, so a `router.refresh()` is both simpler and truthful — what the admin sees after
   * a run is exactly what is stored. Unsaved edits would be clobbered by that refresh, so a dirty
   * editor is asked to save first rather than silently losing work.
   */
  const analyse = async () => {
    if (dirty) {
      setError('Save your changes before running an analysis — a run reloads this list.');
      return;
    }
    setAnalysing(true);
    setError(null);
    setNotice(null);
    setAnalysisStatus('Starting…');

    try {
      const res = await fetch(
        API.APP.QUESTIONNAIRES.versionGlossaryAnalyseStream(questionnaireId, versionId),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
        }
      );

      // A non-2xx (rate limit, unseeded agent, no questions) returns the standard JSON error
      // envelope, not a stream.
      if (!res.ok || !res.body) {
        let message: string | undefined;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          message = body.error?.message;
        } catch {
          // Non-JSON body — fall through to the generic message.
        }
        setError(message ?? `The analysis could not start (${res.status}). Try again.`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done: Extract<GlossaryAnalysisEvent, { type: 'done' }> | null = null;
      let streamError: string | null = null;

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (parsed) {
            const event = parsed.data as unknown as GlossaryAnalysisEvent;
            if (event.type === 'done') done = event;
            else if (event.type === 'error') streamError = event.message;
            else setAnalysisStatus(event.message);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      if (streamError) {
        setError(streamError);
        return;
      }
      if (!done) {
        setError('The analysis ended without a result. Try again.');
        return;
      }

      // Distinguish "found nothing new" from "found nothing" — a run that suggested only terms the
      // admin had already settled is working correctly, and saying so avoids a bug report.
      // Apply the returned set directly. `router.refresh()` re-runs the server component but
      // preserves client state, and `terms` is seeded by a `useState` initialiser that never runs
      // again — so refreshing alone would leave the queue empty while the notice claimed
      // otherwise.
      const next = done.terms.map(toDraftTerm);
      setTerms(next);
      setSavedFingerprint(fingerprint(next));

      if (done.proposedCount === 0) {
        setNotice(
          done.skippedExistingCount > 0
            ? `No new terms — the ${done.skippedExistingCount} suggested ${done.skippedExistingCount === 1 ? 'term was' : 'terms were'} ones you have already decided on.`
            : 'No terms looked open to interpretation. You can still add your own below.'
        );
      } else {
        setNotice(
          `Suggested ${done.proposedCount} ${done.proposedCount === 1 ? 'term' : 'terms'} to review` +
            (done.skippedExistingCount > 0
              ? ` (${done.skippedExistingCount} already decided on ${done.skippedExistingCount === 1 ? 'was' : 'were'} skipped).`
              : '.')
        );
      }
      router.refresh();
    } catch {
      setError('The analysis could not be completed. Try again.');
    } finally {
      setAnalysing(false);
      setAnalysisStatus(null);
    }
  };

  const save = async (): Promise<boolean> => {
    setError(null);
    setNotice(null);
    try {
      const res = await authoringMutate<{ terms: GlossaryTermView[] }>(
        'PUT',
        API.APP.QUESTIONNAIRES.versionGlossary(questionnaireId, versionId),
        { terms: toSavePayload(terms) }
      );
      // A launched version forks a new draft — follow it so the admin keeps editing what they saved.
      if (res.meta?.forked) {
        router.push(`/admin/questionnaires/${questionnaireId}/v/${res.meta.versionId}/definitions`);
        return true;
      }
      const next = res.data.terms.map(toDraftTerm);
      setTerms(next);
      setSavedFingerprint(fingerprint(next));
      const accepted = res.data.terms.filter((term) => term.status === 'accepted').length;
      setNotice(
        accepted === 0
          ? 'Saved. No terms are accepted yet, so nothing is in use.'
          : `Saved — ${accepted} ${accepted === 1 ? 'term is' : 'terms are'} now in use.`
      );
      router.refresh();
      return true;
    } catch (err) {
      if (err instanceof ForkCancelledError) return false;
      setError(err instanceof AuthoringError ? err.message : 'Could not save the glossary.');
      return false;
    }
  };

  const atCap = terms.length >= GLOSSARY_MAX_TERMS_PER_VERSION;

  const renderGroup = (heading: string, blurb: string, members: DraftTerm[]) =>
    members.length === 0 ? null : (
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">
            {heading} <span className="text-muted-foreground">({members.length})</span>
          </h3>
          <p className="text-muted-foreground text-xs">{blurb}</p>
        </div>
        {members.map((term) => (
          <GlossaryTermCard
            key={term.id}
            term={term}
            duplicateOf={duplicateLabels.get(term.id) ?? null}
            onChange={updateTerm}
            onRemove={() => removeTerm(term.id)}
          />
        ))}
      </section>
    );

  return (
    <div className="space-y-6">
      {questionCount === 0 && (
        <p className="text-muted-foreground text-sm italic">
          This version has no questions yet — add some structure first, then define the terms it
          leans on.
        </p>
      )}

      <GlossaryDocumentCard
        questionnaireId={questionnaireId}
        versionId={versionId}
        document={initialDocument}
        disabled={analysing}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={() => void analyse()}
          disabled={analysing || questionCount === 0}
        >
          {analysing ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-1 h-4 w-4" />
          )}
          {terms.length === 0 ? 'Find terms to define' : 'Re-run analysis'}
        </Button>
        {analysing && analysisStatus && (
          <span className="text-muted-foreground text-sm">{analysisStatus}</span>
        )}
        {!analysing && terms.length > 0 && (
          <span className="text-muted-foreground text-xs">
            Re-running keeps everything you have already accepted or rejected.
          </span>
        )}
      </div>

      {error && (
        <p className="text-destructive flex items-start gap-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
      {notice && <p className="text-muted-foreground text-sm">{notice}</p>}

      {terms.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No terms yet. Run the analysis to see what this questionnaire leans on, or add one by hand
          below.
        </p>
      ) : (
        <div className="space-y-8">
          {renderGroup(
            'Proposed',
            'Suggested for you to adjudicate. Nothing here is in use until you accept it.',
            groups.proposed
          )}
          {renderGroup(
            'In use',
            'Injected into the interviewer and extraction prompts, and shown to respondents.',
            groups.accepted
          )}
          {renderGroup(
            'Rejected',
            'Kept on file so a later analysis does not suggest them again.',
            groups.rejected
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={addTerm} disabled={atCap}>
          <Plus className="mr-1 h-4 w-4" />
          Add a term
        </Button>
        {atCap && (
          <Badge variant="secondary">Limit of {GLOSSARY_MAX_TERMS_PER_VERSION} terms reached</Badge>
        )}
        <GlossaryPublishButton
          questionnaireId={questionnaireId}
          versionId={versionId}
          clientName={clientName}
          acceptedCount={groups.accepted.length}
          disabled={dirty || analysing}
        />
        <div className="flex-1" />
        {dirty && <span className="text-muted-foreground text-xs">Unsaved changes</span>}
        <SaveButton onSave={save} disabled={!dirty}>
          Save definitions
        </SaveButton>
      </div>
    </div>
  );
}
