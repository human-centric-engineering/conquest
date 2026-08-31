'use client';

/**
 * DEMO-ONLY (brand import): propose a client's theme from their website, from screenshots of it,
 * or from both.
 *
 * Branding a demo client by hand means a dozen fields copied out of a brand guideline. This reads
 * them off the prospect's own site instead: paste an address and we fetch and parse it, add
 * screenshots and we measure the colours in the pictures. Either way the admin accepts what they
 * want and vetoes the rest.
 *
 * ## One form, not two tabs
 *
 * These were two routes on two tabs, which framed them as alternatives: use the address, and fall
 * back to a picture when the site blocks us. They are better read as complementary, because they
 * see different things — only the site names the logo file and the typeface, only a screenshot
 * measures what the rendered page is actually painted in. Tabs made "give us both", the most
 * reliable thing an admin can do, the one combination the UI could not express.
 *
 * So: one address field, up to {@link MAX_SCREENSHOTS} pictures, one button. Either half alone
 * still works, which is what an admin with only an address, or only a picture, has.
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
import { Globe, Loader2, Upload, X } from 'lucide-react';

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
import { Checkbox } from '@/components/ui/checkbox';
import {
  isImportableColorField,
  type BrandImportResult,
  type ImportableField,
} from '@/lib/app/questionnaire/brand-import/result';
import {
  MAX_STORED_CANDIDATES,
  describeSource,
  type BrandPalette,
} from '@/lib/app/questionnaire/brand-import/palette-record';
import type { BrandImageKind } from '@/lib/app/questionnaire/theming';

/**
 * Screenshots accepted in one import, mirroring the route's own cap.
 *
 * Held in both places on purpose: the server enforces it, and the form says it before the admin
 * picks a fourth file rather than after.
 */
const MAX_SCREENSHOTS = 3;

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
  canvasColorDark: 'Canvas colour (dark mode)',
  inkColorDark: 'Ink colour (dark mode)',
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

/** The multipart body. The address rides WITH the pictures, so one call sees both. */
function uploadBody(url: string, files: File[], demoClientId?: string): FormData {
  const body = new FormData();
  if (url) body.append('url', url);
  for (const file of files) body.append('file', file);
  if (demoClientId) body.append('demoClientId', demoClientId);
  return body;
}

interface BrandImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present on the edit form; absent on create, where images cannot be re-hosted yet. */
  demoClientId?: string;
  /** False when the server has no storage provider — image proposals degrade to a hotlink. */
  uploadEnabled?: boolean;
  /**
   * Write accepted proposals into form state. The parent owns which setter each field needs.
   *
   * The measured palette rides along with them rather than being applied separately: it is the
   * evidence for exactly these values, and persisting it on any other beat would let the strip on
   * the branding page describe a set of colours the admin declined. Null when the run measured
   * nothing (a blocked site), which clears a stale palette for the same reason.
   */
  onApply: (values: Partial<Record<ImportableField, string>>, palette: BrandPalette | null) => void;
}

export function BrandImportDialog({
  open,
  onOpenChange,
  demoClientId,
  uploadEnabled = false,
  onApply,
}: BrandImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BrandImportResult | null>(null);
  const [accepted, setAccepted] = useState<Set<ImportableField>>(new Set());
  /**
   * The palette this run measured, stamped at the moment the run RETURNED.
   *
   * Held apart from `result` because it carries two things the result does not: when we looked, and
   * what we looked at. Both are read off the request the admin actually submitted, which the inputs
   * above can still change afterwards — so it is captured here rather than composed on Apply from
   * fields that may by then say something else.
   */
  const [palette, setPalette] = useState<BrandPalette | null>(null);

  /** Images can only be re-hosted against a SAVED client, and only when storage exists. */
  const canRehost = Boolean(demoClientId) && uploadEnabled;

  const reset = () => {
    setResult(null);
    setPalette(null);
    setAccepted(new Set());
    setError(null);
  };

  const receive = (parsed: BrandImportResult, readFrom: string | null) => {
    setResult(parsed);
    // Capped on the way in as well as at the write boundary: a merged run over a site and three
    // screenshots can return more candidates than we keep, and silently posting a body the API
    // rejects would fail the whole save over the least important thing in it.
    setPalette(
      parsed.candidates.length > 0
        ? {
            candidates: parsed.candidates.slice(0, MAX_STORED_CANDIDATES),
            readFrom,
            capturedAt: new Date().toISOString(),
          }
        : null
    );
    // Pre-tick everything: the admin's job is to VETO what looks wrong, not to re-select what the
    // import already got right. Anything left ticked is what they were shown.
    setAccepted(new Set(Object.keys(parsed.fields) as ImportableField[]));
  };

  /**
   * Send whatever the admin has given us.
   *
   * Multipart when there are pictures — a JSON body cannot carry them — and JSON when there is only
   * an address, which is also the documented shape of the endpoint for anything but this dialog.
   * The route reads the two by content type, so the choice here is the whole protocol.
   */
  const runImport = async () => {
    const address = url.trim();
    if (!address && files.length === 0) return;

    reset();
    setBusy(true);
    try {
      const response =
        files.length > 0
          ? await fetch(API.APP.DEMO_CLIENTS.brandImport, {
              method: 'POST',
              body: uploadBody(address, files, demoClientId),
            })
          : await fetch(API.APP.DEMO_CLIENTS.brandImport, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: address, demoClientId }),
            });

      const parsed = await parseApiResponse<BrandImportResult>(response);
      if (!parsed.success) {
        // The server's rejection carries the actionable detail (too small, wrong type, rate
        // limited) — surface it verbatim rather than flattening it to "import failed".
        setError(parsed.error.message);
        return;
      }
      receive(parsed.data, describeSource(address, files.length));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : files.length > 0
            ? 'Could not read those screenshots.'
            : 'Could not read that website.'
      );
    } finally {
      setBusy(false);
      // Clear the input so re-picking the SAME file still fires a change event.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  /**
   * Take the files the admin picked, up to the cap.
   *
   * Truncating is SAID rather than done quietly: silently keeping three of five looks exactly like
   * an import that ignored two of the pictures they chose.
   */
  const addFiles = (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const chosen = [...files, ...Array.from(picked)];
    setFiles(chosen.slice(0, MAX_SCREENSHOTS));
    if (chosen.length > MAX_SCREENSHOTS) {
      setError(`Up to ${MAX_SCREENSHOTS} screenshots — we kept the first ${MAX_SCREENSHOTS}.`);
    }
    if (inputRef.current) inputRef.current.value = '';
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
    // Tracked locally as well as in state: `setError` does not update `error` until the next
    // render, so the close decision at the end of this function cannot read it.
    let said: string | null = null;
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
          said = demoClientId
            ? 'File storage is not configured, so custom typefaces could not be stored. Everything else was applied.'
            : 'Save the client first to store its typefaces. Everything else was applied.';
          setError(said);
        } else {
          const failure = await loadFonts(values.customFontDisplay, values.customFontBody);
          if (failure) {
            delete values.customFontDisplay;
            delete values.customFontBody;
            if (values.fontPairing === 'custom') delete values.fontPairing;
            said = `${failure} Everything else was applied — pick a typeface by hand.`;
            setError(said);
          }
        }
      }

      onApply(values, palette);
      // Stay open only when there is something to READ — the admin has to see why the type was
      // skipped. Keying this on "custom type was involved" instead kept the dialog open on the
      // SUCCESS path too, with nothing said: the admin's only cue was that it did not close, and
      // pressing Apply again re-ran the logo re-host and the Google Fonts fetch.
      if (!said) {
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

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runImport();
                }
              }}
              placeholder="acme.example"
              disabled={busy}
              className="max-w-xs"
              aria-label="Website address"
            />
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy || files.length >= MAX_SCREENSHOTS}
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="mr-2 h-4 w-4" />
              Add a screenshot
            </Button>
          </div>

          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((file, index) => (
                <li
                  key={`${file.name}-${index}`}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-xs"
                >
                  <span className="truncate">{file.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2"
                    disabled={busy}
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <Button
            type="button"
            onClick={() => void runImport()}
            disabled={busy || (!url.trim() && files.length === 0)}
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Globe className="mr-2 h-4 w-4" />
            )}
            Read the brand
          </Button>

          <p className="text-muted-foreground text-xs">
            An address, screenshots of the page, or both — both is the most reliable. Only the site
            names their logo and typeface; only a picture shows what the page is really painted in.
            Up to {MAX_SCREENSHOTS} screenshots, at least 320px on each side. Nothing is stored.
          </p>
        </div>

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
              {result.nextStep === 'screenshot' && files.length === 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => inputRef.current?.click()}
                >
                  Add a screenshot instead
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
