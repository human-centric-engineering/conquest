'use client';

/**
 * QuestionEditor (F2.1 / PR2) — one editable, drag-sortable question row.
 *
 * Inline edits each map to one granular PATCH on `…/questions/:id`: prompt (on
 * blur), type (reset to the new type's default config so the change always
 * validates), required, the per-type config (choices / bounds), a move-to-section
 * select, and delete. All writes go through the parent's `run` runner, which
 * handles the fork notice + refetch.
 *
 * The per-type config sub-editors hold local draft state and **pre-validate with
 * the shared `validateTypeConfig`** before saving — so a half-finished edit
 * (one likert bound, a blank choice label) never fires a doomed 400, and the
 * draft re-syncs from props after a server refetch.
 */

import { useEffect, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Scale, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  type QuestionType,
} from '@/lib/app/questionnaire/types';
import { defaultTypeConfig, validateTypeConfig } from '@/lib/app/questionnaire/authoring';
import type { QuestionSlotView, SectionView, TagView } from '@/lib/app/questionnaire/views';

import { QuestionTagsEditor } from '@/components/admin/questionnaires/question-tags-editor';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

interface Choice {
  value: string;
  label: string;
}

function asRecord(config: unknown): Record<string, unknown> {
  return config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
}

function asChoices(config: unknown): Choice[] {
  const choices = asRecord(config).choices;
  return Array.isArray(choices) ? (choices as Choice[]) : [];
}

function asBounds(config: unknown): { min?: number; max?: number } {
  const r = asRecord(config);
  return { min: r.min as number | undefined, max: r.max as number | undefined };
}

export function QuestionEditor({
  questionnaireId,
  versionId,
  sections,
  question,
  tags,
  run,
  busy,
}: {
  questionnaireId: string;
  versionId: string;
  sections: SectionView[];
  question: QuestionSlotView;
  tags: TagView[];
  run: RunMutation;
  busy: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: question.id,
  });
  const [prompt, setPrompt] = useState(question.prompt);
  useEffect(() => setPrompt(question.prompt), [question.prompt]);

  const path = API.APP.QUESTIONNAIRES.versionQuestionById(questionnaireId, versionId, question.id);

  const patch = (body: Record<string, unknown>) => run(() => ['PATCH', path, body]);

  const savePrompt = () => {
    if (prompt.trim() && prompt !== question.prompt) patch({ prompt });
  };

  const changeType = (type: QuestionType) => {
    if (type === question.type) return;
    patch({ type, typeConfig: defaultTypeConfig(type) });
  };

  // Preserve any sibling config keys (e.g. `allowOther` on choices) when saving.
  const saveTypeConfig = (config: unknown) => patch({ typeConfig: config });

  const currentSectionId = sections.find((s) => s.questions.some((q) => q.id === question.id))?.id;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group bg-card relative rounded-lg border p-3 transition-shadow hover:border-[var(--cq-accent-ring)] hover:shadow-sm ${
        isDragging ? 'opacity-60 shadow-md' : ''
      }`}
    >
      {/* Connector tick onto the section spine. */}
      <span className="absolute top-6 -left-4 h-px w-4 bg-[var(--cq-accent-muted)]" aria-hidden />
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="text-muted-foreground/50 hover:text-foreground mt-1.5 cursor-grab"
          aria-label="Drag to reorder question"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1 space-y-2.5">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={savePrompt}
            rows={2}
            disabled={busy}
            aria-label="Question prompt"
            className="resize-none border-transparent bg-transparent text-sm font-medium shadow-none focus-visible:border-[var(--color-input)] focus-visible:bg-[var(--color-background)]"
          />

          {/* Meta row — grouped, labelled controls so each affordance is self-explanatory. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Type
              </span>
              <Select value={question.type} onValueChange={(v) => changeType(v as QuestionType)}>
                <SelectTrigger className="h-8 w-36 text-xs" aria-label="Question type">
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

            <div className="flex items-center gap-1.5">
              <Switch
                id={`required-${question.id}`}
                checked={question.required}
                onCheckedChange={(checked) => patch({ required: checked })}
                disabled={busy}
              />
              <Label htmlFor={`required-${question.id}`} className="text-xs">
                Required
              </Label>
            </div>

            <WeightControl
              weight={question.weight}
              busy={busy}
              onSave={(w) => patch({ weight: w })}
            />

            {sections.length > 1 && (
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                  Section
                </span>
                <Select
                  value={currentSectionId}
                  onValueChange={(sectionId) => patch({ sectionId })}
                >
                  <SelectTrigger className="h-8 w-40 text-xs" aria-label="Move to section">
                    <SelectValue placeholder="Move to section…" />
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
            )}

            <span
              className="text-muted-foreground/70 ml-auto font-mono text-xs"
              title="Stable question key (used by exports & the API)"
            >
              {question.key}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 opacity-60 group-hover:opacity-100"
              disabled={busy}
              aria-label="Delete question"
              onClick={() => run(() => ['DELETE', path, undefined])}
            >
              <Trash2 className="text-destructive h-4 w-4" />
            </Button>
          </div>

          {/* Per-type config */}
          {(question.type === 'single_choice' || question.type === 'multi_choice') && (
            <ChoicesEditor
              type={question.type}
              config={question.typeConfig}
              busy={busy}
              onSave={saveTypeConfig}
            />
          )}
          {(question.type === 'likert' || question.type === 'numeric') && (
            <BoundsEditor
              type={question.type}
              config={question.typeConfig}
              busy={busy}
              onSave={saveTypeConfig}
            />
          )}

          {/* Tag assignment */}
          <QuestionTagsEditor
            questionnaireId={questionnaireId}
            versionId={versionId}
            question={question}
            tags={tags}
            run={run}
            busy={busy}
          />
        </div>
      </div>
    </li>
  );
}

/** The question-weight slider's bounds — the lightest/heaviest a question can be. */
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 1;
const WEIGHT_STEP = 0.1;
const WEIGHT_DEFAULT = 0.5;

/** Clamp + round a stored weight onto the slider's 0.1–1.0 grid (out-of-range data clamps in). */
function clampWeight(weight: number): number {
  if (!Number.isFinite(weight)) return WEIGHT_DEFAULT;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, Math.round(weight * 10) / 10));
}

/**
 * Per-question weight (F2.1) — the only place the admin can see or set it. Drives the
 * **weighted** selection strategy's pick score and the coverage/completion ratio; inert
 * under the other strategies. A bounded slider (0.1 lightest → 1.0 heaviest, 0.1 steps)
 * so the value is easy to set and can't drift out of range; it commits on release
 * (`onValueCommit`) — one PATCH per adjustment, not one per pixel. Unrelated to tags.
 */
function WeightControl({
  weight,
  busy,
  onSave,
}: {
  weight: number;
  busy: boolean;
  onSave: (weight: number) => void;
}) {
  const [val, setVal] = useState(() => clampWeight(weight));
  useEffect(() => setVal(clampWeight(weight)), [weight]);

  const commit = (next: number) => {
    const w = clampWeight(next);
    setVal(w);
    if (w !== clampWeight(weight)) onSave(w);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground flex items-center gap-1 text-[11px] font-medium tracking-wide uppercase">
        <Scale className="h-3.5 w-3.5" />
        Weight
      </span>
      <Slider
        value={[val]}
        min={WEIGHT_MIN}
        max={WEIGHT_MAX}
        step={WEIGHT_STEP}
        disabled={busy}
        onValueChange={(v) => setVal(v[0] ?? val)}
        onValueCommit={(v) => commit(v[0] ?? val)}
        className="w-24"
        aria-label="Question weight"
      />
      <span className="text-foreground w-6 font-mono text-xs tabular-nums">{val.toFixed(1)}</span>
      <FieldHelp title="Question weight">
        Drag to set how strongly the <strong>weighted</strong> question-picker favours this
        question, and how much it counts toward completion. Scale <code>0.1</code> (lightest) →{' '}
        <code>1.0</code> (heaviest); new questions start at <code>0.5</code>. Only affects versions
        whose <em>Settings → question selection</em> is set to <strong>Weighted</strong> (other
        strategies ignore it). Not related to tags.
      </FieldHelp>
    </div>
  );
}

/**
 * Choice list editor. Holds a local `draft`, re-syncs from props on a server
 * change, preserves the sibling `allowOther` flag, and only saves a valid
 * config (≥2 distinct values, non-empty labels) — so a blank in-progress row
 * never trips the server's choice validation.
 */
function ChoicesEditor({
  type,
  config,
  busy,
  onSave,
}: {
  type: QuestionType;
  config: unknown;
  busy: boolean;
  onSave: (config: unknown) => void;
}) {
  const choices = asChoices(config);
  const allowOther = asRecord(config).allowOther;
  const [draft, setDraft] = useState<Choice[]>(choices);

  // Re-sync the draft when the server config changes (after a refetch).
  useEffect(() => setDraft(asChoices(config)), [config]);

  const save = (next: Choice[]) => {
    const candidate = { choices: next, ...(allowOther !== undefined ? { allowOther } : {}) };
    if (validateTypeConfig(type, candidate).ok) onSave(candidate);
  };

  return (
    <div className="bg-muted/40 space-y-2 rounded-md p-2">
      {draft.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={c.label}
            placeholder="Label"
            className="h-7 text-xs"
            disabled={busy}
            onChange={(e) =>
              setDraft(draft.map((d, j) => (j === i ? { ...d, label: e.target.value } : d)))
            }
            onBlur={() => save(draft)}
          />
          <Input
            value={c.value}
            placeholder="value"
            className="h-7 w-32 font-mono text-xs"
            disabled={busy}
            onChange={(e) =>
              setDraft(draft.map((d, j) => (j === i ? { ...d, value: e.target.value } : d)))
            }
            onBlur={() => save(draft)}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled={busy || draft.length <= 2}
            aria-label="Remove choice"
            onClick={() => {
              const next = draft.filter((_, j) => j !== i);
              setDraft(next);
              save(next);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={busy}
        onClick={() => setDraft([...draft, { value: `option_${draft.length + 1}`, label: '' }])}
      >
        Add choice
      </Button>
    </div>
  );
}

/**
 * Min/max bounds editor for likert/numeric. Holds both bounds as local state and
 * only saves when the resulting config is valid — so editing one bound to a
 * temporarily-out-of-order value (min above the old max) doesn't fire a doomed
 * 400; the user can set the two bounds in either order.
 */
function BoundsEditor({
  type,
  config,
  busy,
  onSave,
}: {
  type: QuestionType;
  config: unknown;
  busy: boolean;
  onSave: (config: unknown) => void;
}) {
  const bounds = asBounds(config);
  const toStr = (n: number | undefined) => (n === undefined ? '' : String(n));
  const [min, setMin] = useState(toStr(bounds.min));
  const [max, setMax] = useState(toStr(bounds.max));

  useEffect(() => {
    const b = asBounds(config);
    setMin(toStr(b.min));
    setMax(toStr(b.max));
  }, [config]);

  const save = () => {
    const next: Record<string, unknown> = { ...asRecord(config) };
    if (min === '') delete next.min;
    else next.min = Number(min);
    if (max === '') delete next.max;
    else next.max = Number(max);
    const result = validateTypeConfig(type, next);
    if (result.ok) onSave(result.value);
    // Invalid intermediate (e.g. min > max) → keep editing, no doomed request.
  };

  return (
    <div className="flex items-end gap-3">
      <div className="space-y-1">
        <Label className="text-xs">Min</Label>
        <Input
          type="number"
          value={min}
          className="h-7 w-20 text-xs"
          disabled={busy}
          onChange={(e) => setMin(e.target.value)}
          onBlur={save}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Max</Label>
        <Input
          type="number"
          value={max}
          className="h-7 w-20 text-xs"
          disabled={busy}
          onChange={(e) => setMax(e.target.value)}
          onBlur={save}
        />
      </div>
    </div>
  );
}
