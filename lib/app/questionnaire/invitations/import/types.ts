/**
 * Shared shape for an invitee parsed/extracted by any import method (paste, CSV, PDF, image).
 *
 * The common currency the import wizard's three input steps converge on before the editable verify
 * grid. Email is the only guaranteed field; the rest are best-effort. Distinct from the validated
 * send payload (`schemas.ts` recipient) — this is the unvalidated, pre-review parse result.
 */
export interface ParsedInvitee {
  email: string;
  firstName?: string;
  surname?: string;
  jobTitle?: string;
  team?: string;
  organisation?: string;
}

/** A parse/extract outcome: the people found plus any soft warnings to surface in the grid. */
export interface ParsedInviteeResult {
  people: ParsedInvitee[];
  warnings: string[];
}
