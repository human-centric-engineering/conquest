'use client';

/**
 * Data-slots review surface (Data Slots feature).
 *
 * Shows the version's data slots, lets the admin GENERATE a proposed set from the approved
 * questions (one LLM call) and review/edit/reject each slot, then SAVE the accepted set
 * (a PUT that replaces the version's slots; forks a launched version first).
 *
 * A generated set is a persisted DRAFT, not the live set: generation writes it server-side so
 * it survives navigation, but respondents and the launch gate only ever see SAVED slots. The
 * surface makes the distinction explicit — a "draft / not live yet" banner, per-slot Draft vs
 * Live badges, a Discard control, and an unsaved-edits navigation guard. The conversation later
 * targets the saved slots; each maps to one or more questions it captures.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Sparkles, Trash2, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { useUnsavedChangesWarning } from '@/lib/hooks/use-unsaved-changes-warning';
import {
  authoringMutate,
  AuthoringError,
} from '@/components/admin/questionnaires/authoring-mutate';
import { DataSlotGranularityField } from '@/components/admin/questionnaires/data-slot-granularity-field';
import { QuestionCoverageEditor } from '@/components/admin/questionnaires/question-coverage-editor';
import {
  DataSlotGenerationProgress,
  type DataSlotGenProgress,
} from '@/components/admin/questionnaires/data-slot-generation-progress';
import {
  DEFAULT_DATA_SLOT_GRANULARITY,
  type DataSlotView,
  type DataSlotDraftView,
  type DataSlotGenEvent,
  type DataSlotGranularity,
  type GeneratedDataSlot,
} from '@/lib/app/questionnaire/data-slots';

interface QuestionRef {
  key: string;
  prompt: string;
}

export interface DataSlotsReviewProps {
  questionnaireId: string;
  versionId: string;
  questions: QuestionRef[];
  /** The saved, LIVE data slots (what respondents and the launch gate see). */
  initialSlots: DataSlotView[];
  /** A pending generated proposal the admin hasn't saved yet, if any. */
  initialDraft: DataSlotDraftView | null;
}

/** Whether the working set is an unsaved generated proposal or the saved live set. */
type SlotMode = 'draft' | 'live';

/** An editable slot in the working set (a proposed or saved slot the admin tweaks). */
interface DraftSlot {
  name: string;
  description: string;
  theme: string;
  questionKeys: string[];
  accepted: boolean;
}

function fromGenerated(slot: GeneratedDataSlot): DraftSlot {
  return {
    name: slot.name,
    description: slot.description,
    theme: slot.theme,
    questionKeys: slot.questionKeys,
    accepted: true,
  };
}

function fromSaved(slot: DataSlotView): DraftSlot {
  return {
    name: slot.name,
    description: slot.description,
    theme: slot.theme,
    questionKeys: slot.questionKeys,
    accepted: true,
  };
}

/**
 * Friendlier guidance for the config/provider diagnostic codes, whose server-side
 * message is a raw provider error. For the other codes (timeout, incomplete_response,
 * invalid_response, …) the capability already returns a clear, actionable message,
 * so we show that verbatim — see `diagnosticToMessage`.
 */
const DIAGNOSTIC_GUIDANCE: Record<string, string> = {
  no_provider_configured:
    'No LLM provider is configured for the data-slot generator agent. Set one up under AI Orchestration → Providers, then try again.',
  provider_unavailable:
    'The data-slot generator agent’s LLM provider is unavailable — check its API key/credentials and status, then try again.',
  unknown_capability:
    'The data-slot generator isn’t registered (run the database seed), then try again.',
};

/** Resolve the most accurate message: code-specific guidance → server message → generic. */
function diagnosticToMessage(code?: string, message?: string): string {
  if (!code && !message) return 'Generation did not return any slots. Try again.';
  if (code && DIAGNOSTIC_GUIDANCE[code]) return DIAGNOSTIC_GUIDANCE[code];
  if (message) return message;
  return code ? `Generation failed (${code}). Try again.` : 'Generation failed. Try again.';
}

/** A stable signature of the editable fields, so we can detect unsaved edits. */
function signature(drafts: DraftSlot[]): string {
  return JSON.stringify(
    drafts.map((d) => ({
      name: d.name.trim(),
      description: d.description.trim(),
      theme: d.theme.trim(),
      questionKeys: [...d.questionKeys].sort(),
      accepted: d.accepted,
    }))
  );
}

export function DataSlotsReview({
  questionnaireId,
  versionId,
  questions,
  initialSlots,
  initialDraft,
}: DataSlotsReviewProps) {
  const router = useRouter();

  const seed = initialDraft ? initialDraft.slots.map(fromGenerated) : initialSlots.map(fromSaved);
  const [liveSlots, setLiveSlots] = useState<DataSlotView[]>(initialSlots);
  const [drafts, setDrafts] = useState<DraftSlot[]>(seed);
  const [mode, setMode] = useState<SlotMode>(initialDraft ? 'draft' : 'live');
  const [baseline, setBaseline] = useState<string>(() => signature(seed));
  const [granularity, setGranularity] = useState<DataSlotGranularity>(
    DEFAULT_DATA_SLOT_GRANULARITY
  );
  const [progress, setProgress] = useState<DataSlotGenProgress | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty = signature(drafts) !== baseline;
  const busy = generating || saving || discarding;

  // Warn before leaving with unsaved edits (a generated draft itself is persisted and safe).
  useUnsavedChangesWarning(dirty);

  const resetTo = (next: DraftSlot[], nextMode: SlotMode) => {
    setDrafts(next);
    setMode(nextMode);
    setBaseline(signature(next));
  };

  // Apply one streamed progress event to the live progress panel.
  const applyEvent = (ev: DataSlotGenEvent) => {
    switch (ev.type) {
      case 'start':
        setProgress({
          phase: 'mapping',
          totalQuestions: ev.totalQuestions,
          sections: ev.groups.map((g) => ({
            index: g.index,
            title: g.title,
            questionCount: g.questionCount,
            status: 'running',
            slots: [],
          })),
        });
        break;
      case 'group_done':
        setProgress((p) =>
          p
            ? {
                ...p,
                sections: p.sections.map((s) =>
                  s.index === ev.index ? { ...s, status: 'done', slots: ev.slots } : s
                ),
              }
            : p
        );
        break;
      case 'group_error':
        setProgress((p) =>
          p
            ? {
                ...p,
                sections: p.sections.map((s) =>
                  s.index === ev.index ? { ...s, status: 'error', message: ev.message } : s
                ),
              }
            : p
        );
        break;
      case 'merge_start':
        setProgress((p) => (p ? { ...p, phase: 'merging', rawSlotCount: ev.rawSlotCount } : p));
        break;
      case 'merge_warning':
        setProgress((p) => (p ? { ...p, mergeWarning: ev.message } : p));
        break;
      default:
        break; // 'done' / 'error' are handled by the reader loop below.
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    setNotice(null);
    setProgress(null);
    try {
      const res = await fetch(
        API.APP.QUESTIONNAIRES.versionDataSlotsGenerateStream(questionnaireId, versionId),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ granularity }),
        }
      );

      // A non-2xx (rate limit, flag off, …) returns the standard JSON error envelope, not a stream.
      if (!res.ok || !res.body) {
        let message: string | undefined;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          message = body.error?.message;
        } catch {
          // Non-JSON body — fall through to the generic message.
        }
        setError(message ?? `Generation failed (${res.status}). Try again.`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalSlots: GeneratedDataSlot[] | null = null;
      let streamError: string | null = null;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (parsed) {
            const ev = parsed.data as unknown as DataSlotGenEvent;
            if (ev.type === 'done') finalSlots = ev.slots;
            else if (ev.type === 'error') streamError = diagnosticToMessage(ev.code, ev.message);
            else applyEvent(ev);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      if (streamError) {
        setError(streamError);
      } else if (finalSlots && finalSlots.length > 0) {
        resetTo(finalSlots.map(fromGenerated), 'draft');
        setNotice(
          `Generated ${finalSlots.length} draft data slot${
            finalSlots.length === 1 ? '' : 's'
          } — review and save to make them live.`
        );
      } else {
        setError('Generation did not return any slots. Try again.');
      }
    } catch (err) {
      setError(err instanceof AuthoringError ? err.message : 'Could not generate data slots.');
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  };

  const update = (index: number, patch: Partial<DraftSlot>) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const toggleQuestion = (index: number, key: string) => {
    setDrafts((prev) =>
      prev.map((d, i) =>
        i === index
          ? {
              ...d,
              questionKeys: d.questionKeys.includes(key)
                ? d.questionKeys.filter((k) => k !== key)
                : [...d.questionKeys, key],
            }
          : d
      )
    );
  };

  const remove = (index: number) => setDrafts((prev) => prev.filter((_, i) => i !== index));

  const save = async () => {
    const accepted = drafts.filter((d) => d.accepted);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authoringMutate<{ slots: DataSlotView[] }>(
        'PUT',
        API.APP.QUESTIONNAIRES.versionDataSlots(questionnaireId, versionId),
        {
          slots: accepted.map((d) => ({
            name: d.name,
            description: d.description,
            theme: d.theme,
            questionKeys: d.questionKeys,
          })),
        }
      );
      // A launched version forks a new draft — navigate there so the admin keeps editing.
      if (res.meta?.forked) {
        router.push(`/admin/questionnaires/${questionnaireId}/v/${res.meta.versionId}/data-slots`);
        return;
      }
      setLiveSlots(res.data.slots);
      resetTo(res.data.slots.map(fromSaved), 'live');
      setNotice(`Saved ${res.data.slots.length} data slots — now live.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof AuthoringError ? err.message : 'Could not save data slots.');
    } finally {
      setSaving(false);
    }
  };

  const discard = async () => {
    if (
      !window.confirm(
        'Discard this generated draft? The proposal is removed and your live data slots are left unchanged.'
      )
    ) {
      return;
    }
    setDiscarding(true);
    setError(null);
    setNotice(null);
    try {
      await authoringMutate(
        'DELETE',
        API.APP.QUESTIONNAIRES.versionDataSlotsDraft(questionnaireId, versionId)
      );
      resetTo(liveSlots.map(fromSaved), 'live');
      setNotice('Draft discarded.');
      router.refresh();
    } catch (err) {
      setError(err instanceof AuthoringError ? err.message : 'Could not discard the draft.');
    } finally {
      setDiscarding(false);
    }
  };

  const coveredKeys = new Set(drafts.filter((d) => d.accepted).flatMap((d) => d.questionKeys));
  const uncovered = questions.filter((q) => !coveredKeys.has(q.key));
  const acceptedCount = drafts.filter((d) => d.accepted).length;
  const isDraft = mode === 'draft';

  return (
    <div className="space-y-5">
      <div className="bg-muted/30 space-y-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="space-y-0.5">
            <h3 className="text-sm font-medium">
              {drafts.length === 0 ? 'Generate data slots' : 'Regenerate data slots'}
            </h3>
            <p className="text-muted-foreground text-sm">
              {drafts.length === 0
                ? 'Propose a set from this version’s questions, then review and save.'
                : isDraft
                  ? `${drafts.length} draft slot${drafts.length === 1 ? '' : 's'} — not live yet.`
                  : `${drafts.length} live slot${drafts.length === 1 ? '' : 's'}.`}
            </p>
          </div>
          <Button onClick={() => void generate()} disabled={busy}>
            {generating ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-4 w-4" />
            )}
            {drafts.length === 0 ? 'Generate' : 'Discard and regenerate'}
          </Button>
        </div>

        <DataSlotGranularityField value={granularity} onChange={setGranularity} disabled={busy} />
      </div>

      {progress && <DataSlotGenerationProgress progress={progress} />}

      {/* Make the fate of the current set explicit while a new one streams in. The existing
          list is hidden below during generation so it's clear it's being replaced. */}
      {generating && drafts.length > 0 && (
        <p className="text-muted-foreground text-sm">
          {isDraft
            ? `Generating a new set — it will replace the current unsaved draft of ${drafts.length} data slot${
                drafts.length === 1 ? '' : 's'
              } when it finishes.`
            : `Generating a new set — it will load as a draft to review; your ${drafts.length} live data slot${
                drafts.length === 1 ? '' : 's'
              } stay in use until you save the new set.`}
        </p>
      )}

      {!generating && isDraft && drafts.length > 0 && (
        <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/40">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1.5">
            <p className="font-medium text-amber-900 dark:text-amber-200">Draft — not live yet</p>
            <p className="text-amber-800 dark:text-amber-300/90">
              These {drafts.length} data slot{drafts.length === 1 ? '' : 's'} were generated but
              haven’t been saved. Respondents won’t see them until you save.{' '}
              {liveSlots.length > 0
                ? `Your ${liveSlots.length} live data slot${liveSlots.length === 1 ? '' : 's'} stay in use until then.`
                : 'Launching this version requires saved data slots.'}
            </p>
          </div>
        </div>
      )}

      {!generating && !isDraft && dirty && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          You have unsaved edits to your live data slots. Save to apply them.
        </p>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      {!generating && uncovered.length > 0 && drafts.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {uncovered.length} question{uncovered.length === 1 ? '' : 's'} not yet covered by any
          accepted slot ({uncovered.map((q) => q.key).join(', ')}). The respondent flow will still
          ask these directly, but covering them keeps the conversation natural.
        </p>
      )}

      {!generating && (
        <ul className="space-y-4">
          {drafts.map((d, i) => (
            <li
              key={i}
              className={`space-y-3 rounded-md border p-4 ${d.accepted ? '' : 'opacity-60'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-1 items-center gap-2">
                  <Checkbox
                    checked={d.accepted}
                    onCheckedChange={(v) => update(i, { accepted: v === true })}
                    aria-label="Accept this slot"
                  />
                  {isDraft ? (
                    <Badge
                      variant="outline"
                      className="border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
                    >
                      Draft
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                    >
                      Live
                    </Badge>
                  )}
                  <Input
                    value={d.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder="Slot name (1–4 words)"
                    className="max-w-xs font-medium"
                  />
                  <Input
                    value={d.theme}
                    onChange={(e) => update(i, { theme: e.target.value })}
                    placeholder="Theme"
                    className="max-w-[12rem]"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(i)}
                  aria-label="Remove slot"
                >
                  <Trash2 className="text-muted-foreground h-4 w-4" />
                </Button>
              </div>

              <Textarea
                value={d.description}
                onChange={(e) => update(i, { description: e.target.value })}
                placeholder="What this slot must capture, why it matters, and what to probe for"
                rows={4}
              />

              <QuestionCoverageEditor
                questions={questions}
                selectedKeys={d.questionKeys}
                onToggle={(key) => toggleQuestion(i, key)}
              />
            </li>
          ))}
        </ul>
      )}

      {!generating && drafts.length > 0 && (
        // Sticky footer so the primary action stays reachable however long the list is.
        <div className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-0 z-20 -mx-6 flex items-center gap-3 border-t px-6 py-3 backdrop-blur">
          <Button onClick={() => void save()} disabled={busy || (!isDraft && !dirty)}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {isDraft ? `Save & make live (${acceptedCount})` : `Save changes (${acceptedCount})`}
          </Button>
          {isDraft && (
            <Button variant="outline" onClick={() => void discard()} disabled={busy}>
              {discarding ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Undo2 className="mr-1.5 h-4 w-4" />
              )}
              Discard
            </Button>
          )}
          <Badge variant="outline" className="ml-auto">
            {coveredKeys.size}/{questions.length} questions covered
          </Badge>
        </div>
      )}
    </div>
  );
}
