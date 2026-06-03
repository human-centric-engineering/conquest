'use client';

/**
 * DEMO-ONLY (F2.5.1): create / edit form for a demo client.
 *
 * One component, two modes. `react-hook-form` + Zod (`mode: 'onTouched'`),
 * `apiClient` for the submit, `<FormError>` per field, `<FieldHelp>` ⓘ on the
 * non-obvious fields. Slug is derive-with-override: leave it blank on create and
 * the server derives it from the name; a collision surfaces as a 409 banner.
 *
 * A real client engagement strips demo tenancy — see forking.md.
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
import { FieldHelp } from '@/components/ui/field-help';
import { FormError } from '@/components/forms/form-error';
import {
  DEMO_CLIENT_SLUG_MAX_LENGTH,
  DEMO_CLIENT_SLUG_PATTERN,
  type DemoClientView,
} from '@/lib/app/questionnaire/demo-clients';

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  slug: z
    .string()
    .trim()
    .max(DEMO_CLIENT_SLUG_MAX_LENGTH)
    .refine((v) => v === '' || DEMO_CLIENT_SLUG_PATTERN.test(v), {
      message: 'Kebab-case only: lowercase letters, numbers, single hyphens',
    }),
  description: z.string().trim().max(500),
  isActive: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

export interface DemoClientFormProps {
  /** Present in edit mode; absent in create mode. */
  client?: DemoClientView;
}

export function DemoClientForm({ client }: DemoClientFormProps) {
  const router = useRouter();
  const isEdit = client !== undefined;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: {
      name: client?.name ?? '',
      slug: client?.slug ?? '',
      description: client?.description ?? '',
      isActive: client?.isActive ?? true,
    },
  });

  const isActive = watch('isActive');

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setError(null);
    try {
      const body = {
        name: values.name,
        description: values.description.trim() === '' ? null : values.description.trim(),
        isActive: values.isActive,
        ...(values.slug.trim() === '' ? {} : { slug: values.slug.trim() }),
      };

      if (isEdit) {
        const updated = await apiClient.patch<DemoClientView>(
          API.APP.DEMO_CLIENTS.byId(client.id),
          {
            body,
          }
        );
        router.push(`/admin/demo-clients/${updated.id}`);
      } else {
        const created = await apiClient.post<DemoClientView>(API.APP.DEMO_CLIENTS.ROOT, { body });
        router.push(`/admin/demo-clients/${created.id}`);
      }
      router.refresh();
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Something went wrong saving the demo client.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="max-w-xl space-y-6">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" placeholder="Acme Bank Demo" disabled={isLoading} {...register('name')} />
        <FormError message={errors.name?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="slug" className="flex items-center gap-1">
          Slug
          <FieldHelp title="URL slug">
            URL-safe identifier used in admin URLs (and later invitation links), e.g.{' '}
            <code className="text-xs">acme-bank</code>. Leave blank to derive it from the name. Must
            be kebab-case and unique.
          </FieldHelp>
        </Label>
        <Input
          id="slug"
          placeholder={isEdit ? undefined : 'auto-derived from name if left blank'}
          disabled={isLoading}
          {...register('slug')}
        />
        <FormError message={errors.slug?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description" className="flex items-center gap-1">
          Description
          <FieldHelp title="Internal note">
            A private admin note about this demo (e.g. &ldquo;Prepared for the Q1 2026
            pitch&rdquo;). Never shown to end users.
          </FieldHelp>
        </Label>
        <Textarea
          id="description"
          placeholder="Internal note (optional)"
          rows={3}
          disabled={isLoading}
          {...register('description')}
        />
        <FormError message={errors.description?.message} />
      </div>

      <div className="flex items-center justify-between rounded-md border px-3 py-3">
        <div className="space-y-0.5">
          <Label htmlFor="isActive" className="flex items-center gap-1">
            Active
            <FieldHelp title="Active demo client">
              Inactive clients stay in the list but are hidden from the attribution picker on a
              questionnaire. Use it to retire a demo without deleting it.
            </FieldHelp>
          </Label>
          <p className="text-muted-foreground text-xs">Available for attribution when on.</p>
        </div>
        <Switch
          id="isActive"
          checked={isActive}
          onCheckedChange={(checked) => setValue('isActive', checked, { shouldDirty: true })}
          disabled={isLoading}
          aria-label="Active"
        />
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isLoading || (isEdit && !isDirty)}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit ? 'Save changes' : 'Create demo client'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={isLoading}
          onClick={() => router.push('/admin/demo-clients')}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
