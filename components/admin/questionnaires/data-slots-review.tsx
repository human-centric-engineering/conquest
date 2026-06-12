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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { API } from '@/lib/api/endpoints';
import { useUnsavedChangesWarning } from '@/lib/hooks/use-unsaved-changes-warning';
import {
  authoringMutate,
  AuthoringError,
} from '@/components/admin/questionnaires/authoring-mutate';
import { StatusTicker, DATA_SLOT_MESSAGES } from '@/components/admin/questionnaires/status-ticker';
import type {
  DataSlotView,
  DataSlotDraftView,
  GeneratedDataSlot,
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
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const promptByKey = new Map(questions.map((q) => [q.key, q.prompt]));
  const dirty = signature(drafts) !== baseline;
  const busy = generating || saving || discarding;

  // Warn before leaving with unsaved edits (a generated draft itself is persisted and safe).
  useUnsavedChangesWarning(dirty);

  const resetTo = (next: DraftSlot[], nextMode: SlotMode) => {
    setDrafts(next);
    setMode(nextMode);
    setBaseline(signature(next));
  };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authoringMutate<{ slots: GeneratedDataSlot[]; diagnostic?: string }>(
        'POST',
        API.APP.QUESTIONNAIRES.versionDataSlotsGenerate(questionnaireId, versionId)
      );
      if (res.data.diagnostic || res.data.slots.length === 0) {
        setError(
          res.data.diagnostic
            ? `Generation failed (${res.data.diagnostic}). Check an LLM provider is configured for this agent, then try again.`
            : 'Generation did not return any slots. Try again.'
        );
      } else {
        resetTo(res.data.slots.map(fromGenerated), 'draft');
        setNotice(
          `Generated ${res.data.slots.length} draft data slots — review and save to make them live.`
        );
      }
    } catch (err) {
      setError(err instanceof AuthoringError ? err.message : 'Could not generate data slots.');
    } finally {
      setGenerating(false);
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
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {drafts.length === 0
            ? 'No data slots yet. Generate a set from this version’s questions.'
            : isDraft
              ? `${drafts.length} draft data slot${drafts.length === 1 ? '' : 's'} — not live yet.`
              : `${drafts.length} live data slot${drafts.length === 1 ? '' : 's'}.`}
        </p>
        <Button variant="outline" size="sm" onClick={() => void generate()} disabled={busy}>
          {generating ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-4 w-4" />
          )}
          {drafts.length === 0 ? 'Generate data slots' : 'Regenerate'}
        </Button>
      </div>

      {generating && <StatusTicker messages={DATA_SLOT_MESSAGES} />}

      {isDraft && drafts.length > 0 && (
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => void discard()}
              disabled={busy}
              className="mt-1"
            >
              {discarding ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Undo2 className="mr-1.5 h-4 w-4" />
              )}
              Discard draft
            </Button>
          </div>
        </div>
      )}

      {!isDraft && dirty && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          You have unsaved edits to your live data slots. Save to apply them.
        </p>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      {uncovered.length > 0 && drafts.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {uncovered.length} question{uncovered.length === 1 ? '' : 's'} not yet covered by any
          accepted slot ({uncovered.map((q) => q.key).join(', ')}). The respondent flow will still
          ask these directly, but covering them keeps the conversation natural.
        </p>
      )}

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
              placeholder="What this slot captures and why it matters"
              rows={2}
            />

            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">Covers questions</Label>
              <div className="flex flex-wrap gap-2">
                {questions.map((q) => {
                  const on = d.questionKeys.includes(q.key);
                  return (
                    <button
                      key={q.key}
                      type="button"
                      onClick={() => toggleQuestion(i, q.key)}
                      title={q.prompt}
                      className={
                        on
                          ? 'bg-primary/10 text-foreground rounded-md border border-transparent px-2 py-1 text-xs'
                          : 'text-muted-foreground hover:bg-accent rounded-md border px-2 py-1 text-xs'
                      }
                    >
                      {q.key}
                    </button>
                  );
                })}
              </div>
              {d.questionKeys.some((k) => !promptByKey.has(k)) && (
                <p className="text-destructive text-xs">
                  Some mapped keys aren’t in this version and will be dropped on save.
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

      {drafts.length > 0 && (
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={busy || (!isDraft && !dirty)}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {isDraft ? `Save & make live (${acceptedCount})` : `Save changes (${acceptedCount})`}
          </Button>
          <Badge variant="outline">
            {coveredKeys.size}/{questions.length} questions covered
          </Badge>
        </div>
      )}
    </div>
  );
}
