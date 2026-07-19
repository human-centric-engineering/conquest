'use client';

/**
 * Experience Settings tab — everything about a journey except its steps.
 *
 * One form covering identity, lifecycle, continuity, routing policy, budget, access and the
 * settings blob. Sections are gated by experience kind: routing policy is meaningless for a
 * facilitated meeting, and breakout synthesis is meaningless for a switcher, so each surface shows
 * only what it can act on.
 *
 * PATCHes only the fields that changed (react-hook-form's `dirtyFields`), so two admins editing
 * different sections do not clobber each other's work.
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
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { FormError } from '@/components/forms/form-error';
import type { ExperienceDetailView } from '@/lib/app/questionnaire/experiences/views';
import { ACCESS_MODE_LABELS, ACCESS_MODES } from '@/lib/app/questionnaire/types';
import {
  EXPERIENCE_COST_BUDGET_MAX_USD,
  EXPERIENCE_DESCRIPTION_MAX_LENGTH,
  EXPERIENCE_ROUTING_FALLBACK_LABELS,
  EXPERIENCE_ROUTING_FALLBACKS,
  EXPERIENCE_ROUTING_INSTRUCTIONS_MAX_LENGTH,
  EXPERIENCE_STATUSES,
  EXPERIENCE_SYNTHESIS_INSTRUCTIONS_MAX_LENGTH,
  EXPERIENCE_TITLE_MAX_LENGTH,
  INSIGHT_MIN_SUPPORT_CEILING,
  INSIGHT_MIN_SUPPORT_FLOOR,
  SYNTHESIS_EVERY_N_MAX,
  SYNTHESIS_EVERY_N_MIN,
} from '@/lib/app/questionnaire/experiences/types';

const formSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(EXPERIENCE_TITLE_MAX_LENGTH),
  description: z.string().trim().max(EXPERIENCE_DESCRIPTION_MAX_LENGTH),
  status: z.enum(EXPERIENCE_STATUSES),
  continuityMode: z.enum(['linked', 'stitched']),
  accessMode: z.enum(ACCESS_MODES),
  routingFallback: z.enum(EXPERIENCE_ROUTING_FALLBACKS),
  // Plain `z.number()` with `valueAsNumber` registration rather than `z.coerce.number()`:
  // coercion widens the schema's INPUT type to `unknown`, which no longer matches the resolver's
  // form-values generic. An empty input yields NaN, which fails the type check with this message.
  minRoutingConfidence: z.number({ message: 'Enter a number between 0 and 1' }).min(0).max(1),
  routingInstructions: z.string().trim().max(EXPERIENCE_ROUTING_INSTRUCTIONS_MAX_LENGTH),
  // Empty string means "uncapped" — a text input cannot express null, so the submit folds it.
  costBudgetUsd: z
    .string()
    .refine(
      (v) => v.trim() === '' || (Number(v) > 0 && Number(v) <= EXPERIENCE_COST_BUDGET_MAX_USD),
      `Enter an amount between 0 and ${EXPERIENCE_COST_BUDGET_MAX_USD}, or leave blank for uncapped`
    ),
  summariseCarryOver: z.boolean(),
  carryProfile: z.boolean(),
  showRoutingRationale: z.boolean(),
  synthesisEveryNCompletions: z
    .number({ message: 'Enter a whole number' })
    .int()
    .min(SYNTHESIS_EVERY_N_MIN)
    .max(SYNTHESIS_EVERY_N_MAX),
  insightMinSupport: z
    .number({ message: 'Enter a whole number' })
    .int()
    .min(INSIGHT_MIN_SUPPORT_FLOOR)
    .max(INSIGHT_MIN_SUPPORT_CEILING),
  surfaceInsightsToRespondents: z.boolean(),
  synthesisInstructions: z.string().trim().max(EXPERIENCE_SYNTHESIS_INSTRUCTIONS_MAX_LENGTH),
});

type FormValues = z.infer<typeof formSchema>;

/** Which form keys live inside the `settings` blob rather than as columns. */
const SETTINGS_KEYS = [
  'summariseCarryOver',
  'carryProfile',
  'showRoutingRationale',
  'synthesisEveryNCompletions',
  'insightMinSupport',
  'surfaceInsightsToRespondents',
  'synthesisInstructions',
] as const satisfies readonly (keyof FormValues)[];

type SettingsKey = (typeof SETTINGS_KEYS)[number];

function isSettingsKey(key: string): key is SettingsKey {
  return (SETTINGS_KEYS as readonly string[]).includes(key);
}

export function ExperienceSettingsPanel({ experience }: { experience: ExperienceDetailView }) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isSwitcher = experience.kind === 'agentic_switcher';

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isDirty, dirtyFields },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: {
      title: experience.title,
      description: experience.description ?? '',
      status: experience.status,
      // `merged` is not implemented; a row somehow carrying it edits as `linked` rather than
      // offering an option that would silently behave as something else.
      continuityMode: experience.continuityMode === 'stitched' ? 'stitched' : 'linked',
      accessMode: experience.accessMode,
      routingFallback: experience.routingFallback,
      minRoutingConfidence: experience.minRoutingConfidence,
      routingInstructions: experience.routingInstructions ?? '',
      costBudgetUsd: experience.costBudgetUsd?.toString() ?? '',
      ...experience.settings,
    },
  });

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setError(null);
    setSaved(false);
    try {
      // Send only what changed. A full-object PATCH would let a stale tab overwrite another
      // admin's edit to a field this form never touched.
      const columns: Record<string, unknown> = {};
      const settings: Record<string, unknown> = {};

      for (const key of Object.keys(dirtyFields) as (keyof FormValues)[]) {
        const value = values[key];
        if (isSettingsKey(key)) {
          settings[key] = value;
        } else if (key === 'costBudgetUsd') {
          const raw = values.costBudgetUsd.trim();
          columns.costBudgetUsd = raw === '' ? null : Number(raw);
        } else if (key === 'description' || key === 'routingInstructions') {
          const text = String(value).trim();
          columns[key] = text === '' ? null : text;
        } else {
          columns[key] = value;
        }
      }

      await apiClient.patch(API.APP.EXPERIENCES.byId(experience.id), {
        body: {
          ...columns,
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
        },
      });

      // Reset to the just-submitted values so the form is clean again without a refetch.
      reset(values);
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Something went wrong saving these settings.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="max-w-2xl space-y-8">
      <section className="space-y-5">
        <h2 className="text-lg font-medium">Identity</h2>

        <div className="space-y-2">
          <Label htmlFor="settings-title">Title</Label>
          <Input id="settings-title" disabled={isLoading} {...register('title')} />
          <FormError message={errors.title?.message} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="settings-description" className="flex items-center gap-1">
            Description
            <FieldHelp title="Internal note">
              A private admin note about what this journey is for. Never shown to respondents.
            </FieldHelp>
          </Label>
          <Textarea
            id="settings-description"
            rows={3}
            disabled={isLoading}
            {...register('description')}
          />
          <FormError message={errors.description?.message} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="settings-status" className="flex items-center gap-1">
            Status
            <FieldHelp title="Lifecycle">
              <p>
                <strong>Draft</strong> — still being authored; not reachable by respondents.
              </p>
              <p className="mt-2">
                <strong>Launched</strong> — live and accepting runs.
              </p>
              <p className="mt-2">
                <strong>Archived</strong> — retired, but its runs and reports are preserved.
              </p>
            </FieldHelp>
          </Label>
          <Select
            value={watch('status')}
            onValueChange={(v) =>
              setValue('status', v as FormValues['status'], { shouldDirty: true })
            }
            disabled={isLoading}
          >
            <SelectTrigger id="settings-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPERIENCE_STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormError message={errors.status?.message} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="settings-access" className="flex items-center gap-1">
            Who can start a run
            <FieldHelp title="Access">
              Governs who may begin this journey. Each questionnaire inside it still applies its own
              access rules once reached.
            </FieldHelp>
          </Label>
          <Select
            value={watch('accessMode')}
            onValueChange={(v) =>
              setValue('accessMode', v as FormValues['accessMode'], { shouldDirty: true })
            }
            disabled={isLoading}
          >
            <SelectTrigger id="settings-access">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCESS_MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {ACCESS_MODE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormError message={errors.accessMode?.message} />
        </div>
      </section>

      {isSwitcher && (
        <section className="space-y-5">
          <h2 className="text-lg font-medium">Routing</h2>

          <div className="space-y-2">
            <Label htmlFor="settings-continuity" className="flex items-center gap-1">
              How it should feel
              <FieldHelp title="Continuity between questionnaires">
                <p>
                  <strong>Separate conversations</strong> — the respondent finishes one chat and
                  starts the follow-up deliberately.
                </p>
                <p className="mt-2">
                  <strong>One continuous conversation</strong> — the follow-up continues in the same
                  chat with the earlier exchange visible above it, and nothing is asked twice.
                </p>
                <p className="text-muted-foreground mt-2">
                  Safe to change at any time, including mid-flight: the stored data is identical
                  either way.
                </p>
              </FieldHelp>
            </Label>
            <Select
              value={watch('continuityMode')}
              onValueChange={(v) =>
                setValue('continuityMode', v as FormValues['continuityMode'], { shouldDirty: true })
              }
              disabled={isLoading}
            >
              <SelectTrigger id="settings-continuity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="linked">Separate conversations</SelectItem>
                <SelectItem value="stitched">One continuous conversation</SelectItem>
              </SelectContent>
            </Select>
            <FormError message={errors.continuityMode?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-instructions" className="flex items-center gap-1">
              Guidance for the selector
              <FieldHelp title="Routing instructions">
                <p>
                  Anything the selector should weigh beyond each step&apos;s own criteria — house
                  preferences, ordering rules, things to avoid.
                </p>
                <p className="mt-2 italic">
                  e.g. “Prefer the shorter follow-up unless the respondent has clearly asked for
                  depth.”
                </p>
              </FieldHelp>
            </Label>
            <Textarea
              id="settings-instructions"
              rows={4}
              placeholder="Prefer the shorter follow-up unless the respondent has clearly asked for depth."
              disabled={isLoading}
              {...register('routingInstructions')}
            />
            <FormError message={errors.routingInstructions?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-fallback" className="flex items-center gap-1">
              If the selector is unsure
              <FieldHelp title="Fallback">
                <p>
                  What happens when the selector fails, names a step that does not exist, or is less
                  confident than the threshold below.
                </p>
                <p className="mt-2">
                  <strong>Conclude with a report</strong> is the recommended choice: finishing with
                  what was gathered is honest, whereas sending someone into a long follow-up on a
                  coin-flip is not.
                </p>
              </FieldHelp>
            </Label>
            <Select
              value={watch('routingFallback')}
              onValueChange={(v) =>
                setValue('routingFallback', v as FormValues['routingFallback'], {
                  shouldDirty: true,
                })
              }
              disabled={isLoading}
            >
              <SelectTrigger id="settings-fallback">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPERIENCE_ROUTING_FALLBACKS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {EXPERIENCE_ROUTING_FALLBACK_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormError message={errors.routingFallback?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-confidence" className="flex items-center gap-1">
              Confidence threshold
              <FieldHelp title="Confidence threshold">
                Below this, the selector&apos;s answer is discarded and the fallback applies. 0.6 is
                a sensible default; raise it if you would rather conclude than route imperfectly.
              </FieldHelp>
            </Label>
            <Input
              id="settings-confidence"
              type="number"
              step="0.05"
              min={0}
              max={1}
              className="max-w-[140px]"
              disabled={isLoading}
              {...register('minRoutingConfidence', { valueAsNumber: true })}
            />
            <FormError message={errors.minRoutingConfidence?.message} />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="settings-rationale" className="flex items-center gap-1">
                Tell the respondent why
                <FieldHelp title="Show routing rationale">
                  When on, the handoff explains in a sentence why this follow-up was chosen. When
                  off, the respondent simply continues.
                </FieldHelp>
              </Label>
            </div>
            <Switch
              id="settings-rationale"
              checked={watch('showRoutingRationale')}
              onCheckedChange={(v) => setValue('showRoutingRationale', v, { shouldDirty: true })}
              disabled={isLoading}
            />
          </div>
        </section>
      )}

      <section className="space-y-5">
        <h2 className="text-lg font-medium">
          {isSwitcher ? 'What carries between questionnaires' : 'Context'}
        </h2>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="settings-summarise" className="flex items-center gap-1">
              Summarise before handing over
              <FieldHelp title="Carry-over summary">
                <p>
                  On: an AI pass compresses what was learnt into a short briefing for the next
                  questionnaire, and writes the opening line that bridges the two.
                </p>
                <p className="mt-2">
                  Off: the next questionnaire receives the structured answers alone — cheaper and
                  entirely predictable, but the handover reads flatter.
                </p>
              </FieldHelp>
            </Label>
          </div>
          <Switch
            id="settings-summarise"
            checked={watch('summariseCarryOver')}
            onCheckedChange={(v) => setValue('summariseCarryOver', v, { shouldDirty: true })}
            disabled={isLoading}
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="settings-profile" className="flex items-center gap-1">
              Carry the respondent&apos;s details
              <FieldHelp title="Carry profile">
                Pass details captured earlier (name, role, whatever the first questionnaire asked)
                into later ones, so nobody is asked the same thing twice. Anonymous questionnaires
                collect no details to carry, and are unaffected by this.
              </FieldHelp>
            </Label>
          </div>
          <Switch
            id="settings-profile"
            checked={watch('carryProfile')}
            onCheckedChange={(v) => setValue('carryProfile', v, { shouldDirty: true })}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="settings-budget" className="flex items-center gap-1">
            Run budget (USD)
            <FieldHelp title="Run budget">
              <p>
                A ceiling on the AI cost of one respondent&apos;s whole journey, across every
                questionnaire in it. A run that reaches the cap concludes with a report rather than
                continuing.
              </p>
              <p className="text-muted-foreground mt-2">
                Distinct from a questionnaire&apos;s own budget, which applies per conversation and
                would otherwise multiply across a multi-part journey.
              </p>
            </FieldHelp>
          </Label>
          <Input
            id="settings-budget"
            inputMode="decimal"
            placeholder="Uncapped"
            className="max-w-[160px]"
            disabled={isLoading}
            {...register('costBudgetUsd')}
          />
          <FormError message={errors.costBudgetUsd?.message} />
        </div>
      </section>

      {!isSwitcher && (
        <section className="space-y-5">
          <h2 className="text-lg font-medium">Breakout synthesis</h2>

          <div className="space-y-2">
            <Label htmlFor="settings-cadence" className="flex items-center gap-1">
              Re-synthesise every N completions
              <FieldHelp title="Synthesis cadence">
                How often a breakout&apos;s insights are rebuilt as people finish. Lower feels more
                live and costs more; 3 keeps a room of eight feeling current without re-running on
                every submission.
              </FieldHelp>
            </Label>
            <Input
              id="settings-cadence"
              type="number"
              min={SYNTHESIS_EVERY_N_MIN}
              max={SYNTHESIS_EVERY_N_MAX}
              className="max-w-[140px]"
              disabled={isLoading}
              {...register('synthesisEveryNCompletions', { valueAsNumber: true })}
            />
            <FormError message={errors.synthesisEveryNCompletions?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-support" className="flex items-center gap-1">
              Minimum people behind an insight
              <FieldHelp title="Minimum support">
                <p>
                  An insight supported by fewer people than this is suppressed, so no individual can
                  be identified from it.
                </p>
                <p className="mt-2">
                  Three is the floor for a reason: with two, a “tension between two of you” usually
                  tells both people exactly who said what.
                </p>
              </FieldHelp>
            </Label>
            <Input
              id="settings-support"
              type="number"
              min={INSIGHT_MIN_SUPPORT_FLOOR}
              max={INSIGHT_MIN_SUPPORT_CEILING}
              className="max-w-[140px]"
              disabled={isLoading}
              {...register('insightMinSupport', { valueAsNumber: true })}
            />
            <FormError message={errors.insightMinSupport?.message} />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="settings-surface" className="flex items-center gap-1">
                Show insights to respondents
                <FieldHelp title="Respondent visibility">
                  When on, newly generated insights are visible to participants as well as the
                  facilitator. You can still override this per insight during a session.
                </FieldHelp>
              </Label>
            </div>
            <Switch
              id="settings-surface"
              checked={watch('surfaceInsightsToRespondents')}
              onCheckedChange={(v) =>
                setValue('surfaceInsightsToRespondents', v, { shouldDirty: true })
              }
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-synth-instructions" className="flex items-center gap-1">
              Guidance for synthesis
              <FieldHelp title="Synthesis instructions">
                What this room cares about surfacing. e.g. “Prioritise disagreements about
                priorities over disagreements about wording.”
              </FieldHelp>
            </Label>
            <Textarea
              id="settings-synth-instructions"
              rows={3}
              disabled={isLoading}
              {...register('synthesisInstructions')}
            />
            <FormError message={errors.synthesisInstructions?.message} />
          </div>
        </section>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      <div className="flex items-center gap-3 border-t pt-4">
        <Button type="submit" disabled={isLoading || !isDirty}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save changes
        </Button>
        {saved && !isDirty && <span className="text-muted-foreground text-sm">Saved.</span>}
      </div>
    </form>
  );
}
