import { describe, expect, it } from 'vitest';

import {
  parseExtractedPeople,
  extractPeopleSchema,
} from '@/lib/app/questionnaire/invitations/extract/extract-people-schema';
import {
  buildPeopleTextPrompt,
  buildPeopleImagePrompt,
} from '@/lib/app/questionnaire/invitations/extract/extract-people-prompt';

describe('parseExtractedPeople', () => {
  it('parses a valid object, lowercasing + dropping no-email + deduping', () => {
    const raw = JSON.stringify({
      people: [
        { email: 'Ada@X.com', firstName: 'Ada', jobTitle: 'Engineer' },
        { firstName: 'NoEmail' }, // dropped — no email
        { email: 'ada@x.com' }, // dup
        { email: 'grace@y.com', surname: 'Hopper' },
      ],
    });
    expect(parseExtractedPeople(raw)).toEqual([
      { email: 'ada@x.com', firstName: 'Ada', jobTitle: 'Engineer' },
      { email: 'grace@y.com', surname: 'Hopper' },
    ]);
  });

  it('tolerates a ```json fence', () => {
    const raw = '```json\n{"people":[{"email":"a@b.com"}]}\n```';
    expect(parseExtractedPeople(raw)).toEqual([{ email: 'a@b.com' }]);
  });

  it('returns null on unparseable JSON (triggers the repair retry)', () => {
    expect(parseExtractedPeople('not json')).toBeNull();
  });

  it('returns null when the shape is wrong', () => {
    expect(parseExtractedPeople(JSON.stringify({ nope: true }))).toBeNull();
  });

  it('drops entries with an email-shaped-but-invalid address', () => {
    expect(parseExtractedPeople(JSON.stringify({ people: [{ email: 'no-at-sign' }] }))).toEqual([]);
  });

  it('schema caps the people array', () => {
    const tooMany = { people: Array.from({ length: 501 }, () => ({ email: 'a@b.com' })) };
    expect(extractPeopleSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe('prompt builders', () => {
  it('text prompt is system + user carrying the document text', () => {
    const msgs = buildPeopleTextPrompt('Ada <ada@x.com>');
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    const content = msgs[1].content;
    expect(typeof content).toBe('string');
    expect(content as string).toContain('ada@x.com');
  });

  it('image prompt sends a multimodal user turn with the base64 image part', () => {
    const msgs = buildPeopleImagePrompt({ mediaType: 'image/png', data: 'BASE64' });
    const parts = msgs[1].content;
    expect(Array.isArray(parts)).toBe(true);
    const image = (parts as Array<{ type: string }>).find((p) => p.type === 'image');
    expect(image).toMatchObject({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: 'BASE64' },
    });
  });
});
