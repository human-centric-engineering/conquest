/**
 * CSV → invitees parser, pure (no AI, no Prisma/Next). Splits an RFC-4180-ish CSV, detects a header
 * row, maps columns to {@link ParsedInvitee} fields by header name (with sensible synonyms), and
 * falls back to content sniffing for the email column when headers are unhelpful. Dedups by
 * lowercased email. The send path re-validates — this only lifts structured rows into our shape.
 */

import type {
  ParsedInvitee,
  ParsedInviteeResult,
} from '@/lib/app/questionnaire/invitations/import/types';

type Field = Exclude<keyof ParsedInvitee, never>;

/** Header synonyms → our field. Compared case/space/punctuation-insensitively. */
const HEADER_SYNONYMS: Record<string, Field> = {
  email: 'email',
  emailaddress: 'email',
  firstname: 'firstName',
  first: 'firstName',
  forename: 'firstName',
  givenname: 'firstName',
  surname: 'surname',
  lastname: 'surname',
  last: 'surname',
  familyname: 'surname',
  jobtitle: 'jobTitle',
  title: 'jobTitle',
  role: 'jobTitle',
  position: 'jobTitle',
  team: 'team',
  department: 'team',
  dept: 'team',
  organisation: 'organisation',
  organization: 'organisation',
  org: 'organisation',
  company: 'organisation',
  employer: 'organisation',
};

const EMAIL_CELL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');

/** Split CSV text into rows of cells, honouring quoted fields, escaped quotes, and CRLF. */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  // Flush the trailing cell/row (file without a final newline).
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Resolve the column→field mapping from a header row (synonyms), or null if it's not a header. */
function mapHeader(header: string[]): (Field | null)[] | null {
  const mapped = header.map((h) => HEADER_SYNONYMS[norm(h)] ?? null);
  // A row is a header if it names at least one known field and contains no email-looking cell.
  const looksLikeData = header.some((c) => EMAIL_CELL_RE.test(c.trim()));
  return mapped.some(Boolean) && !looksLikeData ? mapped : null;
}

/** Index of the column whose cells are mostly emails (content fallback when no header). */
function sniffEmailColumn(rows: string[][]): number {
  const width = Math.max(0, ...rows.map((r) => r.length));
  let best = -1;
  let bestHits = 0;
  for (let c = 0; c < width; c++) {
    const hits = rows.filter((r) => EMAIL_CELL_RE.test((r[c] ?? '').trim())).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = c;
    }
  }
  return bestHits > 0 ? best : -1;
}

/** Parse CSV text into best-effort invitees + warnings. */
export function parseCsvInvitees(text: string): ParsedInviteeResult {
  const rows = splitCsv(text);
  if (rows.length === 0) return { people: [], warnings: ['The CSV was empty.'] };

  const warnings: string[] = [];
  const header = mapHeader(rows[0]);
  const dataRows = header ? rows.slice(1) : rows;

  let emailCol = header ? header.indexOf('email') : -1;
  if (emailCol === -1) {
    emailCol = sniffEmailColumn(dataRows);
    if (emailCol !== -1) {
      warnings.push('No clear "email" column header — guessed it from the data.');
    }
  }
  if (emailCol === -1) {
    return { people: [], warnings: ['Could not find an email column in the CSV.'] };
  }

  const byEmail = new Map<string, ParsedInvitee>();
  let skipped = 0;
  for (const r of dataRows) {
    const email = (r[emailCol] ?? '').trim().toLowerCase();
    if (!EMAIL_CELL_RE.test(email)) {
      skipped += 1;
      continue;
    }
    if (byEmail.has(email)) continue;
    const person: ParsedInvitee = { email };
    if (header) {
      header.forEach((field, c) => {
        if (!field || field === 'email') return;
        const v = (r[c] ?? '').trim();
        if (v) person[field] = v;
      });
    }
    byEmail.set(email, person);
  }

  if (byEmail.size === 0) warnings.push('No valid email rows found in the CSV.');
  if (skipped > 0) warnings.push(`${skipped} row(s) had no valid email and were skipped.`);
  return { people: [...byEmail.values()], warnings };
}
