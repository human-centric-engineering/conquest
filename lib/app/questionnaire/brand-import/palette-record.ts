/**
 * Brand import — the measured palette, kept.
 *
 * An import measures a prospect's colours, shows them once in the dialog, and then throws them
 * away when the dialog closes. The proposals survive (they land in the form's colour boxes); the
 * evidence behind them does not — which is backwards, because the proposals are the cheap,
 * revisable half and the palette is the expensive, unrepeatable one. A week later an admin
 * wondering "was that navy actually on their site?" has no way to answer except to run the import
 * again against a site that may have been redesigned since.
 *
 * So the palette is persisted alongside the colours it produced, on `AppDemoClient.brandPalette`,
 * and the branding page renders it as a swatch strip under the import button.
 *
 * ## Why a Json column and not a table
 *
 * It is a snapshot, not a relation. Nothing joins to a candidate colour, nothing queries by hex,
 * and the whole record is read and written as one blob by one screen. A table would buy indexing
 * we have no query for and cost a second write path.
 *
 * ## Narrow on read, always
 *
 * `Json?` means the column can hold anything a seed, a rollback, or an older build put there. Every
 * read goes through {@link narrowBrandPalette}, which returns null rather than throwing for
 * anything it does not recognise: a malformed palette must degrade to "no strip on the page", never
 * to a crashed branding tab. That is the same forgiving-read / strict-write split
 * `customFontFiles` already uses on this table.
 *
 * Pure: no Prisma / Next / sharp. The route validates with the schema, the read model narrows with
 * the predicate, and the `'use client'` strip imports only the type.
 */

import { z } from 'zod';

import type { ColorCandidate } from '@/lib/app/questionnaire/brand-import/result';

/**
 * How many measured colours we keep.
 *
 * `extractPalette` returns twelve, and a merged run of a site plus three screenshots can return
 * more. Twenty-four is the point past which the strip stops being something an admin can scan, and
 * a cap on the WRITE boundary is what keeps an unbounded blob out of the row.
 */
export const MAX_STORED_CANDIDATES = 24;

/** Longest `readFrom` we store — a provenance line, not a URL we ever fetch again. */
export const READ_FROM_MAX = 200;

/**
 * The palette an import measured, as stored on the client.
 *
 * `readFrom` and `capturedAt` are what make the strip honest rather than decorative: a row of
 * hexes with no provenance invites the admin to trust colours read off a site that has since been
 * rebranded. Both are admin-facing.
 */
export interface BrandPalette {
  /** Every colour measured, ranked by share — the dialog's "Every colour we measured", kept. */
  candidates: ColorCandidate[];
  /**
   * Where it was read from, phrased for a human: `acme.example`, `2 screenshots`,
   * `acme.example + 2 screenshots`. Composed by the dialog, which is the only place that knows
   * what the admin actually submitted. Null when we could not name a source.
   */
  readFrom: string | null;
  /** ISO timestamp of the import that produced it — stamped when the admin applies, not on read. */
  capturedAt: string;
}

/**
 * One measured colour, on the write boundary.
 *
 * `share` is clamped to 0–1 rather than merely typed as a number: the value is rendered as a
 * percentage and as a swatch width, and a share of 40 (a caller that sent percent) would draw a
 * strip nobody could read.
 */
const candidateSchema = z.object({
  hex: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^#[0-9a-f]{6}$/, 'Must be a six-digit hex colour'),
  share: z.number().min(0).max(1),
  neutral: z.boolean(),
});

/**
 * The write boundary for the column.
 *
 * Strict where the read is forgiving, and for the usual reason: an admin's browser posting a
 * malformed palette should be told, while a value already IN the column must still render
 * something. `capturedAt` is validated as an ISO datetime rather than stamped server-side because
 * the palette was measured when the import RAN, not when the admin got round to saving the form.
 */
export const brandPaletteSchema = z.object({
  candidates: z.array(candidateSchema).min(1).max(MAX_STORED_CANDIDATES),
  readFrom: z.string().trim().max(READ_FROM_MAX).nullable(),
  capturedAt: z.iso.datetime(),
});

/**
 * Narrow a `Json` column value to a palette, or null.
 *
 * Never throws. A column holding a shape this build does not recognise means the branding page
 * shows no strip — which is exactly what a client that never ran an import shows, and therefore a
 * state the page already renders correctly.
 */
export function narrowBrandPalette(value: unknown): BrandPalette | null {
  const parsed = brandPaletteSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Compose the admin-facing `readFrom` line from what the import was actually given.
 *
 * Lives here rather than in the dialog so the phrasing is testable without rendering a React tree,
 * and so the two halves cannot drift from the {@link BrandPalette} contract they describe.
 */
export function describeSource(url: string, screenshotCount: number): string | null {
  const address = url
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const shots =
    screenshotCount > 0 ? `${screenshotCount} screenshot${screenshotCount === 1 ? '' : 's'}` : '';

  if (address && shots) return `${address} + ${shots}`;
  return address || shots || null;
}
