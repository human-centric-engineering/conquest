'use client';

/**
 * Create / edit form for one experience step.
 *
 * One component, two modes (`step` present → edit). Mirrors `<CohortForm>`: `react-hook-form` +
 * Zod (`mode: 'onTouched'`), `apiClient` for the submit, `<FormError>` per field, `<FieldHelp>` ⓘ
 * on the non-obvious fields.
 *
 * The step-kind options are filtered by experience kind — a switcher has no breakouts and a
 * facilitated meeting has no branch candidates. Offering an inapplicable kind would let an author
 * build a journey whose runtime silently ignores half of it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { FormError } from '@/components/forms/form-error';
import type { QuestionnaireOption } from '@/components/admin/experiences/experience-steps-panel';
import type { ExperienceStepView } from '@/lib/app/questionnaire/experiences/views';
import {
  EXPERIENCE_STEP_KIND_LABELS,
  EXPERIENCE_STEP_PURPOSE_MAX_LENGTH,
  EXPERIENCE_STEP_SELECTION_CRITERIA_MAX_LENGTH,
  EXPERIENCE_STEP_TITLE_MAX_LENGTH,
  type ExperienceKind,
  type ExperienceStepKind,
} from '@/lib/app/questionnaire/experiences/types';

/** Sentinel for "no questionnaire yet" — Radix Select cannot hold an empty-string item value. */
const NONE = 'none';

const formSchema = z.object({
  kind: z.enum(['entry', 'branch', 'breakout', 'report']),
  title: z.string().trim().min(1, 'Title is required').max(EXPERIENCE_STEP_TITLE_MAX_LENGTH),
  questionnaireId: z.string(),
  purpose: z.string().trim().max(EXPERIENCE_STEP_PURPOSE_MAX_LENGTH),
  selectionCriteria: z.string().trim().max(EXPERIENCE_STEP_SELECTION_CRITERIA_MAX_LENGTH),
});

type FormValues = z.infer<typeof formSchema>;

/** The step kinds that make sense for each experience kind. */
function kindsFor(experienceKind: ExperienceKind): readonly ExperienceStepKind[] {
  return experienceKind === 'agentic_switcher'
    ? ['entry', 'branch', 'report']
    : ['entry', 'breakout', 'report'];
}

export interface ExperienceStepFormProps {
  experienceId: string;
  experienceKind: ExperienceKind;
  questionnaireOptions: QuestionnaireOption[];
  /** Present in edit mode; absent in create mode. */
  step?: ExperienceStepView;
  /** Whether another step already claims `entry` — drives the duplicate-entry warning. */
  hasEntry: boolean;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function ExperienceStepForm({
  experienceId,
  experienceKind,
  questionnaireOptions,
  step,
  hasEntry,
  onSuccess,
  onCancel,
}: ExperienceStepFormProps) {
  const router = useRouter();
  const isEdit = step !== undefined;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = kindsFor(experienceKind);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: {
      // Default a new step to `entry` only while the journey has none — after that, the common
      // next action is adding a candidate, not a second entry.
      kind: step?.kind ?? (hasEntry ? (available[1] ?? 'branch') : 'entry'),
      title: step?.title ?? '',
      questionnaireId: step?.questionnaireId ?? NONE,
      purpose: step?.purpose ?? '',
      selectionCriteria: step?.selectionCriteria ?? '',
    },
  });

  const kind = watch('kind');

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setError(null);
    try {
      const body = {
        kind: values.kind,
        title: values.title,
        questionnaireId: values.questionnaireId === NONE ? null : values.questionnaireId,
        purpose: values.purpose.trim() === '' ? null : values.purpose.trim(),
        selectionCriteria:
          values.selectionCriteria.trim() === '' ? null : values.selectionCriteria.trim(),
      };

      if (isEdit) {
        await apiClient.patch(API.APP.EXPERIENCES.step(experienceId, step.id), { body });
      } else {
        await apiClient.post(API.APP.EXPERIENCES.steps(experienceId), { body });
      }
      router.refresh();
      onSuccess?.();
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Something went wrong saving the step.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="step-kind" className="flex items-center gap-1">
          Step kind
          <FieldHelp title="What this step does">
            <p>
              <strong>Entry</strong> — where every run begins. Exactly one per experience.
            </p>
            {experienceKind === 'agentic_switcher' ? (
              <p className="mt-2">
                <strong>Branch candidate</strong> — a follow-up the selector can route into, chosen
                against the criteria you write below.
              </p>
            ) : (
              <p className="mt-2">
                <strong>Breakout</strong> — a short questionnaire the whole room runs at once.
              </p>
            )}
            <p className="mt-2">
              <strong>Report</strong> — a terminal step that produces a synthesis instead of asking
              anything.
            </p>
          </FieldHelp>
        </Label>
        <Select
          value={kind}
          onValueChange={(v) => setValue('kind', v as FormValues['kind'], { shouldDirty: true })}
          disabled={isLoading}
        >
          <SelectTrigger id="step-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {available.map((option) => (
              <SelectItem key={option} value={option}>
                {EXPERIENCE_STEP_KIND_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {kind === 'entry' && hasEntry && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            This experience already has an entry step. Only one can begin a run — the extra will be
            flagged on the Overview tab.
          </p>
        )}
        <FormError message={errors.kind?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="step-title" className="flex items-center gap-1">
          Title
          <FieldHelp title="Step title">
            An internal name for this stage of the journey, e.g.{' '}
            <code className="text-xs">Deep dive: pricing</code>. Respondents never see it.
          </FieldHelp>
        </Label>
        <Input
          id="step-title"
          placeholder="Deep dive: pricing"
          disabled={isLoading}
          {...register('title')}
        />
        <FormError message={errors.title?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="step-questionnaire" className="flex items-center gap-1">
          Questionnaire
          <FieldHelp title="Which questionnaire this step runs">
            The questionnaire a respondent reaching this step will complete. Its newest launched
            version is resolved when the run reaches the step, so improving the questionnaire
            improves the journey without editing it here.
          </FieldHelp>
        </Label>
        <Select
          value={watch('questionnaireId')}
          onValueChange={(v) => setValue('questionnaireId', v, { shouldDirty: true })}
          disabled={isLoading}
        >
          <SelectTrigger id="step-questionnaire">
            <SelectValue placeholder="Choose a questionnaire…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None yet</SelectItem>
            {questionnaireOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.title}
                {option.status !== 'launched' && ` (${option.status})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FormError message={errors.questionnaireId?.message} />
      </div>

      {/* Selection criteria only drive a decision for branch candidates; showing the field on an
          entry or report step would imply an influence it does not have. */}
      {kind === 'branch' && (
        <div className="space-y-2">
          <Label htmlFor="step-criteria" className="flex items-center gap-1">
            Choose this step when…
            <FieldHelp title="Selection criteria">
              <p>
                Plain English, in your own words: what should be true about the conversation so far
                for this to be the right follow-up? This is the strongest signal the selector uses.
              </p>
              <p className="mt-2 italic">
                e.g. “The respondent described a team-coordination problem rather than a tooling
                one, and mentioned more than one department.”
              </p>
            </FieldHelp>
          </Label>
          <Textarea
            id="step-criteria"
            placeholder="The respondent described a coordination problem rather than a tooling one…"
            rows={3}
            disabled={isLoading}
            {...register('selectionCriteria')}
          />
          <FormError message={errors.selectionCriteria?.message} />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="step-purpose" className="flex items-center gap-1">
          Purpose
          <FieldHelp title="What this step is for">
            A short statement of what this stage is trying to learn. Shown to the selector as
            context alongside the criteria, and to you as a reminder of intent.
          </FieldHelp>
        </Label>
        <Textarea
          id="step-purpose"
          placeholder="Understand how the team currently coordinates across departments."
          rows={2}
          disabled={isLoading}
          {...register('purpose')}
        />
        <FormError message={errors.purpose?.message} />
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isLoading || (isEdit && !isDirty)}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit ? 'Save changes' : 'Add step'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" disabled={isLoading} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
