'use client';

/**
 * Data-slots review surface (Data Slots feature).
 *
 * Shows the version's data slots, lets the admin GENERATE a proposed set from the approved
 * questions (one LLM call) and review/edit/remove each slot, then SAVE the set
 * (a PUT that replaces the version's slots; forks a launched version first).
 *
 * A generated set is a persisted DRAFT, not the live set: generation writes it server-side so
 * it survives navigation, but respondents and the launch gate only ever see SAVED slots. The
 * surface makes the distinction explicit — a "draft / not live yet" banner, per-slot Draft vs
 * Live badges, a Discard control, and an unsaved-edits navigation guard. The conversation later
 * targets the saved slots; each maps to one or more questions it captures.
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Sparkles, Trash2, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SaveButton } from '@/components/admin/questionnaires/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AutoTextarea } from '@/components/ui/auto-textarea';
import { Badge } from '@/components/ui/badge';
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
import { useUnsavedChangesWarning } from '@/lib/hooks/use-unsaved-changes-warning';
import {
  authoringMutate,
  AuthoringError,
} from '@/components/admin/questionnaires/authoring-mutate';
import { DataSlotGranularityField } from '@/components/admin/questionnaires/data-slot-granularity-field';
import { DataSlotRefineButton } from '@/components/admin/questionnaires/data-slot-refine-button';
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
  /** Stable client-side id used as a React key, so re-grouping (e.g. on a theme rename) doesn't
   *  remount cards mid-edit. Not persisted — `assignIds` stamps it. */
  id: string;
  name: string;
  description: string;
  theme: string;
  questionKeys: string[];
}

/** The persisted shape of an editable slot, before a client id is stamped on. */
type DraftSlotData = Omit<DraftSlot, 'id'>;

function fromGenerated(slot: GeneratedDataSlot): DraftSlotData {
  return {
    name: slot.name,
    description: slot.description,
    theme: slot.theme,
    questionKeys: slot.questionKeys,
  };
}

function fromSaved(slot: DataSlotView): DraftSlotData {
  return {
    name: slot.name,
    description: slot.description,
    theme: slot.theme,
    questionKeys: slot.questionKeys,
  };
}

/** Group slots by their (exact) theme, preserving first-appearance order. The respondent panel
 *  groups the same way (`answer-panel.ts`), so the editor mirrors the live hierarchy: one theme
 *  heading over the slots that share it. Each group's React key is its first member's stable id,
 *  so renaming the theme keeps the group mounted (and the header input focused). */
interface ThemeGroup {
  key: string;
  theme: string;
  members: { slot: DraftSlot; index: number }[];
}

function groupByTheme(drafts: DraftSlot[]): ThemeGroup[] {
  const groups: ThemeGroup[] = [];
  const byTheme = new Map<string, ThemeGroup>();
  drafts.forEach((slot, index) => {
    let group = byTheme.get(slot.theme);
    if (!group) {
      group = { key: slot.id, theme: slot.theme, members: [] };
      byTheme.set(slot.theme, group);
      groups.push(group);
    }
    group.members.push({ slot, index });
  });
  return groups;
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

  // Stable client ids for React keys. The SEED ids are index-derived (`slot-0`, `slot-1`, …) so
  // they're identical on the server render and client hydration — and identical however many times
  // React invokes the lazy initializer (Strict Mode double-invokes it). The monotonic counter mints
  // ids only for sets created AFTER mount (generate/save/discard), starting past the seed length so
  // it can't collide with a seed id.
  const seedCount = initialDraft ? initialDraft.slots.length : initialSlots.length;
  const idSeq = useRef(seedCount);
  const assignIds = (slots: DraftSlotData[]): DraftSlot[] =>
    slots.map((s) => ({ ...s, id: `slot-${idSeq.current++}` }));

  const [liveSlots, setLiveSlots] = useState<DataSlotView[]>(initialSlots);
  const [drafts, setDrafts] = useState<DraftSlot[]>(() =>
    (initialDraft ? initialDraft.slots.map(fromGenerated) : initialSlots.map(fromSaved)).map(
      (s, i) => ({ ...s, id: `slot-${i}` })
    )
  );
  const [mode, setMode] = useState<SlotMode>(initialDraft ? 'draft' : 'live');
  const [baseline, setBaseline] = useState<string>(() => signature(drafts));
  const [granularity, setGranularity] = useState<DataSlotGranularity>(
    DEFAULT_DATA_SLOT_GRANULARITY
  );
  const [progress, setProgress] = useState<DataSlotGenProgress | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Index of the slot pending a delete confirmation, or null.
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  // Whether the discard-draft confirmation is open.
  const [confirmDiscard, setConfirmDiscard] = useState(false);

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
        resetTo(assignIds(finalSlots.map(fromGenerated)), 'draft');
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

  // Rename a theme on every slot that shares it — theme is one shared group label, not a per-slot
  // value, so editing it in one place keeps the group together (an exact-string match drives the
  // respondent panel's grouping). Renaming onto an existing theme merges the two groups.
  const renameTheme = (from: string, to: string) => {
    setDrafts((prev) => prev.map((d) => (d.theme === from ? { ...d, theme: to } : d)));
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

  // Splice an AI-refined slot into the working set in place. Keyed by the slot's stable id, NOT its
  // array index: a refine is async (the LLM call can run for many seconds) and the admin may remove
  // another slot meanwhile, shifting indices — matching on id lands the result on the right slot.
  // Like a manual edit, it's client-only until Save (the refine endpoint persists nothing).
  const refineSlot = (id: string, refined: GeneratedDataSlot) => {
    setDrafts((prev) =>
      prev.map((d) =>
        d.id === id
          ? {
              ...d,
              name: refined.name,
              description: refined.description,
              theme: refined.theme,
              questionKeys: refined.questionKeys,
            }
          : d
      )
    );
    setError(null);
    setNotice('Slot refined — review and save.');
  };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authoringMutate<{ slots: DataSlotView[] }>(
        'PUT',
        API.APP.QUESTIONNAIRES.versionDataSlots(questionnaireId, versionId),
        {
          slots: drafts.map((d) => ({
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
        return true;
      }
      setLiveSlots(res.data.slots);
      resetTo(assignIds(res.data.slots.map(fromSaved)), 'live');
      setNotice(`Saved ${res.data.slots.length} data slots — now live.`);
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof AuthoringError ? err.message : 'Could not save data slots.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const discard = async () => {
    setDiscarding(true);
    setError(null);
    setNotice(null);
    try {
      await authoringMutate(
        'DELETE',
        API.APP.QUESTIONNAIRES.versionDataSlotsDraft(questionnaireId, versionId)
      );
      resetTo(assignIds(liveSlots.map(fromSaved)), 'live');
      setNotice('Draft discarded.');
      router.refresh();
    } catch (err) {
      setError(err instanceof AuthoringError ? err.message : 'Could not discard the draft.');
    } finally {
      setDiscarding(false);
    }
  };

  const coveredKeys = new Set(drafts.flatMap((d) => d.questionKeys));
  const uncovered = questions.filter((q) => !coveredKeys.has(q.key));
  const isDraft = mode === 'draft';

  return (
    <div className="space-y-5">
      {/* Generation band — mirrors the Structure editor's blueprint header: a faint drafting
          grid that names the surface, carries the primary Generate action, and houses the
          granularity control. */}
      <div className="cq-blueprint relative overflow-hidden rounded-xl border">
        <div className="bg-card/70 space-y-4 p-4 backdrop-blur-sm">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)]">
                <Sparkles className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-semibold tracking-tight">
                  {drafts.length === 0 ? 'Generate data slots' : 'Regenerate data slots'}
                </h3>
                <p className="text-muted-foreground text-xs">
                  {drafts.length === 0
                    ? 'Propose a set from this version’s questions, then review and save.'
                    : isDraft
                      ? `${drafts.length} draft slot${drafts.length === 1 ? '' : 's'} — not live yet.`
                      : `${drafts.length} live slot${drafts.length === 1 ? '' : 's'}.`}
                </p>
              </div>
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
        <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
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

      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300">
          {notice}
        </div>
      )}

      {!generating && uncovered.length > 0 && drafts.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {uncovered.length} question{uncovered.length === 1 ? '' : 's'} not yet covered by any slot
          ({uncovered.map((q) => q.key).join(', ')}). The respondent flow will still ask these
          directly, but covering them keeps the conversation natural.
        </p>
      )}

      {!generating && (
        <div className="space-y-5">
          {groupByTheme(drafts).map((group, groupIndex) => (
            // Theme group as a plated card — same chrome as a Structure section: a mono index
            // plate, an inline-editable title, a count, and a spine connecting it to its slots.
            <section key={group.key} className="bg-card rounded-xl border shadow-sm">
              {/* Theme plate header. Theme is one shared label for the whole group — edited here
                  once, not per slot — so it reads as the section title, not a form field. */}
              <div className="flex items-center gap-2.5 border-b px-4 py-3">
                <span
                  className="flex h-7 min-w-7 items-center justify-center rounded-md border border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)] px-1.5 font-mono text-xs font-semibold text-[var(--cq-accent)]"
                  aria-hidden
                >
                  {String(groupIndex + 1).padStart(2, '0')}
                </span>
                <Input
                  id={`theme-${group.key}`}
                  value={group.theme}
                  onChange={(e) => renameTheme(group.theme, e.target.value)}
                  placeholder="Theme"
                  aria-label="Theme"
                  className="h-8 border-transparent bg-transparent text-base font-semibold tracking-tight shadow-none focus-visible:border-[var(--color-input)] focus-visible:bg-[var(--color-background)]"
                />
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {group.members.length} slot{group.members.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="p-4">
                {/* Outline spine connecting the plate to its slots (mirrors the section editor). */}
                <ul className="cq-spine ml-3 space-y-2.5 pl-4">
                  {group.members.map(({ slot: d, index: i }) => (
                    <li
                      key={d.id}
                      className="group bg-card relative space-y-3 rounded-lg border p-3 transition-shadow hover:border-[var(--cq-accent-ring)] hover:shadow-sm"
                    >
                      {/* Connector tick onto the theme spine. */}
                      <span
                        className="absolute top-6 -left-4 h-px w-4 bg-[var(--cq-accent-muted)]"
                        aria-hidden
                      />
                      <div className="flex items-start justify-between gap-2">
                        {/* Slot name reads as the card's title (inline-edit), like a question prompt. */}
                        <Input
                          id={`slot-name-${d.id}`}
                          value={d.name}
                          onChange={(e) => update(i, { name: e.target.value })}
                          placeholder="Slot name (1–4 words)"
                          aria-label="Slot name"
                          className="h-8 border-transparent bg-transparent text-sm font-semibold tracking-tight shadow-none focus-visible:border-[var(--color-input)] focus-visible:bg-[var(--color-background)]"
                        />
                        <div className="flex shrink-0 items-center gap-1">
                          <DataSlotRefineButton
                            questionnaireId={questionnaireId}
                            versionId={versionId}
                            slot={{
                              name: d.name,
                              description: d.description,
                              theme: d.theme,
                              questionKeys: d.questionKeys,
                            }}
                            // The other slots' names + themes, so the refiner keeps the theme
                            // consistent with the set and doesn't duplicate a sibling.
                            siblingSlots={drafts
                              .filter((s) => s.id !== d.id)
                              .map((s) => ({ name: s.name, theme: s.theme }))}
                            disabled={busy}
                            onRefined={(refined) => refineSlot(d.id, refined)}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setDeleteIndex(i)}
                            aria-label="Remove slot"
                          >
                            <Trash2 className="text-muted-foreground h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <Label
                          htmlFor={`slot-description-${d.id}`}
                          className="text-muted-foreground text-xs"
                        >
                          Description
                        </Label>
                        <AutoTextarea
                          id={`slot-description-${d.id}`}
                          value={d.description}
                          onChange={(e) => update(i, { description: e.target.value })}
                          placeholder="What this slot must capture, why it matters, and what to probe for"
                          className="min-h-24"
                        />
                      </div>

                      <QuestionCoverageEditor
                        questions={questions}
                        selectedKeys={d.questionKeys}
                        onToggle={(key) => toggleQuestion(i, key)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ))}
        </div>
      )}

      {!generating && drafts.length > 0 && (
        // Sticky footer so the primary action stays reachable however long the list is.
        <div className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-0 z-20 -mx-6 flex items-center gap-3 border-t px-6 py-3 backdrop-blur">
          <SaveButton onSave={save} disabled={busy || (!isDraft && !dirty)}>
            {isDraft ? `Save & make live (${drafts.length})` : `Save changes (${drafts.length})`}
          </SaveButton>
          {isDraft && (
            <Button variant="outline" onClick={() => setConfirmDiscard(true)} disabled={busy}>
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

      <AlertDialog
        open={deleteIndex !== null}
        onOpenChange={(open) => !open && setDeleteIndex(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this data slot?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteIndex !== null && drafts[deleteIndex]?.name
                ? `“${drafts[deleteIndex]?.name}” will be removed from this set. `
                : 'This data slot will be removed from this set. '}
              You can get it back by regenerating, but it’s gone for good once you save.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteIndex !== null) remove(deleteIndex);
                setDeleteIndex(null);
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              Remove slot
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this generated draft?</AlertDialogTitle>
            <AlertDialogDescription>
              The proposal is removed and your live data slots are left unchanged.
              {liveSlots.length === 0 && ' Launching this version requires saved data slots.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDiscard(false);
                void discard();
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              Discard draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
