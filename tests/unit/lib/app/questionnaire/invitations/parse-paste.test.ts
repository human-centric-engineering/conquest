import { describe, expect, it } from 'vitest';

import { parsePastedInvitees } from '@/lib/app/questionnaire/invitations/import/parse-paste';

describe('parsePastedInvitees', () => {
  it('extracts "Name <email>" with first/surname split', () => {
    const { people } = parsePastedInvitees('Ada Lovelace <ada@example.com>');
    expect(people).toEqual([{ email: 'ada@example.com', firstName: 'Ada', surname: 'Lovelace' }]);
  });

  it('handles comma- and space-separated name/email and bare emails', () => {
    const { people } = parsePastedInvitees(
      'Grace Hopper, grace@navy.mil\nbare@example.com\nAlan alan@x.com'
    );
    expect(people).toEqual([
      { email: 'grace@navy.mil', firstName: 'Grace', surname: 'Hopper' },
      { email: 'bare@example.com' },
      { email: 'alan@x.com', firstName: 'Alan' },
    ]);
  });

  it('lowercases + dedupes by email (first occurrence wins)', () => {
    const { people } = parsePastedInvitees('Ada <Ada@Example.com>\nada@example.com');
    expect(people).toHaveLength(1);
    expect(people[0]).toEqual({ email: 'ada@example.com', firstName: 'Ada' });
  });

  it('gives only the first email on a line the name; extras come through name-less', () => {
    const { people } = parsePastedInvitees('Team: lead@x.com, second@x.com');
    expect(people).toEqual([{ email: 'lead@x.com', firstName: 'Team' }, { email: 'second@x.com' }]);
  });

  it('warns when nothing parses and when lines are skipped', () => {
    expect(parsePastedInvitees('just a heading\nno emails here').warnings).toContain(
      'No email addresses found in the pasted text.'
    );
    const mixed = parsePastedInvitees('a header line\nada@example.com');
    expect(mixed.people).toHaveLength(1);
    expect(mixed.warnings.some((w) => w.includes('no email address'))).toBe(true);
  });
});
