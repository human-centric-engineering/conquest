'use client';

/**
 * Data-slots review surface (Data Slots feature).
 *
 * Shows the version's saved data slots, lets the admin GENERATE a proposed set from the
 * approved questions (one LLM call), review/edit/reject each proposed slot, and SAVE the
 * accepted set (a PUT that replaces the version's slots; forks a launched version first).
 * The conversation later targets these slots; each maps to one or more questions it captures.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { API } from '@/lib/api/endpoints';
import {
  authoringMutate,
  AuthoringError,
} from '@/components/admin/questionnaires/authoring-mutate';
import { StatusTicker, DATA_SLOT_MESSAGES } from '@/components/admin/questionnaires/status-ticker';
import type { DataSlotView, GeneratedDataSlot } from '@/lib/app/questionnaire/data-slots';

interface QuestionRef {
  key: string;
  prompt: string;
}

export interface DataSlotsReviewProps {
  questionnaireId: string;
  versionId: string;
  questions: QuestionRef[];
  initialSlots: DataSlotView[];
}

/** An editable proposed slot (generation output the admin tweaks before saving). */
interface DraftSlot {
  name: string;
  description: string;
  theme: string;
  questionKeys: string[];
  accepted: boolean;
}

function toDraft(slot: GeneratedDataSlot): DraftSlot {
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

export function DataSlotsReview({
  questionnaireId,
  versionId,
  questions,
  initialSlots,
}: DataSlotsReviewProps) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<DraftSlot[]>(initialSlots.map(fromSaved));
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const promptByKey = new Map(questions.map((q) => [q.key, q.prompt]));

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
        setDrafts(res.data.slots.map(toDraft));
        setNotice(`Generated ${res.data.slots.length} data slots — review and save.`);
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
        router.push(`/admin/questionnaires/${questionnaireId}/data-slots?v=${res.meta.versionId}`);
      }
      setNotice(`Saved ${res.data.slots.length} data slots.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof AuthoringError ? err.message : 'Could not save data slots.');
    } finally {
      setSaving(false);
    }
  };

  const coveredKeys = new Set(drafts.filter((d) => d.accepted).flatMap((d) => d.questionKeys));
  const uncovered = questions.filter((q) => !coveredKeys.has(q.key));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {drafts.length === 0
            ? 'No data slots yet. Generate a set from this version’s questions.'
            : `${drafts.length} data slot${drafts.length === 1 ? '' : 's'}.`}
        </p>
        <Button variant="outline" size="sm" onClick={() => void generate()} disabled={generating}>
          {generating ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-4 w-4" />
          )}
          {drafts.length === 0 ? 'Generate data slots' : 'Regenerate'}
        </Button>
      </div>

      {generating && <StatusTicker messages={DATA_SLOT_MESSAGES} />}
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
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Save accepted slots ({drafts.filter((d) => d.accepted).length})
          </Button>
          <Badge variant="outline">
            {coveredKeys.size}/{questions.length} questions covered
          </Badge>
        </div>
      )}
    </div>
  );
}
