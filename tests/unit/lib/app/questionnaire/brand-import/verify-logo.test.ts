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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';

const prismaMock = vi.hoisted(() => ({ aiAgent: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const providerMock = vi.hoisted(() => ({
  getProvider: vi.fn(async () => ({ name: 'test' })),
  assertModelSupportsAttachments: vi.fn(async () => undefined),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => providerMock);

const resolverMock = vi.hoisted(() => ({
  resolveAgentProviderAndModel: vi.fn(async () => ({
    providerSlug: 'openai',
    model: 'gpt-test',
    fallbacks: [],
  })),
}));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => resolverMock);

const completionMock = vi.hoisted(() => ({ runStructuredCompletion: vi.fn() }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => completionMock);

const logCostMock = vi.hoisted(() => ({ logAppLlmCost: vi.fn() }));
vi.mock('@/lib/app/questionnaire/llm/log-app-cost', () => logCostMock);

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: loggerMock }));

import { judge, namesMatch, verifyLogo } from '@/lib/app/questionnaire/brand-import/verify-logo';

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

/**
 * `verifyLogo` orchestration.
 *
 * `judge` and `namesMatch` above are exercised directly because they carry the actual matching
 * guarantee. This block covers the plumbing around them: resolving a vision-capable model,
 * thumbnailing candidates (real `sharp`, not mocked — a fake resize call would prove nothing about
 * whether an undecodable image is correctly dropped), and wiring the survivors' indices back onto
 * the ones the model was actually shown.
 */

/** A real, tiny, decodable PNG — built with sharp itself so `thumbnail()` genuinely runs. */
async function pngBuffer(fill: { r: number; g: number; b: number } = { r: 10, g: 20, b: 30 }) {
  return sharp({ create: { width: 20, height: 12, channels: 3, background: fill } })
    .png()
    .toBuffer();
}

/** Never decodes — sharp rejects it, so `thumbnail()` returns null for this candidate. */
const UNDECODABLE = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);

const AGENT_ROW = {
  id: 'agent-logo-1',
  provider: '',
  model: '',
  fallbackProviders: [],
  temperature: 0.2,
};

describe('verifyLogo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.aiAgent.findUnique.mockResolvedValue(AGENT_ROW);
    resolverMock.resolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'openai',
      model: 'gpt-test',
      fallbacks: [],
    });
    providerMock.assertModelSupportsAttachments.mockResolvedValue(undefined);
    providerMock.getProvider.mockResolvedValue({ name: 'test-provider' });
    completionMock.runStructuredCompletion.mockResolvedValue({
      value: { index: 0, wordmark: 'eagleeye' },
      tokenUsage: { input: 10, output: 5 },
    });
  });

  it('returns null without touching the database when there are no candidates', async () => {
    const verdict = await verifyLogo({ candidates: [], siteName: 'Eagle Eye' });

    expect(verdict).toBeNull();
    expect(prismaMock.aiAgent.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the brand_import agent has not been seeded', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);

    const verdict = await verifyLogo({
      candidates: [{ url: 'https://acme.example/logo.png', buffer: await pngBuffer() }],
      siteName: 'Acme',
    });

    expect(verdict).toBeNull();
    expect(completionMock.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('returns null when the provider/model cannot be resolved', async () => {
    resolverMock.resolveAgentProviderAndModel.mockRejectedValue(new Error('no active provider'));

    const verdict = await verifyLogo({
      candidates: [{ url: 'https://acme.example/logo.png', buffer: await pngBuffer() }],
      siteName: 'Acme',
    });

    expect(verdict).toBeNull();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.stringContaining('no vision model available'),
      expect.objectContaining({ error: expect.stringContaining('no active provider') })
    );
  });

  it('returns null when the resolved model has no vision — a sightless answer is not useful', async () => {
    providerMock.assertModelSupportsAttachments.mockRejectedValue(
      new Error('lacks capability: vision')
    );

    const verdict = await verifyLogo({
      candidates: [{ url: 'https://acme.example/logo.png', buffer: await pngBuffer() }],
      siteName: 'Acme',
    });

    expect(verdict).toBeNull();
    expect(completionMock.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('returns null when every candidate fails to thumbnail', async () => {
    const verdict = await verifyLogo({
      candidates: [
        { url: 'https://acme.example/broken-one.png', buffer: UNDECODABLE },
        { url: 'https://acme.example/broken-two.png', buffer: UNDECODABLE },
      ],
      siteName: 'Acme',
    });

    expect(verdict).toBeNull();
    expect(completionMock.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('drops a candidate that fails to thumbnail and re-indexes the survivors for the model', async () => {
    // Position 0 cannot be decoded and is dropped. The two survivors are shown to the model as
    // positions 0 and 1 — NOT their original positions 1 and 2 — so a verdict index of 1 must
    // resolve back to the original third candidate, not silently point at the dropped one.
    const survivor1 = { url: 'https://acme.example/logo-1.png', buffer: await pngBuffer() };
    const survivor2 = { url: 'https://acme.example/logo-2.png', buffer: await pngBuffer() };

    completionMock.runStructuredCompletion.mockResolvedValue({
      value: { index: 1, wordmark: 'acme' },
      tokenUsage: { input: 10, output: 5 },
    });

    const verdict = await verifyLogo({
      candidates: [
        { url: 'https://acme.example/broken.png', buffer: UNDECODABLE },
        survivor1,
        survivor2,
      ],
      siteName: 'Acme',
    });

    expect(verdict?.url).toBe(survivor2.url);

    // Only the two survivors were ever attached — the undecodable one never reached the prompt.
    const call = completionMock.runStructuredCompletion.mock.calls[0][0] as {
      messages: { role: string; content: unknown }[];
    };
    const parts = call.messages[1].content as { type: string }[];
    expect(parts.filter((part) => part.type === 'image')).toHaveLength(2);
  });

  it('builds the prompt with the text part first, then the images in order, naming the site', async () => {
    const one = { url: 'https://acme.example/logo.png', buffer: await pngBuffer() };

    await verifyLogo({ candidates: [one], siteName: 'Eagle Eye Solutions' });

    const call = completionMock.runStructuredCompletion.mock.calls[0][0] as {
      messages: { role: string; content: unknown }[];
    };
    expect(call.messages[0].role).toBe('system');
    expect(call.messages[1].role).toBe('user');

    const parts = call.messages[1].content as { type: string; text?: string }[];
    // Text first, then images — the model reads image indices as positional against this ordering.
    expect(parts[0].type).toBe('text');
    expect(parts.slice(1).every((part) => part.type === 'image')).toBe(true);
    expect(parts[0].text).toContain('Eagle Eye Solutions');
    // Singular phrasing for exactly one image.
    expect(parts[0].text).toContain('1 image follows');
  });

  it('uses plural phrasing for more than one image', async () => {
    const one = { url: 'https://acme.example/logo-a.png', buffer: await pngBuffer() };
    const two = { url: 'https://acme.example/logo-b.png', buffer: await pngBuffer() };

    await verifyLogo({ candidates: [one, two], siteName: 'Acme' });

    const call = completionMock.runStructuredCompletion.mock.calls[0][0] as {
      messages: { role: string; content: { type: string; text?: string }[] }[];
    };
    expect(call.messages[1].content[0].text).toContain('2 images follow');
  });

  it('rejects a reply that does not satisfy the verdict schema, so the completion retries', async () => {
    await verifyLogo({
      candidates: [{ url: 'https://acme.example/logo.png', buffer: await pngBuffer() }],
      siteName: 'Acme',
    });

    const call = completionMock.runStructuredCompletion.mock.calls[0][0] as {
      parse: (raw: string) => unknown;
    };

    // Missing the required `index` field entirely.
    expect(call.parse('{"wordmark":"acme"}')).toBeNull();
    // Not JSON at all.
    expect(call.parse('please pick logo 0')).toBeNull();
    // A well-formed reply still parses through the same callback.
    expect(call.parse('{"index":0,"wordmark":"acme"}')).toEqual({
      index: 0,
      wordmark: 'acme',
    });
  });

  it('logs spend against app_brand_import_logo with the number of attachable candidates', async () => {
    const { logAppLlmCost } = await import('@/lib/app/questionnaire/llm/log-app-cost');
    const one = { url: 'https://acme.example/logo-a.png', buffer: await pngBuffer() };
    const two = { url: 'https://acme.example/logo-b.png', buffer: await pngBuffer() };

    await verifyLogo({ candidates: [one, two], siteName: 'Acme', demoClientId: 'dc-9' });

    expect(logAppLlmCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ROW.id,
        capability: 'app_brand_import_logo',
        versionId: null,
        extra: expect.objectContaining({ candidates: 2, demoClientId: 'dc-9' }),
      })
    );
  });

  it('logs and returns null, rather than propagating, when the completion call throws', async () => {
    completionMock.runStructuredCompletion.mockRejectedValue(new Error('provider timed out'));

    const verdict = await verifyLogo({
      candidates: [{ url: 'https://acme.example/logo.png', buffer: await pngBuffer() }],
      siteName: 'Acme',
    });

    expect(verdict).toBeNull();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.stringContaining('did not complete'),
      expect.objectContaining({ error: expect.stringContaining('provider timed out') })
    );
  });

  it('produces a full high-confidence verdict end to end when the wordmark matches', async () => {
    completionMock.runStructuredCompletion.mockResolvedValue({
      value: { index: 0, wordmark: 'eagleeye', darkIndex: null },
      tokenUsage: { input: 10, output: 5 },
    });
    const only = { url: 'https://acme.example/logo.png', buffer: await pngBuffer() };

    const verdict = await verifyLogo({ candidates: [only], siteName: 'Eagle Eye Solutions' });

    expect(verdict).toEqual({
      url: only.url,
      confidence: 'high',
      reason: expect.stringContaining('eagleeye'),
      darkUrl: null,
    });
  });
});
