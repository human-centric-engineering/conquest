import { describe, it, expect } from 'vitest';

import {
  assignDemoClientSchema,
  createDemoClientSchema,
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
