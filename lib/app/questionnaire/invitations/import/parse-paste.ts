/**
 * Heuristic parser for a pasted "scruffy list" of people — pure, no AI, no Prisma/Next.
 *
 * Pulls email addresses out of free text and best-effort-associates a name found on the same line
 * ("Ada Lovelace <ada@x.com>", "Ada Lovelace, ada@x.com", "ada@x.com"). Deliberately conservative:
 * it only emits what it can see, leaving the rest for the admin to fill in the verify grid. Dedups
 * by lowercased email (first occurrence wins). This is the no-AI import path.
 */

import type {
  ParsedInvitee,
  ParsedInviteeResult,
} from '@/lib/app/questionnaire/invitations/import/types';

// A pragmatic email matcher — good enough to lift addresses out of prose; the send path re-validates.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Strip the non-email remainder of a line down to a plausible display name, or '' if none. */
function nameFromRemainder(remainder: string): string {
  return remainder
    .replace(/mailto:/gi, ' ')
    .replace(/[<>(),;:"']/g, ' ') // delimiters around "Name <email>" / "Name, email" / "Team:"
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a display name into first + surname (first token vs the rest). */
function splitName(name: string): { firstName?: string; surname?: string } {
  if (!name) return {};
  const parts = name.split(' ').filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], surname: parts.slice(1).join(' ') };
}

/**
 * Parse a pasted blob into best-effort invitees. Each line is scanned for emails; the first email on
 * a line takes any name found on that line, extra emails on the same line come through name-less.
 */
export function parsePastedInvitees(text: string): ParsedInviteeResult {
  const byEmail = new Map<string, ParsedInvitee>();
  let withoutEmail = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const emails = line.match(EMAIL_RE);
    if (!emails || emails.length === 0) {
      // A non-empty line with no email — likely a stray header/note; count it for a soft warning.
      withoutEmail += 1;
      continue;
    }

    // The name (if any) belongs to the FIRST email on the line; strip every email out to find it.
    let remainder = line;
    for (const e of emails) remainder = remainder.split(e).join(' ');
    const name = nameFromRemainder(remainder);

    emails.forEach((rawEmail, i) => {
      const email = rawEmail.toLowerCase();
      if (byEmail.has(email)) return;
      byEmail.set(email, { email, ...(i === 0 ? splitName(name) : {}) });
    });
  }

  const warnings: string[] = [];
  if (byEmail.size === 0) warnings.push('No email addresses found in the pasted text.');
  if (withoutEmail > 0) {
    warnings.push(`${withoutEmail} line(s) had no email address and were skipped.`);
  }

  return { people: [...byEmail.values()], warnings };
}
