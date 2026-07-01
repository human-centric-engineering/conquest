/**
 * Config-health runner — unit tests.
 *
 * @see lib/config-health/run.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// env.NODE_ENV is read by the runner; mutate per test.
const envMock = vi.hoisted(() => ({ env: { NODE_ENV: 'production' } }));
vi.mock('@/lib/env', () => envMock);
vi.mock('@/lib/email/client', () => ({ isEmailEnabled: vi.fn(() => true) }));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  listProvidersWithStatus: vi.fn(async () => [{ apiKeyPresent: true }]),
}));

import { runConfigHealthChecks } from '@/lib/config-health/run';
import { isEmailEnabled } from '@/lib/email/client';
import { listProvidersWithStatus } from '@/lib/orchestration/llm/provider-manager';
import type { EvaluatedConfigCheck } from '@/lib/config-health/types';

type Mock = ReturnType<typeof vi.fn>;

function check(checks: EvaluatedConfigCheck[], key: string): EvaluatedConfigCheck {
  const found = checks.find((c) => c.key === key);
  if (!found) throw new Error(`check ${key} not found`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.env.NODE_ENV = 'production';
  (isEmailEnabled as Mock).mockReturnValue(true);
  (listProvidersWithStatus as Mock).mockResolvedValue([{ apiKeyPresent: true }]);
  // Healthy defaults; individual tests unset what they exercise.
  vi.stubEnv('CRON_SECRET', 'x'.repeat(40));
  vi.stubEnv('DATABASE_URL', 'postgresql://u:p@ep-x-pooler.aws.neon.tech:5432/db');
  vi.stubEnv('VERCEL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runConfigHealthChecks', () => {
  it('flags CRON_SECRET as a critical unmet check in production when unset', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const report = await runConfigHealthChecks();
    const cron = check(report.checks, 'CRON_SECRET');
    expect(cron.applicable).toBe(true);
    expect(cron.present).toBe(false);
    expect(cron.severity).toBe('critical');
    expect(report.summary.critical).toBe(1);
  });

  it('does NOT flag CRON_SECRET in development (productionOnly — dev has the in-process ticker)', async () => {
    envMock.env.NODE_ENV = 'development';
    vi.stubEnv('CRON_SECRET', '');
    const report = await runConfigHealthChecks();
    const cron = check(report.checks, 'CRON_SECRET');
    expect(cron.applicable).toBe(false);
    expect(cron.present).toBe(true); // not applicable → never flagged
    expect(report.summary.critical).toBe(0);
  });

  it('reports CRON_SECRET satisfied when set in production', async () => {
    const report = await runConfigHealthChecks();
    expect(check(report.checks, 'CRON_SECRET').present).toBe(true);
  });

  it('flags the email check when email is not configured', async () => {
    (isEmailEnabled as Mock).mockReturnValue(false);
    const report = await runConfigHealthChecks();
    const email = check(report.checks, 'email');
    expect(email.present).toBe(false);
    expect(email.severity).toBe('warning');
    expect(report.summary.warning).toBeGreaterThanOrEqual(1);
  });

  it('flags the LLM-provider check (critical) when no provider has its key set', async () => {
    (listProvidersWithStatus as Mock).mockResolvedValue([
      { apiKeyPresent: false },
      { apiKeyPresent: false },
    ]);
    const report = await runConfigHealthChecks();
    const provider = check(report.checks, 'llm_provider');
    expect(provider.present).toBe(false);
    expect(provider.severity).toBe('critical');
  });

  it('db_pooler is not applicable off Vercel', async () => {
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db'); // direct, but irrelevant off-serverless
    const report = await runConfigHealthChecks();
    expect(check(report.checks, 'db_pooler').applicable).toBe(false);
    expect(report.platform).toBe('other');
  });

  it('db_pooler flags a direct connection on Vercel and passes a pooled one', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@db.example.com:5432/db');
    let report = await runConfigHealthChecks();
    expect(report.platform).toBe('vercel');
    expect(check(report.checks, 'db_pooler').present).toBe(false);

    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@host.pooler.supabase.com:6543/db?pgbouncer=true');
    report = await runConfigHealthChecks();
    expect(check(report.checks, 'db_pooler').present).toBe(true);
  });

  it('never includes any config VALUE in the report (presence only)', async () => {
    const secret = 'super-secret-cron-value-not-a-boolean';
    vi.stubEnv('CRON_SECRET', secret);
    vi.stubEnv('DATABASE_URL', `postgresql://user:${secret}@ep-x-pooler.neon.tech:5432/db`);
    const report = await runConfigHealthChecks();
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('summarises applicable+unmet by severity and counts ok', async () => {
    vi.stubEnv('CRON_SECRET', ''); // critical
    (isEmailEnabled as Mock).mockReturnValue(false); // warning
    const report = await runConfigHealthChecks();
    expect(report.summary.critical).toBe(1);
    expect(report.summary.warning).toBeGreaterThanOrEqual(1);
    expect(report.summary.ok).toBeGreaterThanOrEqual(1); // llm_provider still satisfied
  });
});
