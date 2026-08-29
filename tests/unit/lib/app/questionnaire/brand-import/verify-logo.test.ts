/**
 * Unit tests: checking that a candidate lockup is actually the company's.
 *
 * Written after a real import proposed a circular **Forbes** logo for a company called Eagle Eye
 * Solutions. Every signal the harvest can see was satisfied — the file was named like a logo and it
 * sat above the fold — and none of them could answer the question a person answers instantly:
 * does it say the company's name?
 *
 * The split under test is the same one the colour analyst uses. The model READS the wordmark, which
 * is a transcription task; the code MATCHES it against the site's name. A model asked "is this
 * their logo?" agrees; a model asked "what does it say?" answers "Forbes", and no string comparison
 * turns that into "Eagle Eye Solutions".
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
  assertModelSupportsAttachments: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/llm/log-app-cost', () => ({ logAppLlmCost: vi.fn() }));

import { judge, namesMatch } from '@/lib/app/questionnaire/brand-import/verify-logo';

const CANDIDATES = [
  { candidate: { url: 'https://acme.example/forbes.svg', buffer: Buffer.from('a') }, index: 0 },
  { candidate: { url: 'https://acme.example/logo.svg', buffer: Buffer.from('b') }, index: 1 },
  { candidate: { url: 'https://acme.example/logo-white.svg', buffer: Buffer.from('c') }, index: 2 },
];

describe('namesMatch', () => {
  it('matches a lockup against a longer legal name', () => {
    // The case from the report. A wordmark is set as artwork: its spacing, casing and punctuation
    // carry nothing about whose it is.
    expect(namesMatch('eagleeye', 'Eagle Eye Solutions')).toBe(true);
    expect(namesMatch('Eagle Eye', 'eagleeye.com')).toBe(true);
  });

  it('matches a longer lockup against a shorter site name', () => {
    expect(namesMatch('Acme Corporation', 'Acme')).toBe(true);
  });

  it('rejects a different company outright', () => {
    expect(namesMatch('Forbes', 'Eagle Eye Solutions')).toBe(false);
    expect(namesMatch('G2', 'Eagle Eye Solutions')).toBe(false);
  });

  it('refuses to match on nothing', () => {
    // Without a site name there is no claim to check, so "matched" would be a lie.
    expect(namesMatch('Forbes', null)).toBe(false);
    expect(namesMatch('', 'Acme')).toBe(false);
    // A single character matches almost anything by containment.
    expect(namesMatch('E', 'Eagle Eye')).toBe(false);
  });
});

describe('judge', () => {
  it('proposes the chosen logo at high confidence when the wordmark names the company', () => {
    const verdict = judge({ index: 1, wordmark: 'eagleeye' }, CANDIDATES, 'Eagle Eye Solutions');

    expect(verdict.url).toBe('https://acme.example/logo.svg');
    expect(verdict.confidence).toBe('high');
    // What it read is shown to the admin so they can disagree at a glance.
    expect(verdict.reason).toContain('eagleeye');
  });

  it('proposes NOTHING when the wordmark is another company', () => {
    // The Forbes case. A wrong logo at "low confidence" is still a wrong logo, and the failure
    // being fixed is an admin accepting one without looking.
    const verdict = judge({ index: 0, wordmark: 'Forbes' }, CANDIDATES, 'Eagle Eye Solutions');

    expect(verdict.url).toBeNull();
    expect(verdict.reason).toContain('Forbes');
    expect(verdict.reason).toContain('Eagle Eye Solutions');
  });

  it('accepts a graphical mark at low confidence rather than rejecting it', () => {
    // Most abstract logos have no readable text. That is not evidence against them.
    const verdict = judge({ index: 1, wordmark: null }, CANDIDATES, 'Eagle Eye Solutions');

    expect(verdict.url).toBe('https://acme.example/logo.svg');
    expect(verdict.confidence).toBe('low');
    expect(verdict.reason).toContain('could not read');
  });

  it('treats a blank wordmark as no wordmark', () => {
    expect(judge({ index: 1, wordmark: '   ' }, CANDIDATES, 'Acme').confidence).toBe('low');
  });

  it('proposes nothing when the model says none of them is the logo', () => {
    const verdict = judge({ index: null }, CANDIDATES, 'Eagle Eye Solutions');

    expect(verdict.url).toBeNull();
    expect(verdict.reason).toContain('None of the images');
  });

  it('refuses an index that is not one of the images it was shown', () => {
    // The indices in the prompt are positional; a reply outside the range is not a candidate.
    expect(judge({ index: 7, wordmark: 'eagleeye' }, CANDIDATES, 'Eagle Eye').url).toBeNull();
    expect(judge({ index: -1, wordmark: 'eagleeye' }, CANDIDATES, 'Eagle Eye').url).toBeNull();
  });
});

describe('judge — the dark lockup', () => {
  /*
   * The dark slot is where a bad pick does the most damage: the header band prefers the dark lockup
   * whenever its ground is dark, so a wrong image there replaces the right one everywhere a branded
   * client actually looks. It is checked in the same call rather than trusted from a filename.
   */
  it('proposes the dark variant alongside an accepted lockup', () => {
    const verdict = judge(
      { index: 1, wordmark: 'eagleeye', darkIndex: 2 },
      CANDIDATES,
      'Eagle Eye Solutions'
    );

    expect(verdict.url).toBe('https://acme.example/logo.svg');
    expect(verdict.darkUrl).toBe('https://acme.example/logo-white.svg');
  });

  it('proposes no dark variant when the lockup itself was rejected', () => {
    // A "dark version" of somebody else's logo is not a thing worth proposing.
    const verdict = judge(
      { index: 0, wordmark: 'Forbes', darkIndex: 2 },
      CANDIDATES,
      'Eagle Eye Solutions'
    );

    expect(verdict.url).toBeNull();
    expect(verdict.darkUrl).toBeNull();
  });

  it('treats a repeated index as "there isn’t one"', () => {
    const verdict = judge(
      { index: 1, wordmark: 'eagleeye', darkIndex: 1 },
      CANDIDATES,
      'Eagle Eye'
    );
    expect(verdict.darkUrl).toBeNull();
  });

  it('ignores a dark index outside the images it was shown', () => {
    expect(
      judge({ index: 1, wordmark: 'eagleeye', darkIndex: 9 }, CANDIDATES, 'Eagle Eye').darkUrl
    ).toBeNull();
  });

  it('leaves the dark slot empty when the model says there is none', () => {
    expect(
      judge({ index: 1, wordmark: 'eagleeye', darkIndex: null }, CANDIDATES, 'Eagle Eye').darkUrl
    ).toBeNull();
  });
});
