import { describe, expect, it } from 'vitest';

import { parseCsvInvitees, splitCsv } from '@/lib/app/questionnaire/invitations/import/parse-csv';

describe('splitCsv', () => {
  it('honours quoted fields with commas and escaped quotes', () => {
    const rows = splitCsv('a,"b,c","d""e"\n1,2,3');
    expect(rows).toEqual([
      ['a', 'b,c', 'd"e'],
      ['1', '2', '3'],
    ]);
  });

  it('drops fully-blank rows', () => {
    expect(splitCsv('a,b\n\n,\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('parseCsvInvitees', () => {
  it('maps header synonyms to fields', () => {
    const { people } = parseCsvInvitees(
      'First Name,Last Name,Email,Role,Department,Company\nAda,Lovelace,ada@x.com,Engineer,Platform,Acme'
    );
    expect(people).toEqual([
      {
        email: 'ada@x.com',
        firstName: 'Ada',
        surname: 'Lovelace',
        jobTitle: 'Engineer',
        team: 'Platform',
        organisation: 'Acme',
      },
    ]);
  });

  it('guesses the email column from content when headers are unhelpful', () => {
    const { people, warnings } = parseCsvInvitees('name,contact\nAda,ada@x.com');
    expect(people).toEqual([{ email: 'ada@x.com' }]);
    expect(warnings.some((w) => w.includes('guessed'))).toBe(true);
  });

  it('handles a headerless list of emails', () => {
    const { people } = parseCsvInvitees('ada@x.com\ngrace@y.com');
    expect(people).toEqual([{ email: 'ada@x.com' }, { email: 'grace@y.com' }]);
  });

  it('lowercases + dedupes by email and skips invalid rows', () => {
    const { people, warnings } = parseCsvInvitees('email\nAda@X.com\nnot-an-email\nada@x.com');
    expect(people).toEqual([{ email: 'ada@x.com' }]);
    expect(warnings.some((w) => w.includes('skipped'))).toBe(true);
  });
});
