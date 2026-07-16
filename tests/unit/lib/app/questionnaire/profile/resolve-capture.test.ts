/**
 * Unit test: respondent profile capture resolution (F-capture).
 *
 * `resolveSessionCapture` owns the identity-axis decision (the PII-safety gate): capture keys off
 * `anonymousMode`, NOT authed-vs-public. It also owns the FORM-gate half of a version's fields — the
 * `formFields` subset (per-field `captureVia`, else the `captureMode` default). These tests exercise
 * that logic for real (only Prisma is mocked) — the anonymous → null gate, the `formFields` split
 * (incl. a hybrid version), the `satisfied` derivation (snapshot / no form subset), and the
 * captureMode narrowing — since every other suite mocks this resolver.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSession: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { resolveSessionCapture } from '@/lib/app/questionnaire/profile/resolve-capture';

const FIELDS = [{ key: 'name', label: 'Name', type: 'text', required: true, validation: 'hybrid' }];

/** Build the session→version→config shape `resolveSessionCapture` selects. */
function sessionRow(opts: {
  anonymousMode?: boolean;
  profileFields?: unknown;
  captureMode?: string | null;
  hasSnapshot?: boolean;
  noConfig?: boolean;
}) {
  return {
    profileSnapshot: opts.hasSnapshot ? { id: 'snap-1' } : null,
    version: {
      config: opts.noConfig
        ? null
        : {
            anonymousMode: opts.anonymousMode ?? false,
            profileFields: opts.profileFields ?? FIELDS,
            captureMode: opts.captureMode ?? 'form',
          },
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('resolveSessionCapture', () => {
  it('returns null when the session does not resolve', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(null);
    expect(await resolveSessionCapture('s1')).toBeNull();
  });

  it('returns null for an anonymous version (the PII-free invariant — no gate, ever)', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(
      sessionRow({ anonymousMode: true })
    );
    expect(await resolveSessionCapture('s1')).toBeNull();
  });

  it('treats an absent config as anon-safe (null)', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(sessionRow({ noConfig: true }));
    expect(await resolveSessionCapture('s1')).toBeNull();
  });

  it('resolves a non-anonymous form-mode version with fields as NOT satisfied (gate shows)', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(sessionRow({}));
    const result = await resolveSessionCapture('s1');
    expect(result).toEqual({
      captureMode: 'form',
      formFields: [{ ...FIELDS[0], validation: 'hybrid' }],
      satisfied: false,
    });
  });

  it('splits a HYBRID version — only the form-placement fields are in formFields (gate shows for those)', async () => {
    // Default mode conversational; `name` overrides to `form`, `org` inherits conversational. The gate
    // collects only `name`; `org` is left to the interviewer and never reaches formFields.
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(
      sessionRow({
        captureMode: 'conversational',
        profileFields: [
          {
            key: 'name',
            label: 'Name',
            type: 'text',
            required: true,
            validation: 'deterministic',
            captureVia: 'form',
          },
          {
            key: 'org',
            label: 'Organisation',
            type: 'text',
            required: false,
            validation: 'agentic',
          },
        ],
      })
    );
    const result = await resolveSessionCapture('s1');
    expect(result?.captureMode).toBe('conversational');
    expect(result?.formFields.map((f) => f.key)).toEqual(['name']);
    expect(result?.satisfied).toBe(false);
  });

  it('is satisfied when a snapshot already exists (resume — gate skipped)', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(
      sessionRow({ hasSnapshot: true })
    );
    expect((await resolveSessionCapture('s1'))?.satisfied).toBe(true);
  });

  it('is satisfied for an all-conversational version — no form subset, so no gate', async () => {
    // The single field inherits the conversational default, leaving formFields empty → satisfied.
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(
      sessionRow({ captureMode: 'conversational' })
    );
    const result = await resolveSessionCapture('s1');
    expect(result?.captureMode).toBe('conversational');
    expect(result?.formFields).toEqual([]);
    expect(result?.satisfied).toBe(true);
  });

  it('is satisfied when there are no fields to collect', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(
      sessionRow({ profileFields: [] })
    );
    expect((await resolveSessionCapture('s1'))?.satisfied).toBe(true);
  });

  it('narrows an unknown stored captureMode back to the form default', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(
      sessionRow({ captureMode: 'telepathy' })
    );
    expect((await resolveSessionCapture('s1'))?.captureMode).toBe('form');
  });
});
