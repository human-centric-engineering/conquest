/**
 * Unit tests: the brand-import entry point.
 *
 * The orchestration is thin, so the tests are about its failure behaviour: an import must never
 * throw at the admin for a condition the product has an answer to. An undecodable image, an
 * unseeded agent and an absent provider all have to arrive as a renderable result.
 *
 * One entry point takes an address, screenshots, or both, so each source is exercised on its own
 * and then together — the combined case is where the evidence rules actually differ.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const paletteMock = vi.hoisted(() => ({ extractPalette: vi.fn(), mergePalettes: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-import/palette', () => paletteMock);

const assignMock = vi.hoisted(() => ({ assignRoles: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-import/assign-roles', () => assignMock);

const harvestMock = vi.hoisted(() => ({ harvestSite: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-import/harvest', () => harvestMock);

const logoMock = vi.hoisted(() => ({ verifyLogo: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-import/verify-logo', () => logoMock);

import { analyseBrand } from '@/lib/app/questionnaire/brand-import/analyse';

const CANDIDATES = [
  { hex: '#ffffff', share: 0.7, neutral: true },
  { hex: '#111114', share: 0.2, neutral: true },
  { hex: '#5469d4', share: 0.1, neutral: false },
];

/**
 * A screenshot is now just its bytes: `assignRoles` resizes and re-encodes them itself, so the
 * detected media type stops at the route's magic-byte gate rather than travelling with the frame.
 */
const SHOT = Buffer.from('image');
const input = { screenshots: [SHOT] };

beforeEach(() => {
  vi.clearAllMocks();
  paletteMock.extractPalette.mockResolvedValue(CANDIDATES);
  // A stand-in for the real merge, which has its own tests. Concatenating keeps every candidate
  // identifiable in an assertion, which is what these tests are about — the merge arithmetic is
  // not.
  paletteMock.mergePalettes.mockImplementation((sources: { candidates: unknown[] }[]) =>
    sources.flatMap((source) => source.candidates)
  );
  assignMock.assignRoles.mockResolvedValue({
    assignments: [
      { field: 'canvasColor', hex: '#ffffff' },
      { field: 'inkColor', hex: '#111114' },
      { field: 'ctaColor', hex: '#5469d4' },
    ],
    provider: 'openai',
    model: 'gpt-test',
    sawImages: true,
  });
});

describe('analyseBrand: screenshots only', () => {
  it('proposes the assigned fields and marks them as read from the image', async () => {
    const result = await analyseBrand(input);

    expect(result.outcome).toBe('ok');
    expect(result.degraded).toBe(false);
    expect(result.fields.canvasColor).toEqual({
      value: '#ffffff',
      confidence: 'high',
      source: 'measured from your screenshot',
    });
  });

  it('is `empty` when nothing could be measured, and never calls the model', async () => {
    paletteMock.extractPalette.mockResolvedValue([]);

    const result = await analyseBrand(input);

    expect(result.outcome).toBe('empty');
    expect(result.nextStep).toBe('manual');
    // No point paying for a role assignment over an empty list.
    expect(assignMock.assignRoles).not.toHaveBeenCalled();
  });

  it('degrades to the measured palette when no provider is available', async () => {
    assignMock.assignRoles.mockRejectedValue(new Error('No active LLM provider is configured'));

    const result = await analyseBrand(input);

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
      sawImages: false,
    });

    const result = await analyseBrand(input);

    expect(result.fields.canvasColor?.confidence).toBe('low');
    expect(result.fields.canvasColor?.source).toContain('no image model');
  });

  it('replaces an ink that cannot be read on the canvas we measured', async () => {
    assignMock.assignRoles.mockResolvedValue({
      assignments: [
        { field: 'canvasColor', hex: '#8a8a8a' },
        { field: 'inkColor', hex: '#9a9a9a' },
        { field: 'ctaColor', hex: '#5469d4' },
      ],
      provider: 'openai',
      model: 'gpt-test',
      sawImages: true,
    });

    const result = await analyseBrand(input);

    // The form WARNS about a low-contrast pair the admin typed, because a brand may genuinely be
    // low-contrast and refusing would overrule their designer. An imported pair is nobody's
    // decision yet, so shipping it only sets up a mistake the admin has to catch.
    expect(result.fields.canvasColor?.value).toBe('#8a8a8a');
    expect(result.fields.inkColor?.value).not.toBe('#9a9a9a');
    expect(result.fields.inkColor?.source).toContain('would not have read');
  });

  it('fills both grounds and both inks, so the dark pair is reviewable', async () => {
    assignMock.assignRoles.mockResolvedValue({
      assignments: [{ field: 'canvasColor', hex: '#691b9a' }],
      provider: 'openai',
      model: 'gpt-test',
      sawImages: true,
    });

    const result = await analyseBrand(input);

    // A deep brand ground is exactly the case the resolver carries across to dark mode unchanged,
    // which renders two identical panels.
    expect(result.fields.canvasColorDark?.value).toBeDefined();
    expect(result.fields.canvasColorDark?.value).not.toBe('#691b9a');
    expect(result.fields.inkColor?.value).toBeDefined();
    expect(result.fields.inkColorDark?.value).toBeDefined();
  });

  it('passes the client id through for cost attribution', async () => {
    await analyseBrand({ ...input, demoClientId: 'dc-1' });

    expect(assignMock.assignRoles).toHaveBeenCalledWith(
      expect.objectContaining({ demoClientId: 'dc-1' })
    );
  });

  it('still degrades cleanly when role assignment throws something other than an Error', async () => {
    // The catch block builds its log message from `error.message`, which only exists on a real
    // Error — a rejection with a plain value must not crash the fallback that is the whole point
    // of this catch.
    assignMock.assignRoles.mockRejectedValue('rejected with a plain string');

    const result = await analyseBrand(input);

    expect(result.degraded).toBe(true);
    expect(result.candidates).toEqual(CANDIDATES);
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
      logoCandidates: [{ url: 'https://acme.example/logo.png', via: 'schema.org' }],
      logoImages: new Map([['https://acme.example/logo.png', Buffer.from('png')]]),
      siteName: 'Acme',
      mark: { url: 'https://acme.example/touch.png', via: 'apple-touch-icon' },
      logoDarkCandidates: [],
      fontFamilies: ['Space Grotesk'],
      note: null,
      ...overrides,
    },
  };
}

describe('analyseBrand: a website only', () => {
  beforeEach(() => {
    harvestMock.harvestSite.mockResolvedValue(harvested());
    logoMock.verifyLogo.mockResolvedValue({
      url: 'https://acme.example/logo.png',
      confidence: 'high',
      reason: 'the lockup on the page, which reads “Acme”',
      darkUrl: null,
    });
  });

  it('is `blocked` with the harvest’s own reason, and offers the screenshot', async () => {
    harvestMock.harvestSite.mockResolvedValue({
      ok: false,
      reason: 'That site refused our request (403) — many sites block automated readers.',
    });

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.outcome).toBe('blocked');
    expect(result.nextStep).toBe('screenshot');
    expect(result.reason).toContain('403');
    // Nothing was measured, so nothing is offered — including no empty palette to imply otherwise.
    expect(result.candidates).toEqual([]);
  });

  it('proposes the logo it checked, and the mark it discovered', async () => {
    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.fields.logoUrl?.value).toBe('https://acme.example/logo.png');
    // A schema.org logo is the site asserting what its logo is, not us inferring it.
    expect(result.fields.logoUrl?.confidence).toBe('high');
    expect(result.fields.logoMarkUrl?.confidence).toBe('low');
  });

  it('proposes a typeface when the site loads one we ship', async () => {
    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.fields.fontPairing?.value).toBe('contemporary');
    expect(result.fields.fontPairing?.confidence).toBe('high');
    // An exact match reproduces the brand with a face we already have — nothing to fetch.
    expect(result.fields.customFontDisplay).toBeUndefined();
  });

  it('proposes the site’s own face rather than rounding it to the nearest pairing', async () => {
    harvestMock.harvestSite.mockResolvedValue(harvested({ fontFamilies: ['Poppins', 'Karla'] }));

    const result = await analyseBrand({ url: 'https://acme.example/' });

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

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.fields.customFontBody?.value).toBe('Poppins');
  });

  it('proposes no typeface at all when nothing places', async () => {
    harvestMock.harvestSite.mockResolvedValue(harvested({ fontFamilies: ['Wingdings'] }));

    const result = await analyseBrand({ url: 'https://acme.example/' });

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
      sawImages: false,
    });

    const result = await analyseBrand({ url: 'https://acme.example/' });

    // #5469d4 is in `declared` — the site named it. #ffffff was ranked out of pixels by a model
    // that could not see the page.
    expect(result.fields.ctaColor?.confidence).toBe('high');
    expect(result.fields.ctaColor?.source).toContain('declares');
    expect(result.fields.canvasColor?.confidence).toBe('low');
  });

  it('still proposes the logo when role assignment is unavailable', async () => {
    assignMock.assignRoles.mockRejectedValue(new Error('No active LLM provider is configured'));

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.degraded).toBe(true);
    // Images and type are found by parsing, not by measuring, so they survive a missing provider.
    expect(result.fields.logoUrl).toBeDefined();
    expect(result.fields.fontPairing).toBeDefined();
    expect(result.candidates).toEqual(CANDIDATES);
  });

  it('never calls the model when the site gave up no colours', async () => {
    harvestMock.harvestSite.mockResolvedValue(harvested({ candidates: [] }));

    await analyseBrand({ url: 'https://acme.example/' });

    expect(assignMock.assignRoles).not.toHaveBeenCalled();
  });

  it('carries the budget note through, so a truncated harvest does not read as complete', async () => {
    harvestMock.harvestSite.mockResolvedValue(
      harvested({ note: 'Some of the site was not read — we stopped after 12 requests.' })
    );

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.reason).toContain('12 requests');
  });

  it('passes the page’s own declarations to the analyst as context', async () => {
    await analyseBrand({ url: 'https://acme.example/', demoClientId: 'dc-1' });

    expect(assignMock.assignRoles).toHaveBeenCalledWith(
      expect.objectContaining({
        hints: ['The page declares theme-color: #5469d4'],
        demoClientId: 'dc-1',
      })
    );
  });

  it('still degrades cleanly when role assignment throws something other than an Error', async () => {
    assignMock.assignRoles.mockRejectedValue('rejected with a plain string');

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.degraded).toBe(true);
    // The logo and typeface are found by parsing, not by the assignment call that just failed.
    expect(result.fields.logoUrl).toBeDefined();
  });

  it('proposes no mark image at all when the harvest found none', async () => {
    harvestMock.harvestSite.mockResolvedValue(harvested({ mark: null }));

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.fields.logoMarkUrl).toBeUndefined();
  });

  it('marks a schema.org mark as high confidence, unlike the touch-icon default', async () => {
    harvestMock.harvestSite.mockResolvedValue(
      harvested({ mark: { url: 'https://acme.example/schema-logo.png', via: 'schema.org' } })
    );

    const result = await analyseBrand({ url: 'https://acme.example/' });

    // schema.org is the site asserting its own logo, which is a different claim from us noticing
    // an image shaped like one — the default fixture's `apple-touch-icon` mark is 'low' for
    // exactly that reason.
    expect(result.fields.logoMarkUrl?.confidence).toBe('high');
  });

  it('proposes no logo at all when the harvest found no candidates of either kind', async () => {
    harvestMock.harvestSite.mockResolvedValue(
      harvested({ logoCandidates: [], logoDarkCandidates: [] })
    );

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.fields.logoUrl).toBeUndefined();
    // Nothing to check, so the (paid) verification call must not be made at all.
    expect(logoMock.verifyLogo).not.toHaveBeenCalled();
  });

  it('drops a logo candidate the harvest never actually downloaded', async () => {
    // `logoImages` only has bytes for candidates the harvest could fetch; a candidate URL missing
    // from that map has to be filtered out before verification rather than sent through undefined.
    harvestMock.harvestSite.mockResolvedValue(
      harvested({
        logoCandidates: [{ url: 'https://acme.example/logo.png', via: 'schema.org' }],
        logoImages: new Map(),
      })
    );

    await analyseBrand({ url: 'https://acme.example/' });

    expect(logoMock.verifyLogo).toHaveBeenCalledWith(expect.objectContaining({ candidates: [] }));
  });

  it('falls back to the harvest’s own ranking, unverified, when the logo check could not run', async () => {
    // No provider, no vision model, or an unparseable reply all come back as `null` — not a
    // failure, but an unchecked guess, which has to be labelled as one.
    logoMock.verifyLogo.mockResolvedValue(null);

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.fields.logoUrl?.value).toBe('https://acme.example/logo.png');
    expect(result.fields.logoUrl?.confidence).toBe('low');
    expect(result.fields.logoUrl?.source).toContain('we could not check it');
  });

  it('proposes nothing when the check could not run and the harvest had no ranking to fall back to', async () => {
    // logoDarkCandidates alone still triggers a verification attempt, but the FALLBACK only
    // consults `logoCandidates` — so when that specific list is empty, there is nothing to fall
    // back to even though `candidates` (light + dark) was non-empty a moment ago.
    harvestMock.harvestSite.mockResolvedValue(
      harvested({
        logoCandidates: [],
        logoDarkCandidates: [{ url: 'https://acme.example/dark-logo.png', via: 'dark-variant' }],
        logoImages: new Map([['https://acme.example/dark-logo.png', Buffer.from('png')]]),
      })
    );
    logoMock.verifyLogo.mockResolvedValue(null);

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.fields.logoUrl).toBeUndefined();
  });

  it('proposes nothing and explains why when the model checked and rejected every candidate', async () => {
    // The whole reason `chooseLogo` exists: a press badge satisfies every ranking signal, so it
    // has to be CHECKED, and a rejection must reach the admin as a reason, not as a silent gap.
    logoMock.verifyLogo.mockResolvedValue({
      url: null,
      confidence: 'low',
      reason: 'The logo on that page reads “Forbes”, which is not Acme.',
      darkUrl: null,
    });

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.fields.logoUrl).toBeUndefined();
    expect(result.reason).toContain('Forbes');
  });

  it('proposes the dark lockup when the model found a distinct dark variant', async () => {
    logoMock.verifyLogo.mockResolvedValue({
      url: 'https://acme.example/logo.png',
      confidence: 'high',
      reason: 'the lockup on the page, which reads “Acme”',
      darkUrl: 'https://acme.example/logo-dark.png',
    });

    const result = await analyseBrand({ url: 'https://acme.example/' });

    expect(result.fields.logoDarkUrl).toEqual({
      value: 'https://acme.example/logo-dark.png',
      confidence: 'high',
      source: 'the same lockup drawn for a dark background',
    });
  });
});

describe('analyseBrand: an address and screenshots together', () => {
  beforeEach(() => {
    harvestMock.harvestSite.mockResolvedValue(harvested());
    logoMock.verifyLogo.mockResolvedValue({
      url: 'https://acme.example/logo.png',
      confidence: 'high',
      reason: 'the lockup on the page, which reads “Acme”',
      darkUrl: null,
    });
  });

  it('reports both sources, and proposes what only each of them can see', async () => {
    const result = await analyseBrand({ url: 'https://acme.example/', screenshots: [SHOT] });

    expect(result.source).toBe('combined');
    // Only the site names a logo file and a typeface; only a screenshot measures the rendered page.
    expect(result.fields.logoUrl?.value).toBe('https://acme.example/logo.png');
    expect(result.fields.canvasColor?.value).toBe('#ffffff');
  });

  it('weighs the screenshot above the site, and folds several frames into one voice first', async () => {
    paletteMock.extractPalette
      .mockResolvedValueOnce([{ hex: '#f8f2ec', share: 0.8, neutral: true }])
      .mockResolvedValueOnce([{ hex: '#111114', share: 0.9, neutral: true }]);

    await analyseBrand({ url: 'https://acme.example/', screenshots: [SHOT, SHOT] });

    // The frames are merged with each other at equal weight BEFORE meeting the site, so uploading
    // more pictures cannot quietly become "outvote the logo".
    expect(paletteMock.mergePalettes).toHaveBeenNthCalledWith(1, [
      { candidates: [{ hex: '#f8f2ec', share: 0.8, neutral: true }], weight: 1 },
      { candidates: [{ hex: '#111114', share: 0.9, neutral: true }], weight: 1 },
    ]);

    const [sources] = paletteMock.mergePalettes.mock.calls[1];
    const site = sources.find((source: { weight: number }) => source.weight === 2);
    const screenshot = sources.find((source: { weight: number }) => source.weight === 3);
    expect(site.candidates).toEqual(CANDIDATES);
    expect(screenshot.candidates).toHaveLength(2);
  });

  it('attaches every screenshot to the one analyst call', async () => {
    await analyseBrand({ url: 'https://acme.example/', screenshots: [SHOT, SHOT] });

    // One brand, one decision — asking per image would produce two answers with nothing to
    // arbitrate between them.
    expect(assignMock.assignRoles).toHaveBeenCalledTimes(1);
    expect(assignMock.assignRoles).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [SHOT, SHOT],
        hints: ['The page declares theme-color: #5469d4'],
      })
    );
  });

  it('reports a colour that both sources agree on as the strongest kind of proposal', async () => {
    // #5469d4 is in the site's `declared` set AND was measured in the screenshot. Two independent
    // sources agreeing is the whole reason an admin gives us an address and a picture.
    const result = await analyseBrand({ url: 'https://acme.example/', screenshots: [SHOT] });

    expect(result.fields.ctaColor?.confidence).toBe('high');
    expect(result.fields.ctaColor?.source).toContain('declares');
    expect(result.fields.ctaColor?.source).toContain('measured it in your screenshot');
  });

  it('promotes a colour measured in the screenshot that the site never declared', async () => {
    const result = await analyseBrand({ url: 'https://acme.example/', screenshots: [SHOT] });

    // #ffffff is not declared anywhere — on a URL-only run it is a guess by a model that could not
    // see the page. Here a vision model read it off the rendered page, which is the strongest
    // evidence there is for what the ground actually is.
    expect(result.fields.canvasColor?.confidence).toBe('high');
    expect(result.fields.canvasColor?.source).toBe('measured from your screenshot');
  });

  it('keeps a site-only colour honest about being a guess', async () => {
    paletteMock.extractPalette.mockResolvedValue([{ hex: '#ffffff', share: 1, neutral: true }]);

    const result = await analyseBrand({ url: 'https://acme.example/', screenshots: [SHOT] });

    // #111114 came out of stylesheet token counts and logo pixels only. A screenshot in the same
    // run does not make it any better known than it was.
    expect(result.fields.inkColor?.confidence).toBe('low');
    expect(result.fields.inkColor?.source).toBe('measured from the site’s logo and stylesheets');
  });

  it('carries on with the screenshots when the site itself could not be read', async () => {
    harvestMock.harvestSite.mockResolvedValue({
      ok: false,
      reason: 'That site refused our request (403) — many sites block automated readers.',
    });

    const result = await analyseBrand({ url: 'https://acme.example/', screenshots: [SHOT] });

    // A bot wall used to end the run. With pictures in hand it is a note, not an outcome.
    expect(result.outcome).toBe('ok');
    expect(result.fields.canvasColor?.value).toBe('#ffffff');
    expect(result.reason).toContain('403');
    // Attributing the answer to a page we never read would be a lie about where it came from, and
    // there is no logo or typeface in it precisely because we never read one.
    expect(result.source).toBe('screenshot');
    expect(result.fields.logoUrl).toBeUndefined();
    expect(result.reason).toContain('no logo or typeface');
  });

  it('is still `blocked` when the site refused and there was no picture to fall back on', async () => {
    harvestMock.harvestSite.mockResolvedValue({
      ok: false,
      reason: 'That site refused our request (403) — many sites block automated readers.',
    });

    const result = await analyseBrand({ url: 'https://acme.example/', screenshots: [] });

    expect(result.outcome).toBe('blocked');
    expect(result.nextStep).toBe('screenshot');
  });

  it('never fetches the site when the admin gave us only pictures', async () => {
    await analyseBrand({ screenshots: [SHOT] });

    expect(harvestMock.harvestSite).not.toHaveBeenCalled();
  });
});
