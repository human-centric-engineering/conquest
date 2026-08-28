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
  BRAND_MARK_SPEC,
  DEFAULT_FONT_PAIRING,
  FONT_PAIRINGS,
  FONT_PAIRING_COPY,
  HEX_COLOR_PATTERN,
  MIN_CONTRAST_RATIO,
  NEUTRAL_RESPONDENT_GROUND,
  WELCOME_COPY_MAX,
  contrastRatio,
  isBrandImageSrc,
  resolveFontPairing,
  resolveTheme,
} from '@/lib/app/questionnaire/theming';
import { BrandImageField } from '@/components/admin/demo-clients/brand-image-field';
import { BrandColorField } from '@/components/admin/demo-clients/brand-color-field';

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
  // Brand kit: the ground the questionnaire is drawn on, the type it is set in, the marks.
  canvasColor: hexOrBlank,
  inkColor: hexOrBlank,
  canvasColorDark: hexOrBlank,
  inkColorDark: hexOrBlank,
  accentColorEnd: hexOrBlank,
  logoMarkUrl: z.string().trim().refine(isBlankOrBrandImage, {
    message: 'Absolute https:// URL or an uploaded image (or leave blank)',
  }),
  logoDarkUrl: z.string().trim().refine(isBlankOrBrandImage, {
    message: 'Absolute https:// URL or an uploaded image (or leave blank)',
  }),
  // A select, so the value is always one of the three — but validated anyway, because the
  // server does and a form that can submit what the API rejects is a worse experience than
  // one that says so first.
  fontPairing: z.enum(FONT_PAIRINGS),
});

type FormValues = z.infer<typeof formSchema>;

/** The colour fields, so `setColor` can't be pointed at a field that isn't one. */
type ColorFieldName =
  | 'ctaColor'
  | 'accentColor'
  | 'surfaceColor'
  | 'ctaColorEnd'
  | 'logoBackgroundColor'
  | 'canvasColor'
  | 'inkColor'
  | 'canvasColorDark'
  | 'inkColorDark'
  | 'accentColorEnd';

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
      canvasColor: client?.canvasColor ?? '',
      inkColor: client?.inkColor ?? '',
      canvasColorDark: client?.canvasColorDark ?? '',
      inkColorDark: client?.inkColorDark ?? '',
      accentColorEnd: client?.accentColorEnd ?? '',
      logoMarkUrl: client?.logoMarkUrl ?? '',
      logoDarkUrl: client?.logoDarkUrl ?? '',
      // Forgiving on the way IN, exactly as the resolver is: a stored value this build does
      // not know (a rollback, a seed) prefills as the default rather than leaving the select
      // with no selection and silently clearing the column on the next save.
      fontPairing: resolveFontPairing(client?.fontPairing),
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
    canvasColor,
    inkColor,
    canvasColorDark,
    inkColorDark,
    accentColorEnd,
    logoMarkUrl,
    logoDarkUrl,
    fontPairing,
  ] = watch([
    'ctaColor',
    'accentColor',
    'logoUrl',
    'bannerUrl',
    'welcomeCopy',
    'surfaceColor',
    'ctaColorEnd',
    'logoBackgroundColor',
    'canvasColor',
    'inkColor',
    'canvasColorDark',
    'inkColorDark',
    'accentColorEnd',
    'logoMarkUrl',
    'logoDarkUrl',
    'fontPairing',
  ]);
  // One writer for every colour field. `BrandColorField` is a controlled input rather than a
  // `register()`ed one (the swatch and the hex box are two controls for one value), so each
  // needs an onChange that marks the form dirty — otherwise Save stays disabled in edit mode
  // after a change made entirely through the picker.
  const setColor = (field: ColorFieldName, value: string) =>
    setValue(field, value, { shouldDirty: true, shouldValidate: true });

  const validHex = (v: string) => (HEX_COLOR_PATTERN.test(v.trim()) ? v.trim() : null);
  const validImage = (v: string) => (isBrandImageSrc(v.trim()) ? v.trim() : null);
  const livePreviewTheme = {
    ctaColor: validHex(ctaColor),
    accentColor: validHex(accentColor),
    logoUrl: validImage(logoUrl),
    bannerUrl: validImage(bannerUrl),
    welcomeCopy: welcomeCopy.trim() === '' ? null : welcomeCopy.trim(),
    surfaceColor: validHex(surfaceColor),
    ctaColorEnd: validHex(ctaColorEnd),
    logoBackgroundColor: validHex(logoBackgroundColor),
    logoBackgroundEnabled,
    canvasColor: validHex(canvasColor),
    inkColor: validHex(inkColor),
    canvasColorDark: validHex(canvasColorDark),
    inkColorDark: validHex(inkColorDark),
    accentColorEnd: validHex(accentColorEnd),
    logoMarkUrl: validImage(logoMarkUrl),
    logoDarkUrl: validImage(logoDarkUrl),
    fontPairing,
  };

  // The one pair on this form that can be independently valid and jointly unreadable: both
  // are legal hexes, and nothing else notices that mid-grey ink on a mid-grey paper stock is
  // unreadable. Measured against the RESOLVED pair rather than the typed one, so an admin who
  // sets only a canvas is checked against the ink we will actually derive for them.
  //
  // Both grounds are checked, because a respondent can be reading either: the dark pair is
  // usually derived rather than typed, and a derived pair can still fail — a mid-tone brand
  // colour has no ink that clears AA — so the warning names WHICH mode is the problem.
  const resolvedPreview = resolveTheme(livePreviewTheme);
  const contrastWarnings = (
    [
      ['light', resolvedPreview.canvasColor, resolvedPreview.onCanvas, 'light'],
      ['dark', resolvedPreview.canvasColorDark, resolvedPreview.onCanvasDark, 'dark'],
    ] as const
  ).flatMap(([mode, authoredGround, authoredInk, key]) => {
    // Measured against the pair that will ACTUALLY render, defaults included — not only against
    // the pair the admin typed. Requiring both halves to be authored left the worst case
    // unchecked: an admin who fills in Ink from a guideline that reads "ink: #FFFFFF on dark"
    // and leaves Canvas blank gets their white ink on the DEFAULT white ground, and nothing
    // anywhere said so. The ground is only ever null when the client has none, in which case the
    // stylesheet uses these same neutrals.
    const ground = authoredGround ?? NEUTRAL_RESPONDENT_GROUND[key].canvas;
    const ink = authoredInk ?? NEUTRAL_RESPONDENT_GROUND[key].ink;
    // `contrastRatio` returns null for a colour it cannot read, which cannot happen here — both
    // arguments are either a hex the form has already validated or one of our own neutrals — but
    // "unreadable" must not silently become "unreadable CONTRAST" and raise a false warning.
    const ratio = contrastRatio(ground, ink);
    return ratio !== null && ratio < MIN_CONTRAST_RATIO
      ? [{ mode, ratio, onDefaultGround: authoredGround === null }]
      : [];
  });

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
        canvasColor: themeOrNull(values.canvasColor),
        inkColor: themeOrNull(values.inkColor),
        canvasColorDark: themeOrNull(values.canvasColorDark),
        inkColorDark: themeOrNull(values.inkColorDark),
        accentColorEnd: themeOrNull(values.accentColorEnd),
        logoMarkUrl: themeOrNull(values.logoMarkUrl),
        logoDarkUrl: themeOrNull(values.logoDarkUrl),
        // The neutral pairing is stored as NULL rather than the string 'neutral': null is
        // already what every unset client has, and writing the word would make "never chose"
        // and "chose the default" two different rows that render identically.
        fontPairing: values.fontPairing === DEFAULT_FONT_PAIRING ? null : values.fontPairing,
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
          <BrandColorField
            id="surfaceColor"
            label="Surface colour"
            value={surfaceColor}
            onChange={(v) => setColor('surfaceColor', v)}
            placeholder="#280039"
            disabled={isLoading}
            error={errors.surfaceColor?.message}
            help={
              <>
                Deep brand colour for the band behind the logo at the top of the question session
                (e.g. <code className="text-xs">#280039</code>). Blank shows no band — the session
                keeps its plain chrome.
              </>
            }
          />

          <BrandColorField
            id="accentColor"
            label="Accent colour"
            value={accentColor}
            onChange={(v) => setColor('accentColor', v)}
            placeholder="#2f6bff"
            disabled={isLoading}
            error={errors.accentColor?.message}
            help={
              <>
                Hex secondary/accent colour (e.g. <code className="text-xs">#2f6bff</code>). Colours
                the email&apos;s fallback link and the respondent UI; blank uses the ConQuest
                default.
              </>
            }
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <BrandColorField
            id="ctaColor"
            label="CTA colour"
            value={ctaColor}
            onChange={(v) => setColor('ctaColor', v)}
            placeholder="#0a1a3a"
            disabled={isLoading}
            error={errors.ctaColor?.message}
            help={
              <>
                Hex colour for the email&apos;s primary button (e.g.{' '}
                <code className="text-xs">#0a1a3a</code>). Blank uses the ConQuest default.
              </>
            }
          />

          <BrandColorField
            id="ctaColorEnd"
            label="CTA gradient end"
            value={ctaColorEnd}
            onChange={(v) => setColor('ctaColorEnd', v)}
            placeholder="#FF03DF"
            disabled={isLoading}
            error={errors.ctaColorEnd?.message}
            help={
              <>
                Optional second colour for the send button. When set, the button becomes a{' '}
                <em>CTA colour → this</em> gradient (e.g. <code className="text-xs">#FF03DF</code>).
                Blank keeps a solid CTA colour.
              </>
            }
          />
        </div>

        {/* DEMO-ONLY (F7.1+): respondent-session chrome. The logo sits at the top of the
            session header; the toggle below paints a backdrop for logos drawn to sit on one. */}
        <div className="space-y-4 border-t pt-4">
          <BrandImageField
            id="logoUrl"
            label="Logo"
            kind="logo"
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
            kind="banner"
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
              for logos drawn to sit on their brand backdrop. */}
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
              <BrandColorField
                id="logoBackgroundColor"
                label="Logo background colour"
                value={logoBackgroundColor}
                onChange={(v) => setColor('logoBackgroundColor', v)}
                placeholder="Leave blank to use the surface colour"
                disabled={isLoading}
                error={errors.logoBackgroundColor?.message}
                help={
                  <>
                    The solid colour painted behind the logo. Leave it blank to reuse the surface
                    colour, which is what most logos drawn for a brand backdrop expect.
                  </>
                }
              />
            )}
          </div>
        </div>

        {/* ---- Brand kit -------------------------------------------------------------
            The fields above brand what SURROUNDS the conversation. These brand the
            conversation itself — the ground it is drawn on and the type it is set in — which
            is what the Focus, Broadsheet and Horizon layouts actually paint with. Every one
            is optional and every blank keeps today's look. */}
        <div className="space-y-4 border-t pt-4">
          <div>
            <p className="text-sm font-medium">The page itself</p>
            <p className="text-muted-foreground text-xs">
              Optional. Sets the ground the questionnaire is drawn on and the type it is set in —
              what a respondent sees behind the conversation, not just around it.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <BrandColorField
              id="canvasColor"
              label="Canvas colour"
              value={canvasColor}
              onChange={(v) => setColor('canvasColor', v)}
              placeholder="#fffcf5"
              disabled={isLoading}
              error={errors.canvasColor?.message}
              help={
                <>
                  The page ground the whole questionnaire sits on — a paper stock for Broadsheet, a
                  field for Horizon. Cards, borders and muted text are all re-derived from it, so a
                  dark canvas gets a dark palette rather than white panels on top. Blank keeps the
                  neutral canvas (white, or near-black in dark mode).
                </>
              }
            />

            <BrandColorField
              id="inkColor"
              label="Ink colour"
              value={inkColor}
              onChange={(v) => setColor('inkColor', v)}
              placeholder="Leave blank to derive it"
              disabled={isLoading}
              error={errors.inkColor?.message}
              help={
                <>
                  The text colour laid on that canvas. Leave it blank and we pick whichever of
                  near-black or near-white reads better against the canvas — set it only when the
                  brand specifies its own ink.
                </>
              }
            />

            <BrandColorField
              id="canvasColorDark"
              label="Canvas colour (dark mode)"
              value={canvasColorDark}
              onChange={(v) => setColor('canvasColorDark', v)}
              placeholder="Leave blank to derive it"
              disabled={isLoading}
              error={errors.canvasColorDark?.message}
              help={
                <>
                  Respondents can switch to dark mode on any layout, so the canvas needs a dark
                  counterpart. Leave it blank and we derive one — the brand colour kept as a tint
                  over near-black, so a dark-mode questionnaire still looks like this client&apos;s.
                  Set it when the brand has its own dark palette.
                </>
              }
            />

            <BrandColorField
              id="inkColorDark"
              label="Ink colour (dark mode)"
              value={inkColorDark}
              onChange={(v) => setColor('inkColorDark', v)}
              placeholder="Leave blank to derive it"
              disabled={isLoading}
              error={errors.inkColorDark?.message}
              help={
                <>
                  The text colour on the dark canvas. Blank derives it for contrast, exactly as the
                  light pair does.
                </>
              }
            />
          </div>

          {/* A soft warning per mode, never a save blocker: a brand may genuinely be
              low-contrast, and refusing the save would be us overruling the client's designer. */}
          {contrastWarnings.map(({ mode, ratio, onDefaultGround }) => (
            <p
              key={mode}
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
              role="status"
            >
              Ink on canvas in <strong>{mode} mode</strong> is {ratio.toFixed(1)}:1, below the WCAG
              AA threshold of {MIN_CONTRAST_RATIO}:1. Respondents may struggle to read the
              conversation.{' '}
              {onDefaultGround ? (
                // Naming the ground matters here: this admin never set a canvas, so "ink on canvas"
                // alone reads as being about a colour they cannot find on the form.
                <>
                  This is your ink against the default {mode} canvas — set a canvas colour, or
                  adjust the ink.
                </>
              ) : (
                <>Save anyway if this matches the brand.</>
              )}
            </p>
          ))}

          <div className="grid gap-4 sm:grid-cols-2">
            <BrandColorField
              id="accentColorEnd"
              label="Second accent"
              value={accentColorEnd}
              onChange={(v) => setColor('accentColorEnd', v)}
              placeholder="#7b5cff"
              disabled={isLoading}
              error={errors.accentColorEnd?.message}
              help={
                <>
                  A second accent for the layouts to tint with — Horizon&apos;s aura, a rule under a
                  Broadsheet masthead. Distinct from the <em>CTA gradient end</em> above, which only
                  ever colours the send button. Blank uses the accent colour alone.
                </>
              }
            />

            <div className="space-y-2">
              <Label htmlFor="fontPairing" className="flex items-center gap-1">
                Typeface
                <FieldHelp title="Typeface pairing">
                  The type the questionnaire is set in — one choice, two faces (headings and body).{' '}
                  <strong>Neutral</strong> is the system typeface and what every questionnaire uses
                  today. <strong>Humanist</strong> is a warm, open sans and the safest step away
                  from it; <strong>Editorial</strong> is a printed-matter serif that suits
                  Broadsheet; <strong>Classical</strong> is a formal, high-contrast serif;{' '}
                  <strong>Contemporary</strong> is a grotesque drawn for Horizon; and{' '}
                  <strong>Monospace</strong> sets the whole conversation fixed-width — striking for
                  an engineering brand, but slower to read once answers run long. Unlike the
                  colours, this on its own does not make a questionnaire white-label — it is a
                  design choice, not an identity. The one-line summary below updates as you choose.
                </FieldHelp>
              </Label>
              <select
                id="fontPairing"
                value={fontPairing}
                onChange={(e) =>
                  setValue('fontPairing', resolveFontPairing(e.target.value), {
                    shouldDirty: true,
                  })
                }
                disabled={isLoading}
                className="border-input bg-background ring-offset-background focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                {FONT_PAIRINGS.map((pairing) => (
                  <option key={pairing} value={pairing}>
                    {FONT_PAIRING_COPY[pairing].label}
                  </option>
                ))}
              </select>
              <p className="text-muted-foreground text-xs">
                {FONT_PAIRING_COPY[resolveFontPairing(fontPairing)].description}
              </p>
              <FormError message={errors.fontPairing?.message} />
            </div>
          </div>

          <BrandImageField
            id="logoDarkUrl"
            label="Logo (light-on-dark)"
            kind="logo-dark"
            spec={BRAND_LOGO_SPEC}
            demoClientId={client?.id}
            uploadEnabled={uploadEnabled}
            value={logoDarkUrl}
            onChange={(v) =>
              setValue('logoDarkUrl', v, { shouldDirty: true, shouldValidate: true })
            }
            disabled={isLoading}
            error={errors.logoDarkUrl?.message}
            help={
              <>
                The same lockup drawn in light ink, for dark grounds. Used automatically wherever
                the logo would otherwise sit on a dark colour — a dark surface band, a dark logo
                backdrop, or a dark canvas. Blank means the standard logo is used everywhere, which
                on a dark ground usually means it disappears.
              </>
            }
          />

          <BrandImageField
            id="logoMarkUrl"
            label="Mark (square)"
            kind="mark"
            spec={BRAND_MARK_SPEC}
            demoClientId={client?.id}
            uploadEnabled={uploadEnabled}
            value={logoMarkUrl}
            onChange={(v) =>
              setValue('logoMarkUrl', v, { shouldDirty: true, shouldValidate: true })
            }
            disabled={isLoading}
            error={errors.logoMarkUrl?.message}
            help={
              <>
                A square device — the brand&apos;s icon rather than its full lockup — for the places
                a layout wants a mark without a wordmark&apos;s width. Must be square;{' '}
                <code className="text-xs">512x512</code> is ideal. Blank simply means those places
                show no mark.
              </>
            }
          />
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
