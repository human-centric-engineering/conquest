'use client';

/**
 * The Routing Analyst — run it, then review what it proposed.
 *
 * One card holding both halves, because they are one act. Structure extraction reads an uploaded
 * instrument for its QUESTIONS and discards the rest; the pages it discards — "Routing",
 * "Guardrails", "How to use this" — are the author saying which parts apply to whom. This is the
 * surface that reads them back.
 *
 * ## What the review has to make visible
 *
 * The proposal is not the point; the EVIDENCE is. An admin accepting a topic set is deciding what
 * respondents will and will not be asked, so three things are given more room than a normal review
 * queue would give them:
 *
 * - **`fromDocument`** — whether the analyst read real routing instructions or inferred everything
 *   from section headings. A guess that looks authored gets accepted, and then the instrument
 *   routes on the model's invention. The banner says which happened, in those words.
 * - **`sourceQuote`** — the span the criteria came from. A proposal an admin cannot trace back is
 *   one they must re-derive, at which point writing it by hand was less work.
 * - **uncovered questions** — with scope on, a question in no topic can never be asked, and nothing
 *   else in the system reports it. The count is shown before accepting, not after.
 *
 * Accepting is a single POST of the reviewed set; nothing here writes live until then.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, FileSearch, Loader2, Quote, Sparkles, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
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
import { parseSseBlock } from '@/lib/api/sse-parser';
import {
  authoringMutate,
  AuthoringError,
  ForkCancelledError,
} from '@/components/admin/questionnaires/authoring-mutate';
import type { RoutingAnalysisEvent } from '@/lib/app/questionnaire/scope/analysis-events';
import {
  SCOPE_RULE_ACTION_LABELS,
  SCOPE_RULE_OPERATOR_LABELS,
  TOPIC_PHASE_LABELS,
  type ProposedTopicSet,
} from '@/lib/app/questionnaire/scope/types';

export interface RoutingAnalystCardProps {
  questionnaireId: string;
  versionId: string;
  /** The pending proposal from the server, when there is one. */
  initialDraft: ProposedTopicSet | null;
  /** Question keys on the version — for the "questions left in no topic" count. */
  questionKeys: readonly string[];
  /** Live topic count, so the banner can say what accepting would replace. */
  liveTopicCount: number;
  disabled?: boolean;
}

/** Read the whole SSE stream, returning the terminal event or an error message. */
async function readAnalysisStream(
  body: ReadableStream<Uint8Array>,
  onPhase: (message: string) => void
): Promise<
  | { ok: true; done: Extract<RoutingAnalysisEvent, { type: 'done' }> }
  | { ok: false; message: string }
> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done: Extract<RoutingAnalysisEvent, { type: 'done' }> | null = null;
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
        const event = parsed.data as unknown as RoutingAnalysisEvent;
        if (event.type === 'done') done = event;
        else if (event.type === 'error') streamError = event.message;
        else onPhase(event.message);
      }
      boundary = buffer.indexOf('\n\n');
    }
  }

  if (streamError) return { ok: false, message: streamError };
  if (!done) return { ok: false, message: 'The analysis ended without a result. Try again.' };
  return { ok: true, done };
}

export function RoutingAnalystCard({
  questionnaireId,
  versionId,
  initialDraft,
  questionKeys,
  liveTopicCount,
  disabled = false,
}: RoutingAnalystCardProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<ProposedTopicSet | null>(initialDraft);
  const [instructions, setInstructions] = useState('');
  const [analysing, setAnalysing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAccept, setConfirmAccept] = useState(false);

  const run = async () => {
    setAnalysing(true);
    setError(null);
    setStatus('Starting…');
    try {
      const res = await fetch(
        API.APP.QUESTIONNAIRES.versionTopicsAnalyseStream(questionnaireId, versionId),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(
            instructions.trim().length > 0 ? { instructions: instructions.trim() } : {}
          ),
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

      const result = await readAnalysisStream(res.body, setStatus);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // Apply the returned proposal directly: `router.refresh()` re-runs the server component but
      // preserves client state, and `draft` is seeded by a `useState` initialiser that never
      // re-runs — so without this the admin would be told "12 topics proposed" over an empty panel.
      setDraft(result.done.draft);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The analysis failed. Try again.');
    } finally {
      setAnalysing(false);
      setStatus(null);
    }
  };

  const discard = async () => {
    setBusy(true);
    setError(null);
    try {
      await authoringMutate(
        'DELETE',
        API.APP.QUESTIONNAIRES.versionTopicsDraft(questionnaireId, versionId)
      );
      setDraft(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof AuthoringError ? err.message : 'Could not discard the proposal.');
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const { meta } = await authoringMutate(
        'POST',
        API.APP.QUESTIONNAIRES.versionTopicsDraft(questionnaireId, versionId),
        {
          topics: draft.topics.map((t) => ({
            key: t.key,
            label: t.label,
            description: null,
            phase: t.phase,
            criteria: t.criteria,
            depth: t.depth,
            questionKeys: t.members.questionKeys,
            dataSlotKeys: t.members.dataSlotKeys,
          })),
          rules: draft.rules.map((r) => ({
            dataSlotKey: r.dataSlotKey,
            operator: r.operator,
            value: r.value,
            action: r.action,
            topicKey: r.topicKey,
          })),
          ...(draft.maxConditionalTopics !== undefined
            ? { maxConditionalTopics: draft.maxConditionalTopics }
            : {}),
        }
      );
      setDraft(null);
      setConfirmAccept(false);
      if (meta?.forked) {
        router.replace(`/admin/questionnaires/${questionnaireId}/v/${meta.versionId}/topics`);
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ForkCancelledError) {
        setConfirmAccept(false);
        return;
      }
      setError(err instanceof AuthoringError ? err.message : 'Could not accept the proposal.');
    } finally {
      setBusy(false);
    }
  };

  const covered = new Set(draft?.topics.flatMap((t) => t.members.questionKeys) ?? []);
  const uncovered = questionKeys.filter((k) => !covered.has(k));
  const replacedCount = draft?.topics.filter((t) => t.replacesExisting).length ?? 0;
  const conditionalCount = draft?.topics.filter((t) => t.phase === 'conditional').length ?? 0;

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="bg-muted/30 flex-row items-start gap-3 space-y-0 border-b p-4">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <FileSearch className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <CardTitle className="text-sm font-semibold">Routing Analyst</CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            Reads your uploaded document — including the instruction pages extraction ignores, the
            “Routing” and “Guardrails” tabs — and proposes the topics they describe, each traced
            back to the words it came from. Nothing goes live until you accept it.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-4">
        {error && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
          >
            {error}
          </div>
        )}

        {draft === null ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                Where are the routing rules? (optional){' '}
                <FieldHelp title="Steering the analyst">
                  A one-line pointer saves the analyst hunting: “the routing rules are on the
                  Guardrails tab”, or “sections 4–7 only apply to enterprise accounts”. It is used
                  for this run only and is not saved.
                </FieldHelp>
              </Label>
              <Input
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="e.g. the routing rules are on the “Guardrails” tab"
                disabled={disabled || analysing}
              />
            </div>
            <Button onClick={() => void run()} disabled={disabled || analysing} size="sm">
              {analysing ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
                  {status ?? 'Analysing…'}
                </>
              ) : (
                <>
                  <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" /> Propose topics from the
                  document
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div
              className={
                draft.fromDocument
                  ? 'space-y-1 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200'
                  : 'space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
              }
            >
              <p className="font-medium">
                {draft.fromDocument
                  ? 'Read from the document’s own routing instructions.'
                  : 'Inferred from the questionnaire’s structure — the document stated no routing rules.'}
              </p>
              <p>{draft.summary}</p>
              {!draft.fromDocument && (
                <p className="text-xs">
                  Treat this as a starting point rather than the author’s intent. Check every
                  criterion before accepting.
                </p>
              )}
            </div>

            <p className="text-muted-foreground text-sm">
              {draft.topics.length} proposed {draft.topics.length === 1 ? 'topic' : 'topics'} ·{' '}
              {conditionalCount} conditional
              {draft.rules.length > 0 && <> · {draft.rules.length} hard rules</>}
              {draft.maxConditionalTopics !== undefined && (
                <> · limit of {draft.maxConditionalTopics} per interview</>
              )}
            </p>

            {liveTopicCount > 0 && (
              <p className="text-sm text-amber-600">
                Accepting replaces all {liveTopicCount} of your current{' '}
                {liveTopicCount === 1 ? 'topic' : 'topics'}
                {replacedCount > 0 && <> ({replacedCount} of them reuse the same key)</>}.
              </p>
            )}

            {uncovered.length > 0 && (
              <p className="text-destructive flex items-start gap-1.5 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {uncovered.length} question{uncovered.length === 1 ? '' : 's'} would belong to no
                  topic, so {uncovered.length === 1 ? 'it' : 'they'} could never be asked once
                  adaptive scope is on. Accept, then fix below — or discard and re-run.
                </span>
              </p>
            )}

            <ul className="space-y-2">
              {draft.topics.map((topic) => (
                <li key={topic.key} className="bg-muted/20 space-y-1.5 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{topic.label}</span>
                    <code className="text-muted-foreground text-[11px]">{topic.key}</code>
                    <Badge variant="outline" className="text-[10px]">
                      {TOPIC_PHASE_LABELS[topic.phase]}
                    </Badge>
                    {topic.depth === 'light' && (
                      <Badge variant="outline" className="text-[10px]">
                        Light
                      </Badge>
                    )}
                    {topic.replacesExisting && (
                      <Badge variant="secondary" className="text-[10px]">
                        Replaces yours
                      </Badge>
                    )}
                    <span className="text-muted-foreground ml-auto text-[11px]">
                      {topic.members.questionKeys.length}{' '}
                      {topic.members.questionKeys.length === 1 ? 'question' : 'questions'}
                    </span>
                  </div>
                  {topic.criteria && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Include when: </span>
                      {topic.criteria}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs">{topic.rationale}</p>
                  {topic.sourceQuote ? (
                    <p className="text-muted-foreground flex items-start gap-1.5 border-l-2 pl-2 text-xs italic">
                      <Quote className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                      {topic.sourceQuote}
                    </p>
                  ) : (
                    <p className="text-muted-foreground/70 text-xs italic">
                      Inferred — the document does not say this.
                    </p>
                  )}
                </li>
              ))}
            </ul>

            {draft.rules.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Hard rules</p>
                <ul className="space-y-2">
                  {draft.rules.map((rule, i) => (
                    <li
                      key={`${rule.topicKey}-${rule.dataSlotKey}-${i}`}
                      className="bg-muted/20 space-y-1 rounded-md border p-3 text-xs"
                    >
                      <p>
                        When <code>{rule.dataSlotKey}</code>{' '}
                        {SCOPE_RULE_OPERATOR_LABELS[rule.operator]}
                        {rule.value !== null && <> “{rule.value}”</>},{' '}
                        {SCOPE_RULE_ACTION_LABELS[rule.action]} <code>{rule.topicKey}</code>.
                      </p>
                      <p className="text-muted-foreground">{rule.rationale}</p>
                      {rule.sourceQuote && (
                        <p className="text-muted-foreground border-l-2 pl-2 italic">
                          {rule.sourceQuote}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button size="sm" onClick={() => setConfirmAccept(true)} disabled={busy}>
                Accept {draft.topics.length} {draft.topics.length === 1 ? 'topic' : 'topics'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void discard()}
                disabled={busy}
                className="text-destructive"
              >
                <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" /> Discard
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void run()}
                disabled={busy || analysing}
              >
                {analysing ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
                    {status ?? 'Analysing…'}
                  </>
                ) : (
                  'Re-run'
                )}
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirmAccept} onOpenChange={setConfirmAccept}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Accept this topic set?</AlertDialogTitle>
            <AlertDialogDescription>
              {liveTopicCount > 0
                ? `This replaces all ${liveTopicCount} of your current topics with the ${draft?.topics.length ?? 0} proposed here`
                : `This writes the ${draft?.topics.length ?? 0} proposed topics`}
              {draft && draft.rules.length > 0 ? ', and replaces your hard rules' : ''}. You can
              still edit everything afterwards. Adaptive scope stays off until you turn it on
              yourself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void accept()} disabled={busy}>
              Accept
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
