'use client';

/**
 * DEMO-ONLY (brand import): propose a client's theme from a screenshot of their website.
 *
 * Branding a demo client by hand means a dozen fields copied out of a brand guideline. This reads
 * them off a picture of the prospect's own site instead: upload a screenshot, the server measures
 * the colours actually on the page and proposes which is the ground, the text, the button, the
 * accent — and the admin accepts the ones they want.
 *
 * ## Nothing is applied without a click, and nothing is saved
 *
 * Accepted proposals are written into FORM state via the parent's setters, exactly as if the admin
 * had typed them. They reach the database only on Save, and Cancel discards them — so an import is
 * always reversible and never surprises the admin with a live change. This is the same contract as
 * the house-rules suggester, and it is deliberate: the whole value of the feature is the admin
 * seeing what it proposed.
 *
 * ## Why failure gets as much of this component as success
 *
 * Reading a brand off an image fails often — a screenshot of a mostly-white marketing page has no
 * brand in it, and a deployment with no AI provider can measure colours but cannot say which is
 * which. Those are ordinary answers, so they arrive as a 200 with `outcome` and `nextStep` set, and
 * they render as guidance rather than as an error: the panel says what happened and what to do
 * next. A dead end that just says "failed" would send the admin back to typing hexes with no idea
 * whether a different screenshot would have worked.
 */

import { useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  isImportableColorField,
  type BrandImportResult,
  type ImportableField,
} from '@/lib/app/questionnaire/brand-import/result';

/**
 * Field → the label the form uses for it.
 *
 * Copied from the form's own labels rather than invented, so a proposal names the box the admin
 * will see it land in. "Surface colour" here and "Brand band" on the form would make the admin
 * hunt for a field that does not exist under that name.
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
};

interface BrandImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present on the edit form; absent on create, where it is only used for cost attribution. */
  demoClientId?: string;
  /** Write accepted proposals into form state. The parent owns which setter each field needs. */
  onApply: (values: Partial<Record<ImportableField, string>>) => void;
}

export function BrandImportDialog({
  open,
  onOpenChange,
  demoClientId,
  onApply,
}: BrandImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BrandImportResult | null>(null);
  const [accepted, setAccepted] = useState<Set<ImportableField>>(new Set());

  const reset = () => {
    setResult(null);
    setAccepted(new Set());
    setError(null);
  };

  const handleFile = async (file: File) => {
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
      setResult(parsed.data);
      // Pre-tick everything: the admin's job is to VETO what looks wrong, not to re-select what
      // the import already got right. Anything they leave ticked is what they were shown.
      setAccepted(new Set(Object.keys(parsed.data.fields) as ImportableField[]));
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

  const applyAccepted = () => {
    if (!result) return;
    const values: Partial<Record<ImportableField, string>> = {};
    for (const field of accepted) {
      const proposal = result.fields[field];
      if (proposal) values[field] = proposal.value;
    }
    onApply(values);
    onOpenChange(false);
    reset();
  };

  const proposals = result
    ? (Object.entries(result.fields) as [
        ImportableField,
        NonNullable<BrandImportResult['fields'][ImportableField]>,
      ][])
    : [];

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
          <DialogTitle>Import branding from a screenshot</DialogTitle>
          <DialogDescription>
            Upload a screenshot of the client&apos;s website. We measure the colours that are
            actually on the page and suggest which is which. Nothing is saved until you save the
            form.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
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
              {result ? 'Try another screenshot' : 'Choose a screenshot'}
            </Button>
            <p className="text-muted-foreground text-xs">
              A wide capture of the homepage works best — at least 320px on each side.
            </p>
          </div>

          {error && (
            <p
              className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-xs"
              role="alert"
            >
              {error}
            </p>
          )}

          {result && result.reason && (
            <p
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
              role="status"
            >
              {result.reason}
              {result.nextStep === 'manual' && ' Set the remaining fields by hand below.'}
              {result.nextStep === 'screenshot' &&
                ' Try a wider capture that includes the header and a button.'}
            </p>
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
                      <code className="text-muted-foreground text-xs">{proposal.value}</code>
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
            </div>
          )}

          {result && result.candidates.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Every colour we measured</p>
              <p className="text-muted-foreground text-xs">
                Ranked by how much of the screenshot they cover. Useful when a suggestion above is
                wrong — copy a hex into the field by hand.
              </p>
              <div className="flex flex-wrap gap-2">
                {result.candidates.map((candidate) => (
                  <span
                    key={candidate.hex}
                    className="flex items-center gap-1.5 rounded-md border px-2 py-1"
                    title={`${(candidate.share * 100).toFixed(1)}% of the image`}
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
            onClick={applyAccepted}
            disabled={accepted.size === 0}
            className={cn(accepted.size === 0 && 'pointer-events-none')}
          >
            Apply {accepted.size > 0 ? accepted.size : ''}{' '}
            {accepted.size === 1 ? 'field' : 'fields'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
