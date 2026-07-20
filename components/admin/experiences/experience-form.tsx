'use client';

/**
 * Create form for an experience.
 *
 * Create-only by design: the workspace's Settings tab owns editing, so this form stays short
 * enough to complete in one pass — client, title, kind, and how the seam between questionnaires
 * should feel. Everything else has a sensible default and is tuned later, once there are steps to
 * tune it against.
 *
 * Mirrors `<CohortForm>`: `react-hook-form` + Zod (`mode: 'onTouched'`), `apiClient` for the
 * submit, `<FormError>` per field, `<FieldHelp>` ⓘ on every non-obvious field.
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
import { ExperienceExamplesCompact } from '@/components/admin/experiences/experience-examples';
import { FieldHelp } from '@/components/ui/field-help';
import { FormError } from '@/components/forms/form-error';
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';
import type { ExperienceListView } from '@/lib/app/questionnaire/experiences/views';
import {
  EXPERIENCE_DESCRIPTION_MAX_LENGTH,
  EXPERIENCE_KIND_DESCRIPTIONS,
  EXPERIENCE_KIND_LABELS,
  EXPERIENCE_KINDS,
  EXPERIENCE_TITLE_MAX_LENGTH,
} from '@/lib/app/questionnaire/experiences/types';
import { experienceWorkspaceBase } from '@/lib/app/questionnaire/experiences/workspace-nav';

// Local form schema: every field string-defaulted so react-hook-form stays controlled, folding
// empty → omitted at submit time. `merged` is deliberately absent from the continuity choices —
// it is not implemented yet, and offering an option that silently behaves as `linked` would be
// worse than not offering it.
const formSchema = z.object({
  demoClientId: z.string().min(1, 'Choose a demo client'),
  title: z.string().trim().min(1, 'Title is required').max(EXPERIENCE_TITLE_MAX_LENGTH),
  description: z.string().trim().max(EXPERIENCE_DESCRIPTION_MAX_LENGTH),
  kind: z.enum(EXPERIENCE_KINDS),
  continuityMode: z.enum(['linked', 'stitched']),
});

type FormValues = z.infer<typeof formSchema>;

export interface ExperienceFormProps {
  demoClientOptions: AttributedDemoClient[];
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function ExperienceForm({ demoClientOptions, onSuccess, onCancel }: ExperienceFormProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: {
      // Pre-select when there is exactly one client — with a single option the picker is a
      // formality, and making the author confirm it adds a click without adding a decision.
      demoClientId: demoClientOptions.length === 1 ? demoClientOptions[0].id : '',
      title: '',
      description: '',
      kind: 'agentic_switcher',
      continuityMode: 'linked',
    },
  });

  const kind = watch('kind');

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setError(null);
    try {
      const created = await apiClient.post<ExperienceListView>(API.APP.EXPERIENCES.ROOT, {
        body: {
          demoClientId: values.demoClientId,
          title: values.title,
          kind: values.kind,
          continuityMode: values.continuityMode,
          ...(values.description.trim() === '' ? {} : { description: values.description.trim() }),
        },
      });
      router.push(experienceWorkspaceBase(created.id));
      router.refresh();
      onSuccess?.();
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Something went wrong creating the experience.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="experience-client" className="flex items-center gap-1">
          Demo client
          <FieldHelp title="Demo client">
            Which client this experience belongs to. Scopes it alongside that client&apos;s
            questionnaires and cohorts, and supplies the branding respondents see.
          </FieldHelp>
        </Label>
        <Select
          value={watch('demoClientId')}
          onValueChange={(v) => setValue('demoClientId', v, { shouldValidate: true })}
          disabled={isLoading}
        >
          <SelectTrigger id="experience-client">
            <SelectValue placeholder="Choose a client…" />
          </SelectTrigger>
          <SelectContent>
            {demoClientOptions.map((client) => (
              <SelectItem key={client.id} value={client.id}>
                {client.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FormError message={errors.demoClientId?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="experience-title" className="flex items-center gap-1">
          Title
          <FieldHelp title="Experience title">
            A short internal name for the journey, e.g.{' '}
            <code className="text-xs">Leadership diagnostic</code>. Respondents never see it.
          </FieldHelp>
        </Label>
        <Input
          id="experience-title"
          placeholder="Leadership diagnostic"
          disabled={isLoading}
          {...register('title')}
        />
        <FormError message={errors.title?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="experience-kind" className="flex items-center gap-1">
          Kind
          <FieldHelp title="What kind of journey is this?">
            <p>
              <strong>Agentic switcher</strong> — an opening questionnaire, then an AI decision:
              conclude with a report, or continue into a follow-up chosen from your candidates based
              on what was learnt.
            </p>
            <p className="mt-2">
              <strong>Facilitated meeting</strong> — the same short questionnaire run by many people
              at once, synthesised per breakout so a facilitator can see where a team agrees and
              where it does not.
            </p>
            <p className="text-muted-foreground mt-2">
              This cannot be changed later — the two shapes have different steps and settings.
            </p>
          </FieldHelp>
        </Label>
        <Select
          value={kind}
          onValueChange={(v) => setValue('kind', v as FormValues['kind'], { shouldValidate: true })}
          disabled={isLoading}
        >
          <SelectTrigger id="experience-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPERIENCE_KINDS.map((option) => (
              <SelectItem key={option} value={option}>
                {EXPERIENCE_KIND_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-sm">{EXPERIENCE_KIND_DESCRIPTIONS[kind]}</p>
        <ExperienceExamplesCompact kind={kind} />
        <FormError message={errors.kind?.message} />
      </div>

      {/* Continuity only means something when a journey has more than one questionnaire, which a
          facilitated meeting does not — so the choice is hidden rather than shown-and-ignored. */}
      {kind === 'agentic_switcher' && (
        <div className="space-y-2">
          <Label htmlFor="experience-continuity" className="flex items-center gap-1">
            How it should feel
            <FieldHelp title="Continuity between questionnaires">
              <p>
                <strong>Separate conversations</strong> — the respondent finishes one chat, sees
                where they are going next, and starts the follow-up deliberately.
              </p>
              <p className="mt-2">
                <strong>One continuous conversation</strong> — the follow-up picks up in the same
                chat, with the earlier exchange still visible above it. The respondent is not asked
                for anything twice.
              </p>
              <p className="text-muted-foreground mt-2">
                Either can be changed at any time — the underlying data is identical.
              </p>
            </FieldHelp>
          </Label>
          <Select
            value={watch('continuityMode')}
            onValueChange={(v) =>
              setValue('continuityMode', v as FormValues['continuityMode'], {
                shouldValidate: true,
              })
            }
            disabled={isLoading}
          >
            <SelectTrigger id="experience-continuity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="linked">Separate conversations</SelectItem>
              <SelectItem value="stitched">One continuous conversation</SelectItem>
            </SelectContent>
          </Select>
          <FormError message={errors.continuityMode?.message} />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="experience-description" className="flex items-center gap-1">
          Description
          <FieldHelp title="Internal note">
            A private admin note about what this journey is for. Never shown to respondents.
          </FieldHelp>
        </Label>
        <Textarea
          id="experience-description"
          placeholder="Internal note (optional)"
          rows={3}
          disabled={isLoading}
          {...register('description')}
        />
        <FormError message={errors.description?.message} />
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isLoading}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create experience
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
