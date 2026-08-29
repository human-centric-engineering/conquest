/**
 * Unit tests: the screenshot entry point.
 *
 * The orchestration is thin, so the tests are about its failure behaviour: an import must never
 * throw at the admin for a condition the product has an answer to. An undecodable image, an
 * unseeded agent and an absent provider all have to arrive as a renderable result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const paletteMock = vi.hoisted(() => ({ extractPalette: vi.fn(), mergePalettes: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-import/palette', () => paletteMock);

const assignMock = vi.hoisted(() => ({ assignRoles: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-import/assign-roles', () => assignMock);

const harvestMock = vi.hoisted(() => ({ harvestSite: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-import/harvest', () => harvestMock);

import { analyseScreenshot, analyseUrl } from '@/lib/app/questionnaire/brand-import/analyse';

const CANDIDATES = [
  { hex: '#ffffff', share: 0.7, neutral: true },
  { hex: '#111114', share: 0.2, neutral: true },
  { hex: '#5469d4', share: 0.1, neutral: false },
];

const input = { buffer: Buffer.from('image'), mediaType: 'image/png' };

beforeEach(() => {
  vi.clearAllMocks();
  paletteMock.extractPalette.mockResolvedValue(CANDIDATES);
  assignMock.assignRoles.mockResolvedValue({
    assignments: [
      { field: 'canvasColor', hex: '#ffffff' },
      { field: 'inkColor', hex: '#111114' },
      { field: 'ctaColor', hex: '#5469d4' },
    ],
    provider: 'openai',
    model: 'gpt-test',
    sawImage: true,
  });
});

describe('analyseScreenshot', () => {
  it('proposes the assigned fields and marks them as read from the image', async () => {
    const result = await analyseScreenshot(input);

    expect(result.outcome).toBe('ok');
    expect(result.degraded).toBe(false);
    expect(result.fields.canvasColor).toEqual({
      value: '#ffffff',
      confidence: 'high',
      source: 'read from the screenshot',
    });
  });

  it('is `empty` when nothing could be measured, and never calls the model', async () => {
    paletteMock.extractPalette.mockResolvedValue([]);

    const result = await analyseScreenshot(input);

    expect(result.outcome).toBe('empty');
    expect(result.nextStep).toBe('manual');
    // No point paying for a role assignment over an empty list.
    expect(assignMock.assignRoles).not.toHaveBeenCalled();
  });

  it('degrades to the measured palette when no provider is available', async () => {
    assignMock.assignRoles.mockRejectedValue(new Error('No active LLM provider is configured'));

    const result = await analyseScreenshot(input);

    expect(result.degraded).toBe(true);
    expect(result.candidates).toEqual(CANDIDATES);
    expect(result.reason).toContain('no AI provider was available');
    // The colours survive even though the mapping did not — that is the point of degrading.
    expect(result.fields).toEqual({});
  });

  it('marks proposals as a guess when the model could not see the image', async () => {
    assignMock.assignRoles.mockResolvedValue({
      assignments: [{ field: 'canvasColor', hex: '#ffffff' }],
      provider: 'openai',
      model: 'gpt-test',
      sawImage: false,
    });

    const result = await analyseScreenshot(input);

    expect(result.fields.canvasColor?.confidence).toBe('low');
    expect(result.fields.canvasColor?.source).toContain('no image model');
  });

  it('annotates an unreadable canvas/ink pair without dropping either', async () => {
    assignMock.assignRoles.mockResolvedValue({
      assignments: [
        { field: 'canvasColor', hex: '#8a8a8a' },
        { field: 'inkColor', hex: '#9a9a9a' },
        { field: 'ctaColor', hex: '#5469d4' },
      ],
      provider: 'openai',
      model: 'gpt-test',
      sawImage: true,
    });

    const result = await analyseScreenshot(input);

    expect(result.fields.canvasColor?.caveat).toContain('WCAG AA');
    expect(result.fields.inkColor?.value).toBe('#9a9a9a');
  });

  it('passes the client id through for cost attribution', async () => {
    await analyseScreenshot({ ...input, demoClientId: 'dc-1' });

    expect(assignMock.assignRoles).toHaveBeenCalledWith(
      expect.objectContaining({ demoClientId: 'dc-1' })
    );
  });
});

/** A harvest that found everything, so each test can knock one thing out. */
function harvested(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    brand: {
      candidates: CANDIDATES,
      hints: ['The page declares theme-color: #5469d4'],
      declared: new Set(['#5469d4']),
      logo: { url: 'https://acme.example/logo.png', via: 'schema.org' },
      mark: { url: 'https://acme.example/touch.png', via: 'apple-touch-icon' },
      logoDark: null,
      fontFamilies: ['Space Grotesk'],
      note: null,
      ...overrides,
    },
  };
}

describe('analyseUrl', () => {
  beforeEach(() => {
    harvestMock.harvestSite.mockResolvedValue(harvested());
  });

  it('is `blocked` with the harvest’s own reason, and offers the screenshot', async () => {
    harvestMock.harvestSite.mockResolvedValue({
      ok: false,
      reason: 'That site refused our request (403) — many sites block automated readers.',
    });

    const result = await analyseUrl({ url: 'https://acme.example/' });

    expect(result.outcome).toBe('blocked');
    expect(result.nextStep).toBe('screenshot');
    expect(result.reason).toContain('403');
    // Nothing was measured, so nothing is offered — including no empty palette to imply otherwise.
    expect(result.candidates).toEqual([]);
  });

  it('proposes the logo and the mark it discovered', async () => {
    const result = await analyseUrl({ url: 'https://acme.example/' });

    expect(result.fields.logoUrl?.value).toBe('https://acme.example/logo.png');
    // A schema.org logo is the site asserting what its logo is, not us inferring it.
    expect(result.fields.logoUrl?.confidence).toBe('high');
    expect(result.fields.logoMarkUrl?.confidence).toBe('low');
  });

  it('proposes a typeface when the site loads one we ship', async () => {
    const result = await analyseUrl({ url: 'https://acme.example/' });

    expect(result.fields.fontPairing?.value).toBe('contemporary');
    expect(result.fields.fontPairing?.confidence).toBe('high');
    // An exact match reproduces the brand with a face we already have — nothing to fetch.
    expect(result.fields.customFontDisplay).toBeUndefined();
  });

  it('proposes the site’s own face rather than rounding it to the nearest pairing', async () => {
    harvestMock.harvestSite.mockResolvedValue(harvested({ fontFamilies: ['Poppins', 'Karla'] }));

    const result = await analyseUrl({ url: 'https://acme.example/' });

    // Rounding a brand's own face to "the closest grotesque we happen to load" is exactly what the
    // custom option exists to avoid.
    expect(result.fields.fontPairing?.value).toBe('custom');
    expect(result.fields.customFontDisplay?.value).toBe('Poppins');
    expect(result.fields.customFontBody?.value).toBe('Karla');
    // The families are names read off a page, not entries checked against a catalogue — the admin
    // is told that up front rather than discovering it when apply fails.
    expect(result.fields.fontPairing?.caveat).toContain('Google Fonts');
  });

  it('sets both slots from one family when the site names only one', async () => {
    harvestMock.harvestSite.mockResolvedValue(harvested({ fontFamilies: ['Poppins'] }));

    const result = await analyseUrl({ url: 'https://acme.example/' });

    expect(result.fields.customFontBody?.value).toBe('Poppins');
  });

  it('proposes no typeface at all when nothing places', async () => {
    harvestMock.harvestSite.mockResolvedValue(harvested({ fontFamilies: ['Wingdings'] }));

    const result = await analyseUrl({ url: 'https://acme.example/' });

    // `neutral` is a real choice an admin may have made; proposing it as a fallback would
    // overwrite that with a value we never measured.
    expect(result.fields.fontPairing).toBeUndefined();
  });

  it('marks a declared colour high and an inferred one low', async () => {
    assignMock.assignRoles.mockResolvedValue({
      assignments: [
        { field: 'ctaColor', hex: '#5469d4' },
        { field: 'canvasColor', hex: '#ffffff' },
      ],
      provider: 'openai',
      model: 'gpt-test',
      sawImage: false,
    });

    const result = await analyseUrl({ url: 'https://acme.example/' });

    // #5469d4 is in `declared` — the site named it. #ffffff was ranked out of pixels by a model
    // that could not see the page.
    expect(result.fields.ctaColor?.confidence).toBe('high');
    expect(result.fields.ctaColor?.source).toContain('declares');
    expect(result.fields.canvasColor?.confidence).toBe('low');
  });

  it('still proposes the logo when role assignment is unavailable', async () => {
    assignMock.assignRoles.mockRejectedValue(new Error('No active LLM provider is configured'));

    const result = await analyseUrl({ url: 'https://acme.example/' });

    expect(result.degraded).toBe(true);
    // Images and type are found by parsing, not by measuring, so they survive a missing provider.
    expect(result.fields.logoUrl).toBeDefined();
    expect(result.fields.fontPairing).toBeDefined();
    expect(result.candidates).toEqual(CANDIDATES);
  });

  it('never calls the model when the site gave up no colours', async () => {
    harvestMock.harvestSite.mockResolvedValue(harvested({ candidates: [] }));

    await analyseUrl({ url: 'https://acme.example/' });

    expect(assignMock.assignRoles).not.toHaveBeenCalled();
  });

  it('carries the budget note through, so a truncated harvest does not read as complete', async () => {
    harvestMock.harvestSite.mockResolvedValue(
      harvested({ note: 'Some of the site was not read — we stopped after 12 requests.' })
    );

    const result = await analyseUrl({ url: 'https://acme.example/' });

    expect(result.reason).toContain('12 requests');
  });

  it('passes the page’s own declarations to the analyst as context', async () => {
    await analyseUrl({ url: 'https://acme.example/', demoClientId: 'dc-1' });

    expect(assignMock.assignRoles).toHaveBeenCalledWith(
      expect.objectContaining({
        hints: ['The page declares theme-color: #5469d4'],
        demoClientId: 'dc-1',
      })
    );
  });
});
