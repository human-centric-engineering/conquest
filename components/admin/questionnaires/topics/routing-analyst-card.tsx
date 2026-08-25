'use client';

/**
 * The Routing Analyst — run it, then review what it proposed.
 *
 * One card holding both halves, because they are one act. Structure extraction reads an uploaded
 * instrument for its QUESTIONS and discards the rest; what it discards — routing notes,
 * eligibility rules, guardrails, "how to use this" guidance, wherever they sit in the file — is
 * the author saying which parts apply to whom. This is the surface that reads them back.
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
 * - **`gaps`** (Phase 2, F17.19) — routing language the analyst recognized but could not formalize
 *   into a topic or rule. Previously silently dropped; now shown so the admin knows what the
 *   accepted proposal does NOT cover. Each gap carries a "Turn into topic" action (F17.20) that
 *   seeds a new draft row in the topic editor below — `criteria` from the gap's `sourceQuote` (the
 *   document's own words), `description` from the gap's `explanation` (why the analyst couldn't
 *   formalize it, as a note for whoever finishes authoring the row) — rather than leaving the gap as
 *   read-only text an admin has to re-derive a topic from by hand.
 *
 * Accepting is a single POST of the reviewed set; nothing here writes live until then.
 *
 * ## Auto-trigger (Phase 3, F17.19)
 *
 * When the server says `autoTriggerPending`, this card runs itself on mount — the same `run()` the
 * "Propose topics from the document" button calls, just not waiting for the click. The point is
 * closing the discovery gap Phase 1 named: an admin who never opens this tab, or opens it and does
 * not know to look for a button, still finds a reviewed draft waiting. It fires at most once per
 * mount (`autoTriggeredRef`) and never a second time for the same version — the server recomputes
 * `autoTriggerPending` from whether an `AppAiRun` now exists, so a discarded auto-proposal does not
 * keep re-proposing itself every time the admin comes back to this tab. A failure during an
 * auto-triggered run stays silent (`{ silent: true }`) rather than surfacing an error banner for an
 * action the admin never took — they can still press the button themselves, which reports normally.
 *
 * ## Two more ways in (F17.22 Phase 1)
 *
 * The auto-trigger only fires for a document the ingestion-time check flagged. That check is
 * quote-grounded and biased to "no" by design, which left the two cases below with no route to the
 * analyst at all:
 *
 * - **A negative verdict now renders.** The candidacy banner used to be `candidacy?.isCandidate &&`,
 *   so "we checked and found no routing instructions" drew nothing — and an admin who did not
 *   already know this card existed had no reason to look at it. It now says so, and says the
 *   analyst can still propose conditional topics from the questions themselves.
 * - **`runRequest`** lets the Topics section, several screens below, ask this card to run and pull
 *   the admin up to it. The point is the point of need: an admin scrolling the topic list deciding
 *   which groups are conditional is doing by hand exactly what the analyst does.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  FileSearch,
  HelpCircle,
  Loader2,
  Plus,
  Quote,
  Sparkles,
  Trash2,
} from 'lucide-react';

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
import type { ScopeCandidacyVerdict } from '@/lib/app/questionnaire/scope/candidacy-schema';
import {
  SCOPE_RULE_ACTION_LABELS,
  SCOPE_RULE_OPERATOR_LABELS,
  TOPIC_PHASE_LABELS,
  type ProposedGap,
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
  /** The ingestion-time candidacy verdict (F17.19 Phase 1), or null. Explains an auto-run. */
  candidacy: ScopeCandidacyVerdict | null;
  /** True when this card should invoke the analyst itself, on mount (F17.19 Phase 3). */
  autoTriggerPending: boolean;
  /**
   * A request from elsewhere on the tab — the Topics section's "Set up conditional topics with AI"
   * action — to scroll here and run (F17.22 Phase 1).
   *
   * Carries a `nonce` for the same reason `focusTopic` and `seedTopic` do in the topic editor:
   * asking a second time must move the page a second time, and a plain boolean would be unchanged
   * state on the second press with the effect below never re-firing.
   *
   * **A pending proposal is never overwritten by one of these.** When a draft is already on screen
   * the request scrolls to it and stops: the admin has unreviewed work here, and silently replacing
   * it with a fresh run would discard a review they were part-way through.
   */
  runRequest?: { nonce: number } | null;
  /** Called once a {@link runRequest} has been honoured, so the caller can drop it. */
  onRunHandled?: () => void;
  /** Called when the admin asks to turn a gap into a new draft topic (F17.20). Optional so a
   *  caller that doesn't yet host the topic editor (there is only one today) can omit it. */
  onTurnGapIntoTopic?: (gap: ProposedGap) => void;
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

/** The sky-toned "grounded in the document" banner — shared by the candidacy note and the
 *  `fromDocument` proposal banner, so a restyle is a one-line change rather than two. */
const SKY_BANNER_CLASSNAME =
  'space-y-1 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200';

export function RoutingAnalystCard({
  questionnaireId,
  versionId,
  initialDraft,
  questionKeys,
  liveTopicCount,
  candidacy,
  autoTriggerPending,
  runRequest,
  onRunHandled,
  onTurnGapIntoTopic,
  disabled = false,
}: RoutingAnalystCardProps) {
  const router = useRouter();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<ProposedTopicSet | null>(initialDraft);
  const [instructions, setInstructions] = useState('');
  const [analysing, setAnalysing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [autoStarted, setAutoStarted] = useState(false);
  const autoTriggeredRef = useRef(false);

  const run = async (opts?: { silent?: boolean }) => {
    // A silent (auto-triggered) run never shows an error banner for a click the admin never
    // made — one gate here rather than repeating `if (!opts?.silent)` at every failure site below.
    const reportError = (message: string) => {
      if (!opts?.silent) setError(message);
    };

    setAnalysing(true);
    setError(null);
    // `status` is set here unconditionally, so `status ?? '…'` in the render below never actually
    // falls through to its default — the auto-run/manual distinction has to be made HERE, not there.
    setStatus(opts?.silent ? 'Drafting a proposal…' : 'Starting…');
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
        reportError(message ?? `The analysis could not start (${res.status}). Try again.`);
        return;
      }

      const result = await readAnalysisStream(res.body, setStatus);
      if (!result.ok) {
        reportError(result.message);
        return;
      }
      // Apply the returned proposal directly: `router.refresh()` re-runs the server component but
      // preserves client state, and `draft` is seeded by a `useState` initialiser that never
      // re-runs — so without this the admin would be told "12 topics proposed" over an empty panel.
      setDraft(result.done.draft);
      router.refresh();
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'The analysis failed. Try again.');
    } finally {
      setAnalysing(false);
      setStatus(null);
    }
  };

  // F17.19 Phase 3: run itself, unprompted, the first time the server says a fresh candidate is
  // waiting. Guarded by a ref (not just `draft === null`) so React 19's double-invoked dev-mode
  // effect can't fire it twice on the same mount, and `{ silent: true }` so a failure here — a rate
  // limit, an unseeded agent — never shows an error banner for a click the admin never made.
  useEffect(() => {
    if (!autoTriggerPending || draft !== null || disabled || autoTriggeredRef.current) return;
    autoTriggeredRef.current = true;
    setAutoStarted(true);
    void run({ silent: true });
    // `run` closes over `instructions`, which is always empty before this fires; including it
    // in the deps below would re-run this effect on every keystroke in that field for no
    // behavioural change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTriggerPending, draft, disabled]);

  // F17.22 Phase 1: the Topics section asked for a run. Scroll here either way — the admin pressed
  // a button several screens down and must be shown where the answer will appear — but only START
  // one when there is nothing pending and nothing already running.
  useEffect(() => {
    if (!runRequest) return;
    cardRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    if (draft === null && !analysing && !disabled) void run();
    onRunHandled?.();
    // `run` closes over `instructions`; including it here would re-fire this effect on every
    // keystroke in that field, for no behavioural change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequest]);

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
          // Settings rather than topics, but read out of the same routing prose in the same pass,
          // so they are accepted or discarded with it rather than left for the admin to re-derive.
          // `.length > 0`, not truthiness: `[]` is truthy, and `acceptTopicDraft` merges on
          // `!== undefined` — so sending an empty array would ERASE the admin's existing list
          // rather than leave it alone, which is the opposite of "the proposal said nothing".
          ...((draft.fallbackTopicKeys?.length ?? 0) > 0
            ? { fallbackTopicKeys: draft.fallbackTopicKeys }
            : {}),
          ...((draft.checkTopicPreference?.length ?? 0) > 0
            ? { checkTopicPreference: draft.checkTopicPreference }
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

  // Settings lists and the depth-correction note address topics by key; a reviewer reads labels.
  // Falls back to the key so an unresolvable one is visible rather than blank — though
  // `narrowProposedTopicSet` already drops settings keys the proposal does not carry.
  const labelForKey = (key: string): string =>
    draft?.topics.find((t) => t.key === key)?.label ?? key;

  return (
    <Card className="overflow-hidden shadow-sm" ref={cardRef}>
      <CardHeader className="bg-muted/30 flex-row items-start gap-3 space-y-0 border-b p-4">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <FileSearch className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <CardTitle className="text-sm font-semibold">Suggest topics from your document</CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            Reads your uploaded document — including the guidance extraction ignores, wherever it
            sits: routing notes, eligibility rules, instructions about who answers what — and
            proposes the topics it describes, each traced back to the words it came from. Nothing
            goes live until you accept it.
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
            {candidacy?.isCandidate ? (
              <div className={SKY_BANNER_CLASSNAME}>
                <p className="font-medium">
                  {/* `analysing` gates the present-progressive wording, not `autoStarted` alone —
                      `autoStarted` never resets, so without this a SILENT auto-run that failed
                      (rate limited, unseeded agent) would claim to be "drafting automatically"
                      forever, right beside a button that had gone back to idle underneath it. */}
                  {autoStarted && analysing
                    ? 'This document reads like it describes routing — drafting a starting point automatically.'
                    : 'This document reads like it describes routing.'}
                </p>
                <p>{candidacy.summary}</p>
              </div>
            ) : (
              /* F17.22 Phase 1. The ingestion-time check is deliberately quote-grounded and biased
                 to "no" — it answers "does the document SAY it routes", not "could this instrument
                 usefully route". Rendering nothing on a negative verdict (which is what this branch
                 used to do) left an admin with no way to know the analyst existed at all, in
                 exactly the case where they most need telling: the analyst can still propose
                 conditional topics from the questions themselves, and says so on its own proposal
                 (`fromDocument: false`). Muted, not a warning — nothing is wrong here. */
              <div className="text-muted-foreground bg-muted/40 space-y-1 rounded-md border p-3 text-sm">
                <p className="text-foreground font-medium">
                  {candidacy === null
                    ? 'This version has not been checked for routing instructions.'
                    : 'No explicit routing instructions were found in your document.'}
                </p>
                <p>
                  The analyst can still propose conditional topics from the questionnaire’s own
                  questions — it will tell you it inferred them rather than read them, so you can
                  check each criterion before accepting. Nothing goes live until you do.
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                Where are the routing rules? (optional){' '}
                <FieldHelp title="Steering the suggestions">
                  A one-line pointer saves the analyst hunting: “the routing rules are in the notes
                  before the questions”, or “sections 4–7 only apply to some respondents”. It is
                  used for this run only and is not saved.
                </FieldHelp>
              </Label>
              <Input
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="e.g. the routing rules are in the notes before the questions"
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
                  ? SKY_BANNER_CLASSNAME
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
              {draft.gaps.length > 0 && (
                <>
                  {' '}
                  · {draft.gaps.length} unformalized {draft.gaps.length === 1 ? 'gap' : 'gaps'}
                </>
              )}
              {draft.maxConditionalTopics !== undefined && (
                <> · limit of {draft.maxConditionalTopics} per interview</>
              )}
            </p>

            {((draft.fallbackTopicKeys?.length ?? 0) > 0 ||
              (draft.checkTopicPreference?.length ?? 0) > 0) && (
              <div className="text-muted-foreground space-y-1 text-sm">
                {draft.fallbackTopicKeys && draft.fallbackTopicKeys.length > 0 && (
                  <p>
                    <span className="text-foreground font-medium">Ask if nothing matches:</span>{' '}
                    {draft.fallbackTopicKeys.map(labelForKey).join(', ')}
                  </p>
                )}
                {draft.checkTopicPreference && draft.checkTopicPreference.length > 0 && (
                  <p>
                    <span className="text-foreground font-medium">Sample as a blind spot:</span>{' '}
                    {draft.checkTopicPreference.map(labelForKey).join(', ')}
                  </p>
                )}
              </div>
            )}

            {/* Corrected, not refused (see narrowProposedTopicSet) — but never silently. The admin
                needs to know the analyst asked for something that would have dropped questions. */}
            {draft.depthCorrectedKeys && draft.depthCorrectedKeys.length > 0 && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                {draft.depthCorrectedKeys.length === 1 ? 'One topic' : 'Some topics'} came back set
                to Light depth but {draft.depthCorrectedKeys.length === 1 ? 'runs' : 'run'} for
                everyone — {draft.depthCorrectedKeys.map(labelForKey).join(', ')}. Light would have
                dropped questions for every respondent, so{' '}
                {draft.depthCorrectedKeys.length === 1 ? 'it has' : 'they have'} been set back to
                Full.
              </p>
            )}

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

            {draft.gaps.length > 0 && (
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Recognized but not formalized
                  <FieldHelp title="Things it could not turn into a topic">
                    The document plainly states a routing or eligibility instruction here, but the
                    analyst could not turn it into a topic or a hard rule — often because it names
                    something not modeled as a data slot, or is too vague to check mechanically.
                    Accepting the proposal below does not cover these; review them and add a topic,
                    criteria, or rule by hand if they matter.
                  </FieldHelp>
                </p>
                <ul className="space-y-2">
                  {draft.gaps.map((gap, i) => (
                    <li
                      key={i}
                      className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                    >
                      <p className="flex items-start gap-1.5 italic">
                        <Quote className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                        {gap.sourceQuote}
                      </p>
                      <p>{gap.explanation}</p>
                      {onTurnGapIntoTopic && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 border-amber-300 bg-transparent text-[11px] text-amber-900 hover:bg-amber-100 dark:border-amber-500/30 dark:text-amber-200 dark:hover:bg-amber-500/20"
                          onClick={() => onTurnGapIntoTopic(gap)}
                        >
                          <Plus className="mr-1 h-3 w-3" aria-hidden="true" /> Turn into topic
                        </Button>
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
