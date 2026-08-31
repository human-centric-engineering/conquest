'use client';

/**
 * DEMO-ONLY (brand contrast): check whether a client's branding can actually be read, and offer to
 * fix it.
 *
 * The branding form warns about exactly one pairing — ink on canvas — and says nothing about the
 * rest, which is misleading rather than merely incomplete: an admin who sees no warning reasonably
 * concludes the theme is fine. It is not. The button label, the band title and the accent used for
 * links are all DERIVED, which reads as "handled automatically" and is not the same as "readable" —
 * a mid-tone brand colour has no label that clears AA, and an accent chosen against a cream page is
 * also the link colour in dark mode.
 *
 * ## What it proposes, and what it refuses to propose
 *
 * Every suggestion is a **shade of a colour already in the brand** — same hue, same saturation,
 * lightness moved as little as the arithmetic allows. That is the constraint the whole feature is
 * built around: an admin handed a brand does not want it replaced when it fails contrast, they want
 * the nearest version of it that passes.
 *
 * Where no shade works, the dialog says so instead of inventing one. "This needs a different
 * colour, not a lighter or darker one" is advice; a plausible substitute would be us overruling the
 * client's designer while looking like we had solved something.
 *
 * ## The same accept/veto contract as the import
 *
 * Proposals arrive pre-ticked, the admin vetoes what they disagree with, and Apply writes the
 * accepted ones into FORM state via the parent's setters — as if typed. The preview updates, Save
 * becomes enabled, Cancel discards. Nothing here touches a column.
 *
 * Each row shows before → after as swatches with their ratios, because a contrast proposal is only
 * judgeable next to what it replaces: the real question is not "does this pass" but "is this still
 * their brand".
 */

import { useState } from 'react';
import { Check, Loader2, ShieldAlert, Sparkles } from 'lucide-react';

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
import type {
  ContrastProposal,
  OptimisableField,
  OptimiseResult,
} from '@/lib/app/questionnaire/brand-contrast/result';
import type { ThemeFieldsInput } from '@/lib/app/questionnaire/theming';

interface ContrastOptimiseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The theme as the form holds it RIGHT NOW, including unsaved edits.
   *
   * Passed in rather than loaded server-side, and that is the point of the whole feature: an admin
   * presses this in the middle of adjusting colours, and auditing the saved row would check the
   * colours they have already moved on from.
   */
  theme: ThemeFieldsInput;
  /** Present on the edit form; absent on create. Cost attribution only. */
  demoClientId?: string;
  /** Write accepted proposals into form state. The parent owns which setter each field needs. */
  onApply: (values: Partial<Record<OptimisableField, string>>) => void;
}

/** A before/after swatch pair with its ratio, which is how a contrast proposal is read. */
function SwatchPair({
  ground,
  ink,
  ratio,
  label,
}: {
  ground: string;
  ink: string;
  ratio: number;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-flex h-7 w-11 shrink-0 items-center justify-center rounded border text-[0.6rem] font-semibold"
        style={{ backgroundColor: ground, color: ink }}
        aria-hidden
      >
        Aa
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">
        <span className="sr-only">{label} </span>
        {ratio.toFixed(1)}:1
      </span>
    </span>
  );
}

export function ContrastOptimiseDialog({
  open,
  onOpenChange,
  theme,
  demoClientId,
  onApply,
}: ContrastOptimiseDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OptimiseResult | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  const reset = () => {
    setResult(null);
    setAccepted(new Set());
    setError(null);
  };

  const run = async () => {
    reset();
    setBusy(true);
    try {
      const response = await fetch(API.APP.DEMO_CLIENTS.optimiseContrast, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme, demoClientId }),
      });
      const parsed = await parseApiResponse<OptimiseResult>(response);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      setResult(parsed.data);
      // Pre-ticked, as the import's proposals are: the admin's job is to veto what they disagree
      // with, not to re-select fixes they have just been told are necessary.
      setAccepted(new Set(parsed.data.proposals.map((_, index) => index)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check this theme.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (index: number) => {
    setAccepted((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const applyAccepted = () => {
    if (!result) return;
    const values: Partial<Record<OptimisableField, string>> = {};
    for (const index of [...accepted].sort((a, b) => a - b)) {
      const proposal = result.proposals[index];
      if (!proposal) continue;
      const repair = proposal.repairs[proposal.chosen];
      // Last write wins where two accepted proposals touch one field — which happens: the accent
      // fails on both grounds, and both findings are repaired by shading the same colour. The
      // repairs are solved against BOTH grounds, so either value is correct and identical; taking
      // the last simply avoids pretending there is a choice to make.
      values[repair.field] = repair.to;
    }
    onApply(values);
    onOpenChange(false);
    reset();
  };

  const proposals = result?.proposals ?? [];

  /**
   * How many FIELDS the accepted proposals would change, which is not the same as how many
   * proposals are ticked.
   *
   * The accent fails on both grounds as two findings, and both are repaired by shading one colour
   * — solved against both grounds, so the two repairs are the same value. "Apply 2 changes" for one
   * moved field overstates what the button does; counting fields does not.
   */
  const changedFields = new Set(
    [...accepted].map((index) => {
      const proposal = result?.proposals[index];
      return proposal?.repairs[proposal.chosen].field;
    })
  ).size;

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
          <DialogTitle>Check the colours can be read</DialogTitle>
          <DialogDescription>
            We measure every pairing a respondent actually sees — the page, the button, the header
            band, the links — and suggest the nearest shade of your own colours that clears the
            legibility threshold. Suggestions until you save the form.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Button type="button" onClick={() => void run()} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            {result ? 'Check again' : 'Check contrast'}
          </Button>

          {error && (
            <p
              className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-xs"
              role="alert"
            >
              {error}
            </p>
          )}

          {result && (
            <p
              className={
                result.outcome === 'clean'
                  ? 'rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200'
                  : 'text-muted-foreground text-xs'
              }
              role="status"
            >
              {result.outcome === 'clean' && <Check className="mr-1 inline h-3 w-3" aria-hidden />}
              {result.summary}
            </p>
          )}

          {proposals.length > 0 && (
            <div className="space-y-2">
              {proposals.map((proposal, index) => (
                <ProposalRow
                  key={proposal.finding.pair}
                  proposal={proposal}
                  checked={accepted.has(index)}
                  onToggle={() => toggle(index)}
                />
              ))}
            </div>
          )}

          {result && result.unfixable.length > 0 && (
            <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
              <p className="flex items-center gap-1.5 font-medium">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                Needs a different colour, not a different shade
              </p>
              <ul className="space-y-1">
                {result.unfixable.map((finding) => (
                  <li key={finding.pair}>
                    {finding.label} — {finding.ratio.toFixed(1)}:1, needs {finding.target}:1. No
                    lighter or darker version of these colours clears it.
                  </li>
                ))}
              </ul>
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
            disabled={accepted.size === 0 || proposals.length === 0}
          >
            Apply {changedFields > 0 ? changedFields : ''}{' '}
            {changedFields === 1 ? 'change' : 'changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProposalRow({
  proposal,
  checked,
  onToggle,
}: {
  proposal: ContrastProposal;
  checked: boolean;
  onToggle: () => void;
}) {
  const { finding } = proposal;
  const repair = proposal.repairs[proposal.chosen];
  // A real `htmlFor`/`id` association rather than relying on nesting alone. Radix renders the
  // checkbox as a `button`, which IS a labelable element, so the whole row becomes a click target
  // for the control AND the association is one assistive tech can follow. `aria-label` stays: it
  // gives the control a short name instead of the row's whole paragraph of detail.
  const controlId = `contrast-fix-${finding.pair}`;

  return (
    <label
      htmlFor={controlId}
      className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2"
    >
      <Checkbox
        id={controlId}
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={`Apply the fix for ${finding.label}`}
        className="mt-1"
      />
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{finding.label}</span>
          <span className="text-muted-foreground text-xs">
            · changes <strong className="font-medium">{repair.label}</strong>
            {repair.from === null && ' (currently unset)'}
          </span>
        </span>

        <span className="flex flex-wrap items-center gap-2">
          <SwatchPair
            ground={finding.ground}
            ink={finding.ink}
            ratio={finding.ratio}
            label="Currently"
          />
          <span className="text-muted-foreground text-xs" aria-hidden>
            →
          </span>
          <SwatchPair
            ground={repair.resultingGround}
            ink={repair.resultingInk}
            ratio={repair.ratio}
            label="Becomes"
          />
          <code className="text-muted-foreground text-xs">
            {repair.current} → {repair.to}
          </code>
        </span>

        <span className="text-muted-foreground block text-xs">{proposal.rationale}</span>
      </span>
    </label>
  );
}
