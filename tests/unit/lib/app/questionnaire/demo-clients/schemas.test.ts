import { describe, it, expect } from 'vitest';

import {
  assignDemoClientSchema,
  createDemoClientSchema,
  resetSessionsQuerySchema,
  resetSessionsSchema,
  updateDemoClientSchema,
} from '@/lib/app/questionnaire/demo-clients/schemas';

describe('createDemoClientSchema', () => {
  it('accepts a name-only body (slug derived later)', () => {
    const parsed = createDemoClientSchema.parse({ name: 'Acme Bank' });
    expect(parsed.name).toBe('Acme Bank');
    expect(parsed.slug).toBeUndefined();
  });

  it('requires a non-empty name', () => {
    expect(createDemoClientSchema.safeParse({}).success).toBe(false);
    expect(createDemoClientSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('accepts a valid kebab-case slug and rejects a malformed one', () => {
    expect(createDemoClientSchema.safeParse({ name: 'Acme', slug: 'acme-bank' }).success).toBe(
      true
    );
    expect(createDemoClientSchema.safeParse({ name: 'Acme', slug: 'Acme Bank' }).success).toBe(
      false
    );
  });

  it('coerces an empty description to null', () => {
    const parsed = createDemoClientSchema.parse({ name: 'Acme', description: '   ' });
    expect(parsed.description).toBeNull();
  });

  it('trims and keeps a non-empty description', () => {
    const parsed = createDemoClientSchema.parse({ name: 'Acme', description: '  Q1 pitch  ' });
    expect(parsed.description).toBe('Q1 pitch');
  });

  it('accepts the F3.4 theme fields and coerces empty ones to null', () => {
    const parsed = createDemoClientSchema.parse({
      name: 'Acme',
      ctaColor: '#5469d4',
      accentColor: '   ',
      logoUrl: 'https://acme.example/logo.png',
      welcomeCopy: '',
    });
    expect(parsed.ctaColor).toBe('#5469d4');
    expect(parsed.accentColor).toBeNull();
    expect(parsed.logoUrl).toBe('https://acme.example/logo.png');
    expect(parsed.welcomeCopy).toBeNull();
  });

  it('rejects an invalid theme colour / non-https logo', () => {
    expect(createDemoClientSchema.safeParse({ name: 'Acme', ctaColor: 'blue' }).success).toBe(
      false
    );
    expect(
      createDemoClientSchema.safeParse({ name: 'Acme', logoUrl: 'http://acme.example/l.png' })
        .success
    ).toBe(false);
  });
});

describe('updateDemoClientSchema', () => {
  it('accepts a single-field patch', () => {
    expect(updateDemoClientSchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('rejects an empty body (nothing to update)', () => {
    expect(updateDemoClientSchema.safeParse({}).success).toBe(false);
  });

  it('still validates the slug format when present', () => {
    expect(updateDemoClientSchema.safeParse({ slug: 'bad slug' }).success).toBe(false);
  });

  it('coerces an empty description to null and keeps a non-empty one', () => {
    expect(updateDemoClientSchema.parse({ description: '  ' }).description).toBeNull();
    expect(updateDemoClientSchema.parse({ description: ' note ' }).description).toBe('note');
  });

  it('accepts a theme-only patch and clears a field to null when blank', () => {
    expect(updateDemoClientSchema.safeParse({ ctaColor: '#000000' }).success).toBe(true);
    // A blank field is a deliberate "reset to Sunrise default" — coerced to null.
    expect(updateDemoClientSchema.parse({ welcomeCopy: '   ' }).welcomeCopy).toBeNull();
  });
});

describe('assignDemoClientSchema', () => {
  it('accepts a client id', () => {
    expect(assignDemoClientSchema.safeParse({ demoClientId: 'clx123' }).success).toBe(true);
  });

  it('accepts null to detach', () => {
    const parsed = assignDemoClientSchema.parse({ demoClientId: null });
    expect(parsed.demoClientId).toBeNull();
  });

  it('rejects an empty string and a missing field', () => {
    expect(assignDemoClientSchema.safeParse({ demoClientId: '' }).success).toBe(false);
    expect(assignDemoClientSchema.safeParse({}).success).toBe(false);
  });
});

describe('resetSessionsSchema (F6.4)', () => {
  it('accepts a kebab-case confirmSlug', () => {
    expect(resetSessionsSchema.parse({ confirmSlug: 'acme-bank' }).confirmSlug).toBe('acme-bank');
  });

  it('rejects a missing, empty, or non-kebab confirmSlug', () => {
    expect(resetSessionsSchema.safeParse({}).success).toBe(false);
    expect(resetSessionsSchema.safeParse({ confirmSlug: '' }).success).toBe(false);
    expect(resetSessionsSchema.safeParse({ confirmSlug: 'Acme Bank' }).success).toBe(false);
  });
});

describe('resetSessionsQuerySchema (F6.4)', () => {
  it('coerces "true" to true and "false"/absent to false', () => {
    expect(resetSessionsQuerySchema.parse({ resetInvitations: 'true' }).resetInvitations).toBe(
      true
    );
    expect(resetSessionsQuerySchema.parse({ resetInvitations: 'false' }).resetInvitations).toBe(
      false
    );
    expect(resetSessionsQuerySchema.parse({}).resetInvitations).toBe(false);
  });

  it('rejects a value that is neither "true" nor "false"', () => {
    expect(resetSessionsQuerySchema.safeParse({ resetInvitations: '1' }).success).toBe(false);
  });
});
