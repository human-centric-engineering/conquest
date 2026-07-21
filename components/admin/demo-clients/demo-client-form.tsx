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
import {
  BRAND_BANNER_SPEC,
  BRAND_LOGO_SPEC,
  HEX_COLOR_PATTERN,
  WELCOME_COPY_MAX,
  isBrandImageSrc,
} from '@/lib/app/questionnaire/theming';
import { BrandImageField } from '@/components/admin/demo-clients/brand-image-field';

/** True for an empty field, an https URL, or one of our own upload paths — shares the
 *  server's predicate (isBrandImageSrc) so the form and the API can't drift. */
function isBlankOrBrandImage(value: string): boolean {
  return value === '' || isBrandImageSrc(value);
}

const hexOrBlank = z
  .string()
  .trim()
  .refine((v) => v === '' || HEX_COLOR_PATTERN.test(v), {
    message: 'Hex colour like #0a1a3a (or leave blank for the default)',
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
  // DEMO-ONLY (F3.4): brand theme for the invitation email. Blank = ConQuest default.
  ctaColor: hexOrBlank,
  accentColor: hexOrBlank,
  logoUrl: z.string().trim().refine(isBlankOrBrandImage, {
    message: 'Absolute https:// URL or an uploaded image (or leave blank)',
  }),
  bannerUrl: z.string().trim().refine(isBlankOrBrandImage, {
    message: 'Absolute https:// URL or an uploaded image (or leave blank)',
  }),
  welcomeCopy: z.string().trim().max(WELCOME_COPY_MAX),
  // DEMO-ONLY (F7.1+): respondent-session chrome. All optional; blank = no band.
  surfaceColor: hexOrBlank,
  ctaColorEnd: hexOrBlank,
  logoBackgroundColor: hexOrBlank,
  logoBackgroundEnabled: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

export interface DemoClientFormProps {
  /** Present in edit mode; absent in create mode. */
  client?: DemoClientView;
  /**
   * Whether the server has a storage provider configured. Resolved on the server
   * (`isStorageEnabled()`) and passed down, because this is a client component and the
   * check reads server-only env. False → the brand image fields degrade to URL-only.
   */
  uploadEnabled?: boolean;
}

export function DemoClientForm({ client, uploadEnabled = false }: DemoClientFormProps) {
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
      bannerUrl: client?.bannerUrl ?? '',
      welcomeCopy: client?.welcomeCopy ?? '',
      surfaceColor: client?.surfaceColor ?? '',
      ctaColorEnd: client?.ctaColorEnd ?? '',
      logoBackgroundColor: client?.logoBackgroundColor ?? '',
      logoBackgroundEnabled: client?.logoBackgroundEnabled ?? false,
    },
  });

  const isActive = watch('isActive');
  const logoBackgroundEnabled = watch('logoBackgroundEnabled');

  // Live brand preview: reflect only valid inputs (a half-typed hex / non-https URL
  // shows the default rather than a broken swatch); blank → null → ConQuest default.
  const [
    ctaColor,
    accentColor,
    logoUrl,
    bannerUrl,
    welcomeCopy,
    surfaceColor,
    ctaColorEnd,
    logoBackgroundColor,
  ] = watch([
    'ctaColor',
    'accentColor',
    'logoUrl',
    'bannerUrl',
    'welcomeCopy',
    'surfaceColor',
    'ctaColorEnd',
    'logoBackgroundColor',
  ]);
  const validHex = (v: string) => (HEX_COLOR_PATTERN.test(v.trim()) ? v.trim() : null);
  const livePreviewTheme = {
    ctaColor: validHex(ctaColor),
    accentColor: validHex(accentColor),
    logoUrl: isBrandImageSrc(logoUrl.trim()) ? logoUrl.trim() : null,
    bannerUrl: isBrandImageSrc(bannerUrl.trim()) ? bannerUrl.trim() : null,
    welcomeCopy: welcomeCopy.trim() === '' ? null : welcomeCopy.trim(),
    surfaceColor: validHex(surfaceColor),
    ctaColorEnd: validHex(ctaColorEnd),
    logoBackgroundColor: validHex(logoBackgroundColor),
    logoBackgroundEnabled,
  };

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setError(null);
    try {
      // Empty theme field → null so the column clears to the ConQuest default.
      const themeOrNull = (v: string) => (v.trim() === '' ? null : v.trim());
      const body = {
        name: values.name,
        description: values.description.trim() === '' ? null : values.description.trim(),
        isActive: values.isActive,
        ...(values.slug.trim() === '' ? {} : { slug: values.slug.trim() }),
        ctaColor: themeOrNull(values.ctaColor),
        accentColor: themeOrNull(values.accentColor),
        logoUrl: themeOrNull(values.logoUrl),
        bannerUrl: themeOrNull(values.bannerUrl),
        welcomeCopy: themeOrNull(values.welcomeCopy),
        surfaceColor: themeOrNull(values.surfaceColor),
        ctaColorEnd: themeOrNull(values.ctaColorEnd),
        logoBackgroundColor: themeOrNull(values.logoBackgroundColor),
        logoBackgroundEnabled: values.logoBackgroundEnabled,
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

      {/* DEMO-ONLY (F3.4 / F7.1+): brand theming. Every field is optional. Setting ANY
          visual field claims the surface: the session becomes white-label and the client's
          brand is the only identity inside it. Setting NONE leaves the session in ConQuest
          colours with the ConQuest wordmark in the header band (see `hasBrandIdentity` in
          lib/app/questionnaire/theming/theme.ts). Colours apply to BOTH the invitation email
          and the respondent question session (and the admin "Preview as respondent"). */}
      <fieldset className="space-y-4 rounded-md border px-4 py-4">
        <legend className="px-1 text-sm font-medium">Brand theming</legend>
        <p className="text-muted-foreground -mt-1 text-xs">
          Optional. Applied to the invitation email and the respondent question session (visible via
          &ldquo;Preview as respondent&rdquo;). Set nothing and the session runs in ConQuest colours
          with the ConQuest banner; set any field and this client&apos;s brand takes over the
          session entirely.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="surfaceColor" className="flex items-center gap-1">
              Surface colour
              <FieldHelp title="Surface colour">
                Deep brand colour for the band behind the logo at the top of the question session
                (e.g. <code className="text-xs">#280039</code>). Blank shows no band — the session
                keeps its plain chrome.
              </FieldHelp>
            </Label>
            <Input
              id="surfaceColor"
              placeholder="#280039"
              disabled={isLoading}
              {...register('surfaceColor')}
            />
            <FormError message={errors.surfaceColor?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="accentColor" className="flex items-center gap-1">
              Accent colour
              <FieldHelp title="Accent colour">
                Hex secondary/accent colour (e.g. <code className="text-xs">#2f6bff</code>). Colours
                the email&apos;s fallback link and the respondent UI; blank uses the ConQuest
                default.
              </FieldHelp>
            </Label>
            <Input
              id="accentColor"
              placeholder="#2f6bff"
              disabled={isLoading}
              {...register('accentColor')}
            />
            <FormError message={errors.accentColor?.message} />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="ctaColor" className="flex items-center gap-1">
              CTA colour
              <FieldHelp title="Call-to-action colour">
                Hex colour for the email&apos;s primary button (e.g.{' '}
                <code className="text-xs">#0a1a3a</code>). Blank uses the ConQuest default.
              </FieldHelp>
            </Label>
            <Input
              id="ctaColor"
              placeholder="#0a1a3a"
              disabled={isLoading}
              {...register('ctaColor')}
            />
            <FormError message={errors.ctaColor?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ctaColorEnd" className="flex items-center gap-1">
              CTA gradient end
              <FieldHelp title="CTA gradient end colour">
                Optional second colour for the send button. When set, the button becomes a{' '}
                <em>CTA colour → this</em> gradient (e.g. <code className="text-xs">#FF03DF</code>).
                Blank keeps a solid CTA colour.
              </FieldHelp>
            </Label>
            <Input
              id="ctaColorEnd"
              placeholder="#FF03DF"
              disabled={isLoading}
              {...register('ctaColorEnd')}
            />
            <FormError message={errors.ctaColorEnd?.message} />
          </div>
        </div>

        {/* DEMO-ONLY (F7.1+): respondent-session chrome. The logo sits at the top of the
            session header; the toggle below paints a backdrop for logos drawn to sit on one. */}
        <div className="space-y-4 border-t pt-4">
          <BrandImageField
            id="logoUrl"
            label="Logo"
            spec={BRAND_LOGO_SPEC}
            demoClientId={client?.id}
            uploadEnabled={uploadEnabled}
            value={logoUrl}
            onChange={(v) => setValue('logoUrl', v, { shouldDirty: true, shouldValidate: true })}
            disabled={isLoading}
            error={errors.logoUrl?.message}
            help={
              <>
                The client logo shown at the top of the invitation email and the respondent session
                header. Either paste an absolute <code className="text-xs">https://</code> URL or
                upload an image. Any shape — it is scaled to fit the header slot. Blank shows no
                logo.
              </>
            }
          />

          <BrandImageField
            id="bannerUrl"
            label="Header banner"
            spec={BRAND_BANNER_SPEC}
            demoClientId={client?.id}
            uploadEnabled={uploadEnabled}
            value={bannerUrl}
            onChange={(v) => setValue('bannerUrl', v, { shouldDirty: true, shouldValidate: true })}
            disabled={isLoading}
            error={errors.bannerUrl?.message}
            help={
              <>
                A full-bleed banner that <strong>replaces</strong> the respondent session&apos;s
                header band — the logo, title and colours above it no longer show in that strip, so
                the banner should carry the branding itself. Roughly 4:1;{' '}
                <code className="text-xs">1600x400</code> is ideal. Respondent session only — the
                invitation email and export PDFs keep using the logo.
              </>
            }
          />

          {/* The requested device: a checkbox to paint a solid colour behind the logo —
              for logos (like Merlin5's) drawn to sit on their brand backdrop. */}
          <div className="space-y-3 rounded-md border px-3 py-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="logoBackgroundEnabled" className="flex items-center gap-1">
                Apply a colour behind the logo
                <FieldHelp title="Logo background">
                  Many logos are drawn to sit on a specific brand colour and look wrong on white.
                  Turn this on to paint a solid backdrop behind the logo. Leave the colour blank to
                  reuse the surface colour.
                </FieldHelp>
              </Label>
              <Switch
                id="logoBackgroundEnabled"
                checked={logoBackgroundEnabled}
                onCheckedChange={(checked) =>
                  setValue('logoBackgroundEnabled', checked, { shouldDirty: true })
                }
                disabled={isLoading}
                aria-label="Apply a colour behind the logo"
              />
            </div>
            {logoBackgroundEnabled && (
              <div className="space-y-2">
                <Label htmlFor="logoBackgroundColor" className="text-xs">
                  Logo background colour
                </Label>
                <Input
                  id="logoBackgroundColor"
                  placeholder="Leave blank to use the surface colour"
                  disabled={isLoading}
                  {...register('logoBackgroundColor')}
                />
                <FormError message={errors.logoBackgroundColor?.message} />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2 border-t pt-4">
          <Label htmlFor="welcomeCopy" className="flex items-center gap-1">
            Welcome copy
            <FieldHelp title="Welcome copy">
              A short branded intro line shown in the invitation email body and as the
              session&apos;s opening greeting, after &ldquo;You&apos;ve been invited to complete
              &lt;questionnaire&gt;.&rdquo; Blank uses the ConQuest default copy.
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
