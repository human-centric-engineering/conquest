'use client';

/**
 * DEMO-ONLY (brand import): propose a client's theme from their website, or from a screenshot of it.
 *
 * Branding a demo client by hand means a dozen fields copied out of a brand guideline. This reads
 * them off the prospect's own site instead: paste an address and we fetch and parse it, or upload a
 * screenshot and we measure the colours in the picture. Either way the admin accepts what they want
 * and vetoes the rest.
 *
 * ## Two tabs, one result
 *
 * The URL route is the one an admin reaches for; the screenshot route is what catches it when that
 * fails. Sites behind bot walls, behind logins, or built entirely in JavaScript give a server-side
 * fetcher nothing — and we cannot render them, because Chromium on a serverless function is a fight
 * we would lose. The admin's browser has already rendered the page, so when a URL import comes back
 * `blocked` the panel offers the other tab as the next step rather than as a consolation.
 *
 * ## Nothing is applied without a click, and colours are never saved here
 *
 * Accepted colours and the type pairing are written into FORM state via the parent's setters, as if
 * the admin had typed them: the preview updates, Save becomes enabled, Cancel discards.
 *
 * **Images are the exception, and deliberately so.** A discovered logo is re-hosted by POSTing its
 * address to the same upload endpoint a file goes to, which writes the column immediately — the
 * same "uploads apply at once" contract `BrandImageField` already has, for the same reason: there
 * is no draft state for a binary. When storage is unconfigured we fall back to storing the remote
 * address, and say so, because a hotlink can break in an invitation email or an export PDF.
 */

import { useRef, useState } from 'react';
import { Globe, Loader2, Upload } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import {
  isImportableColorField,
  type BrandImportResult,
  type ImportableField,
} from '@/lib/app/questionnaire/brand-import/result';
import type { BrandImageKind } from '@/lib/app/questionnaire/theming';

/**
 * Field → the label the form uses for it.
 *
 * Copied from the form's own labels rather than invented, so a proposal names the box the admin
 * will see it land in. "Surface colour" here and "Brand band" on the form would make the admin hunt
 * for a field that does not exist under that name.
 */
const FIELD_LABELS: Record<ImportableField, string> = {
  surfaceColor: 'Surface colour',
  ctaColor: 'CTA colour',
  ctaColorEnd: 'CTA gradient end',
  accentColor: 'Accent colour',
  accentColorEnd: 'Second accent',
  canvasColor: 'Canvas colour',
  inkColor: 'Ink colour',
  logoBackgroundColor: 'Logo background colour',
  logoUrl: 'Logo',
  logoMarkUrl: 'Mark (square)',
  logoDarkUrl: 'Logo (light-on-dark)',
  fontPairing: 'Type',
  customFontDisplay: 'Headings typeface',
  customFontBody: 'Body typeface',
};

/** The three image fields, and which upload endpoint re-hosts each one. */
const IMAGE_FIELD_KINDS: Partial<Record<ImportableField, BrandImageKind>> = {
  logoUrl: 'logo',
  logoMarkUrl: 'mark',
  logoDarkUrl: 'logo-dark',
};

const IMAGE_ENDPOINTS: Record<BrandImageKind, (id: string) => string> = {
  logo: API.APP.DEMO_CLIENTS.logo,
  banner: API.APP.DEMO_CLIENTS.banner,
  mark: API.APP.DEMO_CLIENTS.mark,
  'logo-dark': API.APP.DEMO_CLIENTS.logoDark,
};

interface BrandImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present on the edit form; absent on create, where images cannot be re-hosted yet. */
  demoClientId?: string;
  /** False when the server has no storage provider — image proposals degrade to a hotlink. */
  uploadEnabled?: boolean;
  /** Write accepted proposals into form state. The parent owns which setter each field needs. */
  onApply: (values: Partial<Record<ImportableField, string>>) => void;
}

export function BrandImportDialog({
  open,
  onOpenChange,
  demoClientId,
  uploadEnabled = false,
  onApply,
}: BrandImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'url' | 'screenshot'>('url');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BrandImportResult | null>(null);
  const [accepted, setAccepted] = useState<Set<ImportableField>>(new Set());

  /** Images can only be re-hosted against a SAVED client, and only when storage exists. */
  const canRehost = Boolean(demoClientId) && uploadEnabled;

  const reset = () => {
    setResult(null);
    setAccepted(new Set());
    setError(null);
  };

  const receive = (parsed: BrandImportResult) => {
    setResult(parsed);
    // Pre-tick everything: the admin's job is to VETO what looks wrong, not to re-select what the
    // import already got right. Anything left ticked is what they were shown.
    setAccepted(new Set(Object.keys(parsed.fields) as ImportableField[]));
  };

  const importFromUrl = async () => {
    if (!url.trim()) return;
    reset();
    setBusy(true);
    try {
      const response = await fetch(API.APP.DEMO_CLIENTS.brandImport, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), demoClientId }),
      });
      const parsed = await parseApiResponse<BrandImportResult>(response);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      receive(parsed.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that website.');
    } finally {
      setBusy(false);
    }
  };

  const importFromFile = async (file: File) => {
    reset();
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      if (demoClientId) body.append('demoClientId', demoClientId);

      const response = await fetch(API.APP.DEMO_CLIENTS.brandImport, { method: 'POST', body });
      const parsed = await parseApiResponse<BrandImportResult>(response);
      if (!parsed.success) {
        // The server's rejection carries the actionable detail (too small, wrong type, rate
        // limited) — surface it verbatim rather than flattening it to "import failed".
        setError(parsed.error.message);
        return;
      }
      receive(parsed.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that screenshot.');
    } finally {
      setBusy(false);
      // Clear the input so re-picking the SAME file still fires a change event.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const toggle = (field: ImportableField) => {
    setAccepted((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  /**
   * Re-host one discovered image, falling back to its remote address.
   *
   * A failed re-host is NOT a failed field: the remote URL is a legal value for the column, so the
   * admin still gets their logo — it is simply hotlinked, which the panel already warns about when
   * re-hosting is unavailable. Losing the logo entirely because a CDN refused our second request
   * would be a worse trade.
   */
  const rehost = async (kind: BrandImageKind, sourceUrl: string): Promise<string> => {
    try {
      const response = await fetch(IMAGE_ENDPOINTS[kind](demoClientId as string), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceUrl }),
      });
      const parsed = await parseApiResponse<{ url: string }>(response);
      return parsed.success ? parsed.data.url : sourceUrl;
    } catch {
      return sourceUrl;
    }
  };

  /**
   * Fetch and store the proposed families.
   *
   * Returns an error message when the fetch fails, and the caller then drops the three type fields
   * rather than applying them: `fontPairing: 'custom'` with no stored files renders in the system
   * stack, which would look like the import silently did nothing to the typeface. Better to say the
   * family was not found and leave the picker alone.
   */
  const loadFonts = async (display?: string, body?: string): Promise<string | null> => {
    try {
      const response = await fetch(API.APP.DEMO_CLIENTS.fonts(demoClientId as string), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display, body }),
      });
      const parsed = await parseApiResponse<unknown>(response);
      return parsed.success ? null : parsed.error.message;
    } catch (err) {
      return err instanceof Error ? err.message : 'Could not load those typefaces.';
    }
  };

  const applyAccepted = async () => {
    if (!result) return;
    setApplying(true);
    setError(null);
    try {
      const values: Partial<Record<ImportableField, string>> = {};
      for (const field of accepted) {
        const proposal = result.fields[field];
        if (!proposal) continue;

        const kind = IMAGE_FIELD_KINDS[field];
        values[field] = kind && canRehost ? await rehost(kind, proposal.value) : proposal.value;
      }

      // Custom type is the one proposal that needs a server round-trip before it means anything:
      // the families have to be fetched and stored, and until they are, `custom` is the system
      // stack. Same immediate-write contract as re-hosting a logo.
      const wantsCustomType = values.customFontDisplay || values.customFontBody;
      if (wantsCustomType) {
        if (!canRehost) {
          delete values.customFontDisplay;
          delete values.customFontBody;
          if (values.fontPairing === 'custom') delete values.fontPairing;
          setError(
            demoClientId
              ? 'File storage is not configured, so custom typefaces could not be stored. Everything else was applied.'
              : 'Save the client first to store its typefaces. Everything else was applied.'
          );
        } else {
          const failure = await loadFonts(values.customFontDisplay, values.customFontBody);
          if (failure) {
            delete values.customFontDisplay;
            delete values.customFontBody;
            if (values.fontPairing === 'custom') delete values.fontPairing;
            setError(`${failure} Everything else was applied — pick a typeface by hand.`);
          }
        }
      }

      onApply(values);
      // Stay open when something needs saying; the admin has to read why the type was skipped.
      if (!wantsCustomType) {
        onOpenChange(false);
        reset();
      }
    } finally {
      setApplying(false);
    }
  };

  const proposals = result
    ? (Object.entries(result.fields) as [
        ImportableField,
        NonNullable<BrandImportResult['fields'][ImportableField]>,
      ][])
    : [];

  const hasImageProposal = proposals.some(([field]) => field in IMAGE_FIELD_KINDS);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import branding</DialogTitle>
          <DialogDescription>
            Read the client&apos;s colours, logo and typeface off their own website. Colours are
            suggestions until you save the form.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(next) => setTab(next as 'url' | 'screenshot')}>
          <TabsList>
            <TabsTrigger value="url">Website address</TabsTrigger>
            <TabsTrigger value="screenshot">Screenshot</TabsTrigger>
          </TabsList>

          <TabsContent value="url" className="space-y-2 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void importFromUrl();
                  }
                }}
                placeholder="acme.example"
                disabled={busy}
                className="max-w-xs"
                aria-label="Website address"
              />
              <Button
                type="button"
                onClick={() => void importFromUrl()}
                disabled={busy || !url.trim()}
              >
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Globe className="mr-2 h-4 w-4" />
                )}
                Read the site
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Their homepage. We read the page, its stylesheets and its logo — nothing else, and
              nothing is stored.
            </p>
          </TabsContent>

          <TabsContent value="screenshot" className="space-y-2 pt-3">
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importFromFile(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Choose a screenshot
            </Button>
            <p className="text-muted-foreground text-xs">
              A wide capture of the homepage works best — at least 320px on each side. Use this when
              the site blocks us, needs a login, or draws itself in JavaScript.
            </p>
          </TabsContent>
        </Tabs>

        <div className="space-y-4">
          {error && (
            <p
              className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-xs"
              role="alert"
            >
              {error}
            </p>
          )}

          {result?.reason && (
            <div
              className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
              role="status"
            >
              <p>{result.reason}</p>
              {result.nextStep === 'screenshot' && tab === 'url' && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setTab('screenshot');
                    reset();
                  }}
                >
                  Try a screenshot instead
                </Button>
              )}
            </div>
          )}

          {proposals.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">What we found</p>
              {proposals.map(([field, proposal]) => (
                <label
                  key={field}
                  className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2"
                >
                  <Checkbox
                    checked={accepted.has(field)}
                    onCheckedChange={() => toggle(field)}
                    aria-label={`Apply ${FIELD_LABELS[field]}`}
                    className="mt-0.5"
                  />
                  {isImportableColorField(field) && (
                    <span
                      className="mt-0.5 h-5 w-5 shrink-0 rounded border"
                      style={{ backgroundColor: proposal.value }}
                      aria-hidden
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{FIELD_LABELS[field]}</span>
                      <code className="text-muted-foreground truncate text-xs">
                        {proposal.value}
                      </code>
                      {proposal.confidence === 'low' && (
                        <span className="text-muted-foreground text-xs">· best guess</span>
                      )}
                    </span>
                    <span className="text-muted-foreground block text-xs">{proposal.source}</span>
                    {proposal.caveat && (
                      <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
                        {proposal.caveat}
                      </span>
                    )}
                  </span>
                </label>
              ))}

              {hasImageProposal && !canRehost && (
                <p className="text-muted-foreground text-xs">
                  {demoClientId
                    ? 'File storage is not configured, so images will be linked from the client’s own site. A link can break in invitation emails and export PDFs.'
                    : 'Save the client first and re-run the import to store its logo with us. For now the image will be linked from their site.'}
                </p>
              )}
            </div>
          )}

          {result && result.candidates.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Every colour we measured</p>
              <p className="text-muted-foreground text-xs">
                Ranked by how much of the brand they account for. Useful when a suggestion above is
                wrong — copy a hex into the field by hand.
              </p>
              <div className="flex flex-wrap gap-2">
                {result.candidates.map((candidate) => (
                  <span
                    key={candidate.hex}
                    className="flex items-center gap-1.5 rounded-md border px-2 py-1"
                    title={`${(candidate.share * 100).toFixed(1)}%`}
                  >
                    <span
                      className="h-4 w-4 rounded-sm border"
                      style={{ backgroundColor: candidate.hex }}
                      aria-hidden
                    />
                    <code className="text-xs">{candidate.hex}</code>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void applyAccepted()}
            disabled={accepted.size === 0 || applying}
          >
            {applying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Apply {accepted.size > 0 ? accepted.size : ''}{' '}
            {accepted.size === 1 ? 'field' : 'fields'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
