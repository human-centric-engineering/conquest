'use client';

/**
 * DEMO-ONLY (custom type): name the client's own typefaces and load them.
 *
 * The six pairings are a picker; this is the escape hatch for a brand with its own face. The admin
 * types two Google Fonts family names, we fetch the woff2 files once and store them, and the
 * respondent surface serves them back from our own origin.
 *
 * ## Why loading is a button and not part of Save
 *
 * Loading a family reaches out to a third party and writes files to storage. Folding that into the
 * form's PATCH would make an ordinary save slow, make it fail for a reason that has nothing to do
 * with the rest of the form, and leave orphaned objects behind whenever the admin abandoned an
 * edit. So it is an explicit action with its own result — the same "applies immediately" contract
 * `BrandImageField` has for uploads, and shown as plainly.
 *
 * The families and their files are written on load; `fontPairing` is not. That stays an ordinary
 * form field, so faces loaded here sit inert until the pairing is set to Custom — and switching the
 * picker away and back does not mean fetching Google again.
 *
 * There is no offline catalogue to validate a family against, so a name that does not exist comes
 * back from the server as an error naming it. That is both the check and the fetch.
 */

import { useState } from 'react';
import { Check, Loader2, Type, X } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { FormError } from '@/components/forms/form-error';

interface LoadedFonts {
  display: string | null;
  body: string | null;
  weights: Record<string, number[]>;
}

interface CustomFontFieldProps {
  /** Absent on the create form — there is no client to attach files to yet. */
  demoClientId?: string;
  /** False when the server has no storage provider configured. */
  uploadEnabled: boolean;
  /** Families already loaded for this client, from the row. */
  initialDisplay: string | null;
  initialBody: string | null;
  disabled?: boolean;
}

export function CustomFontField({
  demoClientId,
  uploadEnabled,
  initialDisplay,
  initialBody,
  disabled,
}: CustomFontFieldProps) {
  const [display, setDisplay] = useState(initialDisplay ?? '');
  const [body, setBody] = useState(initialBody ?? '');
  const [loaded, setLoaded] = useState<LoadedFonts | null>(
    initialDisplay || initialBody
      ? { display: initialDisplay, body: initialBody, weights: {} }
      : null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canLoad = Boolean(demoClientId) && uploadEnabled;

  const load = async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(API.APP.DEMO_CLIENTS.fonts(demoClientId as string), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display: display.trim(), body: body.trim() }),
      });
      const parsed = await parseApiResponse<LoadedFonts>(response);
      if (!parsed.success) {
        // The server names which family it could not find — surface it verbatim.
        setError(parsed.error.message);
        return;
      }
      setLoaded(parsed.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load those fonts.');
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setError(null);
    setBusy(true);
    try {
      await fetch(API.APP.DEMO_CLIENTS.fonts(demoClientId as string), { method: 'DELETE' });
      setLoaded(null);
      setDisplay('');
      setBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear those fonts.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border px-3 py-3">
      <div className="space-y-0.5">
        <Label className="flex items-center gap-1">
          The client&apos;s own typefaces
          <FieldHelp title="Custom typefaces">
            Two family names as Google Fonts spells them — &ldquo;Poppins&rdquo;, &ldquo;IBM Plex
            Sans&rdquo;. We download the files once and serve them from here, so the questionnaire
            is set in the brand&apos;s actual face and no respondent request ever reaches Google.
            Only used when the pairing above is set to Custom.
          </FieldHelp>
        </Label>
        <p className="text-muted-foreground text-xs">
          Loading applies immediately, like an image upload — it does not wait for Save.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="customFontDisplay" className="text-xs font-normal">
            Headings
          </Label>
          <Input
            id="customFontDisplay"
            value={display}
            onChange={(e) => setDisplay(e.target.value)}
            placeholder="Poppins"
            disabled={disabled || busy || !canLoad}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="customFontBody" className="text-xs font-normal">
            Body text
          </Label>
          <Input
            id="customFontBody"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Karla"
            disabled={disabled || busy || !canLoad}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || busy || !canLoad || (!display.trim() && !body.trim())}
          onClick={() => void load()}
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Type className="mr-2 h-4 w-4" />
          )}
          Load these fonts
        </Button>
        {loaded && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || busy}
            onClick={() => void clear()}
          >
            <X className="mr-1 h-4 w-4" />
            Clear
          </Button>
        )}
      </div>

      {loaded && (
        <p className="flex items-start gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Stored: {[loaded.display, loaded.body].filter(Boolean).join(' and ') || 'nothing'}
            {Object.values(loaded.weights).some((w) => w.length > 0) && (
              <>
                {' '}
                — weights{' '}
                {[...new Set(Object.values(loaded.weights).flat())]
                  .sort((a, b) => a - b)
                  .join(', ')}
              </>
            )}
            . Set the pairing above to <strong>Custom</strong> to use them.
          </span>
        </p>
      )}

      {!canLoad && (
        <p className="text-muted-foreground text-xs">
          {demoClientId
            ? 'File storage is not configured, so custom typefaces cannot be stored.'
            : 'Save the client first — the font files are stored against it.'}
        </p>
      )}

      <FormError message={error ?? undefined} />
    </div>
  );
}
