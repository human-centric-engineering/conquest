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
import { DemoClientThemePreview } from '@/components/admin/demo-clients/demo-client-theme-preview';
import {
  DEMO_CLIENT_SLUG_MAX_LENGTH,
  DEMO_CLIENT_SLUG_PATTERN,
  type DemoClientView,
} from '@/lib/app/questionnaire/demo-clients';
import { HEX_COLOR_PATTERN, WELCOME_COPY_MAX, isHttpsUrl } from '@/lib/app/questionnaire/theming';

/** True for an empty field or an absolute https URL — shares the server's https
 *  predicate (isHttpsUrl) so the form and the API can't drift. */
function isBlankOrHttpsUrl(value: string): boolean {
  return value === '' || isHttpsUrl(value);
}

const hexOrBlank = z
  .string()
  .trim()
  .refine((v) => v === '' || HEX_COLOR_PATTERN.test(v), {
    message: 'Hex colour like #5469d4 (or leave blank for the default)',
  });

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
  // DEMO-ONLY (F3.4): brand theme for the invitation email. Blank = Sunrise default.
  ctaColor: hexOrBlank,
  accentColor: hexOrBlank,
  logoUrl: z.string().trim().refine(isBlankOrHttpsUrl, {
    message: 'Absolute https:// URL (or leave blank)',
  }),
  welcomeCopy: z.string().trim().max(WELCOME_COPY_MAX),
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
      ctaColor: client?.ctaColor ?? '',
      accentColor: client?.accentColor ?? '',
      logoUrl: client?.logoUrl ?? '',
      welcomeCopy: client?.welcomeCopy ?? '',
    },
  });

  const isActive = watch('isActive');

  // Live brand preview: reflect only valid inputs (a half-typed hex / non-https URL
  // shows the default rather than a broken swatch); blank → null → Sunrise default.
  const [ctaColor, accentColor, logoUrl, welcomeCopy] = watch([
    'ctaColor',
    'accentColor',
    'logoUrl',
    'welcomeCopy',
  ]);
  const livePreviewTheme = {
    ctaColor: HEX_COLOR_PATTERN.test(ctaColor.trim()) ? ctaColor.trim() : null,
    accentColor: HEX_COLOR_PATTERN.test(accentColor.trim()) ? accentColor.trim() : null,
    logoUrl: isHttpsUrl(logoUrl.trim()) ? logoUrl.trim() : null,
    welcomeCopy: welcomeCopy.trim() === '' ? null : welcomeCopy.trim(),
  };

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setError(null);
    try {
      // Empty theme field → null so the column clears to the Sunrise default.
      const themeOrNull = (v: string) => (v.trim() === '' ? null : v.trim());
      const body = {
        name: values.name,
        description: values.description.trim() === '' ? null : values.description.trim(),
        isActive: values.isActive,
        ...(values.slug.trim() === '' ? {} : { slug: values.slug.trim() }),
        ctaColor: themeOrNull(values.ctaColor),
        accentColor: themeOrNull(values.accentColor),
        logoUrl: themeOrNull(values.logoUrl),
        welcomeCopy: themeOrNull(values.welcomeCopy),
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

      {/* DEMO-ONLY (F3.4): invitation-email branding. Every field is optional — blank
          falls back to the Sunrise default, so an unthemed client sends the plain email. */}
      <fieldset className="space-y-4 rounded-md border px-4 py-4">
        <legend className="px-1 text-sm font-medium">Invitation branding</legend>
        <p className="text-muted-foreground -mt-1 text-xs">
          Optional. Used in the invitation email sent to this client&apos;s respondents. Leave a
          field blank to use the Sunrise default.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="ctaColor" className="flex items-center gap-1">
              CTA colour
              <FieldHelp title="Call-to-action colour">
                Hex colour for the email&apos;s primary button (e.g.{' '}
                <code className="text-xs">#5469d4</code>). Blank uses the Sunrise default.
              </FieldHelp>
            </Label>
            <Input
              id="ctaColor"
              placeholder="#5469d4"
              disabled={isLoading}
              {...register('ctaColor')}
            />
            <FormError message={errors.ctaColor?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="accentColor" className="flex items-center gap-1">
              Accent colour
              <FieldHelp title="Accent colour">
                Hex secondary/accent colour (e.g. <code className="text-xs">#5469d4</code>). Colours
                the email&apos;s fallback link and the respondent UI; blank uses the Sunrise
                default.
              </FieldHelp>
            </Label>
            <Input
              id="accentColor"
              placeholder="#5469d4"
              disabled={isLoading}
              {...register('accentColor')}
            />
            <FormError message={errors.accentColor?.message} />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="logoUrl" className="flex items-center gap-1">
            Logo URL
            <FieldHelp title="Logo URL">
              Absolute <code className="text-xs">https://</code> URL of the client logo shown at the
              top of the invitation email. Blank shows no logo.
            </FieldHelp>
          </Label>
          <Input
            id="logoUrl"
            placeholder="https://acme.example/logo.png"
            disabled={isLoading}
            {...register('logoUrl')}
          />
          <FormError message={errors.logoUrl?.message} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="welcomeCopy" className="flex items-center gap-1">
            Welcome copy
            <FieldHelp title="Welcome copy">
              A short branded intro line in the invitation email body, after &ldquo;You&apos;ve been
              invited to complete &lt;questionnaire&gt;.&rdquo; Blank uses the Sunrise default copy.
            </FieldHelp>
          </Label>
          <Textarea
            id="welcomeCopy"
            placeholder="A short, branded welcome line (optional)"
            rows={2}
            disabled={isLoading}
            {...register('welcomeCopy')}
          />
          <FormError message={errors.welcomeCopy?.message} />
        </div>

        <div className="space-y-2 border-t pt-4">
          <p className="text-muted-foreground text-xs font-medium">Preview</p>
          <DemoClientThemePreview theme={livePreviewTheme} />
        </div>
      </fieldset>

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
