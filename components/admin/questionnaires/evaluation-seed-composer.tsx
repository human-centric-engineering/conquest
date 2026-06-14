'use client';

/**
 * EvaluationSeedComposer (F5.3) — the "Open in editor" refine path for a suggested new question.
 *
 * When the review queue deep-links `…/structure?edit=1&seedFinding=<runId>:<findingId>`, the
 * structure page resolves the `add_question` draft into an {@link EvaluationSeed} and renders this
 * highlighted composer at the top of the editor, pre-filled with the judge's prompt / type /
 * section / guidelines. The admin tweaks and clicks "Add to questionnaire": the question is created
 * through the normal authoring route (forking a launched version like any edit), the finding is
 * stamped `applied` (so the queue reflects it), and the editor navigates to the — possibly
 * forked — draft with the seed cleared. "Discard" just drops the deep-link.
 *
 * This is the deliberate counterpart to the queue's one-click "Add to questionnaire": same outcome,
 * but with a review step for when the drafted wording (or choice options) needs work first.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  type QuestionType,
} from '@/lib/app/questionnaire/types';
import { defaultTypeConfig } from '@/lib/app/questionnaire/authoring';
import { Checkbox } from '@/components/ui/checkbox';
import { authoringMutate } from '@/components/admin/questionnaires/authoring-mutate';
import type { EvaluationSeed } from '@/components/admin/questionnaires/version-editor-types';

export function EvaluationSeedComposer({
  questionnaireId,
  versionId,
  sections,
  seed,
  hasDataSlots = false,
}: {
  questionnaireId: string;
  versionId: string;
  /** The version's sections (id + title) for the target picker. */
  sections: { id: string; title: string }[];
  seed: EvaluationSeed;
  /** When the version already has data slots, offer to slot the new question (pre-ticked). */
  hasDataSlots?: boolean;
}) {
  const router = useRouter();
  const structureBase = `/admin/questionnaires/${questionnaireId}/v/${versionId}/structure`;

  const [prompt, setPrompt] = useState(seed.prompt);
  const [type, setType] = useState<QuestionType>(seed.type);
  const [sectionId, setSectionId] = useState(
    sections.find((s) => s.title === seed.sectionKey)?.id ?? sections[0]?.id ?? ''
  );
  const [guidelines, setGuidelines] = useState(seed.guidelines ?? '');
  const [addToDataSlots, setAddToDataSlots] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canAdd = prompt.trim().length > 0 && sectionId !== '' && !busy;

  function discard() {
    router.replace(`${structureBase}?edit=1`, { scroll: false });
  }

  async function add() {
    if (!canAdd) return;
    setBusy(true);
    setError(null);
    try {
      const { data, meta } = await authoringMutate<{ key: string }>(
        'POST',
        API.APP.QUESTIONNAIRES.versionSectionQuestions(questionnaireId, versionId, sectionId),
        {
          prompt: prompt.trim(),
          type,
          typeConfig: defaultTypeConfig(type),
          weight: 0.5,
          ...(guidelines.trim() ? { guidelines: guidelines.trim() } : {}),
        }
      );
      // Editing a launched version forks it — the question (and the applied finding) land on the
      // new draft, which is where we then navigate.
      const resultVersionId = meta?.forked ? meta.versionId : versionId;

      // Slot the new question (into an existing data slot, or a new one) when asked. Best-effort:
      // the question is already created, so a slot-assignment failure must not block the admin.
      if (hasDataSlots && addToDataSlots && data?.key) {
        try {
          await fetch(
            API.APP.QUESTIONNAIRES.versionDataSlotsAssign(questionnaireId, resultVersionId),
            {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ questionKeys: [data.key] }),
            }
          );
        } catch {
          // swallow — the question was added; slotting is a best-effort follow-up.
        }
      }

      // Record the finding applied. Best-effort: the question is already created, so a failure here
      // must not block the admin — it only affects the queue's badge.
      try {
        await fetch(
          API.APP.QUESTIONNAIRES.versionEvaluationFinding(
            questionnaireId,
            versionId,
            seed.runId,
            seed.findingId
          ),
          {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'mark_applied', appliedToVersionId: resultVersionId }),
          }
        );
      } catch {
        // swallow — the structural change succeeded; the finding badge is non-critical.
      }

      router.replace(
        `/admin/questionnaires/${questionnaireId}/v/${resultVersionId}/structure?edit=1`,
        {
          scroll: false,
        }
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the question');
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-amber-400 bg-amber-50/60 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-400/30 text-amber-700 dark:text-amber-300">
          <Sparkles className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-semibold tracking-tight">Add a suggested question</p>
          <p className="text-muted-foreground text-xs">
            From a design-evaluation finding — review and add it, or discard.
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-3">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="seed-prompt">
            Question prompt
          </Label>
          <Textarea
            id="seed-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            disabled={busy}
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="space-y-1">
            <Label className="text-xs">
              Answer type{' '}
              <FieldHelp title="Answer type">
                <p>
                  Choice and scale types are added with default options you can refine in the row
                  below after adding.
                </p>
              </FieldHelp>
            </Label>
            <Select value={type} onValueChange={(v) => setType(v as QuestionType)} disabled={busy}>
              <SelectTrigger className="h-8 w-48 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUESTION_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {QUESTION_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Section</Label>
            <Select value={sectionId} onValueChange={setSectionId} disabled={busy}>
              <SelectTrigger className="h-8 w-56 text-xs">
                <SelectValue placeholder="Choose a section" />
              </SelectTrigger>
              <SelectContent>
                {sections.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs" htmlFor="seed-guidelines">
            Author guidelines (optional)
          </Label>
          <Textarea
            id="seed-guidelines"
            value={guidelines}
            onChange={(e) => setGuidelines(e.target.value)}
            rows={2}
            disabled={busy}
          />
        </div>

        {sections.length === 0 && (
          <p className="text-xs text-amber-800 dark:text-amber-300">
            This version has no sections yet — add a section below first, then re-open this
            suggestion.
          </p>
        )}
        {hasDataSlots && (
          <label
            htmlFor="seed-add-data-slots"
            className="text-muted-foreground flex items-center gap-2 text-xs"
          >
            <Checkbox
              id="seed-add-data-slots"
              checked={addToDataSlots}
              onCheckedChange={setAddToDataSlots}
              disabled={busy}
            />
            Add to a data slot (create one if needed)
          </label>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex gap-2">
          <Button size="sm" disabled={!canAdd} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add to questionnaire'}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>
            Discard
          </Button>
        </div>
      </div>
    </div>
  );
}
