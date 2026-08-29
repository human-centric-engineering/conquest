/**
 * Unit tests: reading a brand off a live website.
 *
 * Driven through fixture HTML rather than fixture DOM objects, because the discovery rules are
 * about real markup — a logo inside a `<header>`, a `schema.org` blob nested under an `@graph`, a
 * `<picture>` with a dark-mode `<source>`. The fetcher is mocked so each test states exactly what
 * the network returned.
 *
 * The ordering assertions carry the most weight: the difference between proposing a wordmark and
 * proposing a 16px favicon is entirely which rule fires first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.hoisted(() => ({
  fetchResource: vi.fn(),
  HarvestBudget: class {
    note() {
      return null;
    }
    get truncated() {
      return false;
    }
  },
}));
vi.mock('@/lib/app/questionnaire/brand-import/fetch', () => fetchMock);

// Untyped `vi.fn()` deliberately: a typed factory narrows the return to `never[]` from its own
// default, which then rejects every fixture these tests set.
const paletteMock = vi.hoisted(() => ({
  extractPalette: vi.fn(),
  mergePalettes: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/brand-import/palette', () => paletteMock);

import { JSDOM } from 'jsdom';

import {
  discoverFonts,
  discoverImages,
  harvestSite,
  isThirdPartyLogo,
  normaliseUrl,
  readSiteName,
} from '@/lib/app/questionnaire/brand-import/harvest';

const parse = (html: string): Document => new JSDOM(html).window.document;

function page(html: string) {
  return {
    ok: true as const,
    buffer: Buffer.from(html),
    contentType: 'text/html',
    finalUrl: 'https://acme.example/',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  paletteMock.extractPalette.mockResolvedValue([]);
  paletteMock.mergePalettes.mockReturnValue([]);
});

describe('normaliseUrl', () => {
  it('accepts what an admin actually pastes', () => {
    // `acme.com` is the common input and is not a URL. Rejecting it on a technicality would fail
    // the majority of imports before they start.
    expect(normaliseUrl('acme.example')).toBe('https://acme.example/');
    expect(normaliseUrl('  https://acme.example/about  ')).toBe('https://acme.example/about');
  });

  it('upgrades http rather than refusing it — the site will redirect us anyway', () => {
    expect(normaliseUrl('http://acme.example')).toBe('http://acme.example/');
  });

  it('rejects things that are not addresses', () => {
    expect(normaliseUrl('')).toBeNull();
    expect(normaliseUrl('localhost')).toBeNull();
    expect(normaliseUrl('not a url at all')).toBeNull();
  });
});

describe('discoverImages', () => {
  it('prefers the organisation logo the site publishes over anything it infers', () => {
    const doc = parse(`
      <html><head>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Organization","logo":"https://cdn.acme.example/org.png"}
        </script>
      </head><body>
        <header><img class="logo" src="https://cdn.acme.example/header.png"></header>
      </body></html>
    `);

    const found = discoverImages(doc, 'https://acme.example/');
    expect(found.logoCandidates[0]).toEqual({
      url: 'https://cdn.acme.example/org.png',
      via: 'schema.org',
    });
  });

  it('finds an Organization nested under an @graph, which is how most sites publish it', () => {
    const doc = parse(`
      <script type="application/ld+json">
        {"@graph":[{"@type":"WebSite"},{"@type":"Organization","logo":{"url":"https://cdn.acme.example/o.png"}}]}
      </script>
    `);

    expect(discoverImages(doc, 'https://acme.example/').logoCandidates[0]?.url).toBe(
      'https://cdn.acme.example/o.png'
    );
  });

  it('falls back to a header image whose attributes say logo', () => {
    const doc = parse(`
      <header><img alt="Acme logo" src="/assets/mark-2024.png"></header>
    `);

    expect(discoverImages(doc, 'https://acme.example/').logoCandidates[0]).toEqual({
      url: 'https://acme.example/assets/mark-2024.png',
      via: 'header',
    });
  });

  it('falls back again to any image whose filename says logo', () => {
    const doc = parse(`<main><img src="/img/logo.svg"></main>`);

    expect(discoverImages(doc, 'https://acme.example/').logoCandidates[0]).toEqual({
      url: 'https://acme.example/img/logo.svg',
      via: 'filename',
    });
  });

  it('prefers the touch icon over the favicon for the square mark', () => {
    // apple-touch-icon is typically 180x180 and clears the mark spec's 128px floor; a favicon is
    // usually 32px and never would.
    const doc = parse(`
      <link rel="icon" href="/favicon.ico">
      <link rel="apple-touch-icon" href="/touch.png">
    `);

    expect(discoverImages(doc, 'https://acme.example/').mark).toEqual({
      url: 'https://acme.example/touch.png',
      via: 'apple-touch-icon',
    });
  });

  it('takes a dark lockup only from an explicit dark-mode source', () => {
    const doc = parse(`
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="/logo-dark.svg 1x">
        <img src="/logo.svg">
      </picture>
    `);

    expect(discoverImages(doc, 'https://acme.example/').logoDarkCandidates[0]).toEqual({
      url: 'https://acme.example/logo-dark.svg',
      via: 'dark-variant',
    });
  });

  it('proposes no dark lockup rather than guessing one', () => {
    // The field is one an admin rarely checks, so the wrong artwork there is worse than none.
    const doc = parse(`<header><img class="logo" src="/logo.svg"></header>`);
    expect(discoverImages(doc, 'https://acme.example/').logoDarkCandidates).toEqual([]);
  });

  it('drops an http image, because the column will not accept one', () => {
    const doc = parse(`<header><img class="logo" src="http://cdn.acme.example/logo.png"></header>`);
    expect(discoverImages(doc, 'https://acme.example/').logoCandidates).toEqual([]);
  });
});

describe('discoverFonts', () => {
  it('reads the families a site deliberately loads from Google Fonts first', () => {
    const doc = parse(
      `<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&family=Newsreader">`
    );

    expect(discoverFonts(doc, '')).toEqual(['Space Grotesk', 'Newsreader']);
  });

  it('reads font-family stacks, keeping the first real family', () => {
    expect(
      discoverFonts(parse('<html></html>'), 'body { font-family: "Acme Sans", Arial, sans-serif; }')
    ).toEqual(['Acme Sans']);
  });

  it('drops generic keywords, which are not a brand typeface', () => {
    expect(discoverFonts(parse('<html></html>'), 'body { font-family: sans-serif; }')).toEqual([]);
    expect(
      discoverFonts(parse('<html></html>'), 'body { font-family: system-ui, sans-serif; }')
    ).toEqual([]);
  });
});

describe('harvestSite', () => {
  it('reports the fetcher’s own reason when the page cannot be read', async () => {
    fetchMock.fetchResource.mockResolvedValue({
      ok: false,
      reason: 'That site refused our request (403) — many sites block automated readers.',
    });

    const result = await harvestSite('https://acme.example/');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('403');
  });

  it('refuses an address that is not a web page', async () => {
    fetchMock.fetchResource.mockResolvedValue({
      ok: true,
      buffer: Buffer.from('%PDF-1.4'),
      contentType: 'application/pdf',
      finalUrl: 'https://acme.example/brand.pdf',
    });

    const result = await harvestSite('https://acme.example/brand.pdf');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('not a web page');
  });

  it('collects what the page declares about itself as hints', async () => {
    fetchMock.fetchResource.mockImplementation(async (url: string) => {
      if (url.endsWith('.css')) {
        return {
          ok: true,
          buffer: Buffer.from(':root { --brand-primary: #5469d4; }'),
          contentType: 'text/css',
          finalUrl: url,
        };
      }
      return page(`
        <html><head>
          <meta name="theme-color" content="#0a1a3a">
          <link rel="stylesheet" href="/site.css">
        </head><body></body></html>
      `);
    });

    const result = await harvestSite('https://acme.example/');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brand.hints).toContain('The page declares theme-color: #0a1a3a');
    expect(result.brand.hints).toContain('The stylesheet declares --brand-primary: #5469d4');
    // The declared set is what later earns a proposal its high confidence.
    expect([...result.brand.declared]).toEqual(['#0a1a3a', '#5469d4']);
  });

  it('does not spend budget fetching a Google Fonts stylesheet', async () => {
    fetchMock.fetchResource.mockResolvedValue(
      page(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">`)
    );

    await harvestSite('https://acme.example/');

    // Font sheets are read for their family names, and the names are in the href.
    expect(fetchMock.fetchResource).toHaveBeenCalledTimes(1);
  });

  it('measures the logo it found', async () => {
    fetchMock.fetchResource.mockImplementation(async (url: string) => {
      if (url.includes('logo')) {
        return {
          ok: true,
          buffer: Buffer.from('png-bytes'),
          contentType: 'image/png',
          finalUrl: url,
        };
      }
      return page(`<header><img class="logo" src="/logo.png"></header>`);
    });
    paletteMock.extractPalette.mockResolvedValue([{ hex: '#5469d4', share: 1, neutral: false }]);

    const result = await harvestSite('https://acme.example/');

    expect(result.ok).toBe(true);
    expect(paletteMock.extractPalette).toHaveBeenCalled();
    // The logo's own pixels are weighted above everything else — a logo IS the brand.
    const sources = paletteMock.mergePalettes.mock.calls[0][0] as { weight: number }[];
    expect(Math.max(...sources.map((s) => s.weight))).toBe(5);
  });

  it('carries on when an image cannot be fetched', async () => {
    fetchMock.fetchResource.mockImplementation(async (url: string) => {
      if (url.includes('logo')) return { ok: false, reason: 'We could not reach that address.' };
      return page(`
        <html><head><meta name="theme-color" content="#0a1a3a"></head>
        <body><header><img class="logo" src="/logo.png"></header></body></html>
      `);
    });

    const result = await harvestSite('https://acme.example/');

    // A missing image must not fail an import that already found a declared colour.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brand.logoCandidates[0]?.url).toBe('https://acme.example/logo.png');
    expect(result.brand.declared.has('#0a1a3a')).toBe(true);
  });

  it('reads colours out of an inline header SVG, which has no file to fetch', async () => {
    fetchMock.fetchResource.mockResolvedValue(
      page(`<header><svg><path fill="#5469d4"/><path fill="none"/></svg></header>`)
    );

    await harvestSite('https://acme.example/');

    const sources = paletteMock.mergePalettes.mock.calls[0][0] as {
      candidates: { hex: string }[];
    }[];
    expect(sources.some((s) => s.candidates.some((c) => c.hex === '#5469d4'))).toBe(true);
  });
});

describe('excluding somebody else’s logo', () => {
  /**
   * From a real import: a company called Eagle Eye Solutions got a circular **Forbes** logo. A
   * marketing homepage is full of files literally named `logo` that belong to press outlets, review
   * sites, partners and customers, and every one of them beats the real lockup on a filename match
   * if it appears earlier in the DOM.
   */
  const img = (html: string): Element => parse(html).querySelector('img') as Element;

  it('rejects a press outlet by name, wherever it appears', () => {
    expect(isThirdPartyLogo(img('<img src="/img/forbes-logo.svg">'))).toBe(true);
    expect(isThirdPartyLogo(img('<img alt="G2 logo" src="/a.svg">'))).toBe(true);
  });

  it('rejects an anonymous image by the role its own attributes claim', () => {
    expect(isThirdPartyLogo(img('<img class="partner-logo" src="/a.svg">'))).toBe(true);
    expect(isThirdPartyLogo(img('<img alt="As seen in" src="/a.svg">'))).toBe(true);
    expect(isThirdPartyLogo(img('<img src="/awards/badge-2024.png">'))).toBe(true);
  });

  it('rejects an innocent-looking file by the section it sits in', () => {
    // `eagle.svg` inside "our clients" is a client's mark, and only its position says so.
    expect(
      isThirdPartyLogo(
        img('<section class="our-clients"><div><a><img src="/eagle.svg"></a></div></section>')
      )
    ).toBe(true);
    expect(isThirdPartyLogo(img('<div class="logo-wall"><img src="/x.svg"></div>'))).toBe(true);
  });

  it('leaves the company’s own lockup alone', () => {
    expect(
      isThirdPartyLogo(
        img('<header><img class="site-logo" alt="Eagle Eye" src="/logo.svg"></header>')
      )
    ).toBe(false);
  });

  it('keeps a press badge out of the candidate list entirely', () => {
    const doc = parse(`
      <header><img class="logo" src="/eagleeye-logo.svg"></header>
      <section class="as-seen-in"><img class="logo" src="/forbes-logo.svg"></section>
    `);

    const { logoCandidates } = discoverImages(doc, 'https://acme.example/');

    expect(logoCandidates.map((c) => c.url)).toEqual(['https://acme.example/eagleeye-logo.svg']);
  });

  it('keeps a press badge out of the DARK lockup slot too', () => {
    /*
     * The reported failure, second time round. A "Forbes Communications Council" badge is named
     * like a logo AND drawn white for a dark ground, so it matched the dark-variant rule — which
     * had no third-party check at all. It then became the client's dark lockup, and from there
     * their header band, because the band prefers the dark lockup whenever its ground is dark.
     */
    const doc = parse(`
      <section class="press"><img src="/forbes-council-logo-white.png"></section>
      <header><img src="/eagleeye-logo-white.svg"></header>
    `);

    const { logoDarkCandidates } = discoverImages(doc, 'https://acme.example/');

    expect(logoDarkCandidates.map((c) => c.url)).toEqual([
      'https://acme.example/eagleeye-logo-white.svg',
    ]);
  });

  it('rejects a dark <source> whose own <picture> is a third party’s', () => {
    const doc = parse(`
      <div class="partners">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="/g2-logo-dark.svg">
          <img src="/g2-logo.svg">
        </picture>
      </div>
    `);

    expect(discoverImages(doc, 'https://acme.example/').logoDarkCandidates).toEqual([]);
  });

  it('keeps several real candidates so the analyst can choose between them', () => {
    const doc = parse(`
      <header><img class="logo" src="/a-logo.svg"></header>
      <div class="navbar"><img class="brand" src="/b-logo.svg"></div>
    `);

    expect(discoverImages(doc, 'https://acme.example/').logoCandidates).toHaveLength(2);
  });
});

describe('readSiteName', () => {
  // The name a lockup has to match. Without it "is this actually their logo?" is unanswerable.
  it('prefers what the site states outright', () => {
    const doc = parse(
      '<meta property="og:site_name" content="Eagle Eye Solutions"><title>Home | EE</title>'
    );
    expect(readSiteName(doc, 'https://eagleeye.example/')).toBe('Eagle Eye Solutions');
  });

  it('takes the head of a title, which is usually "Company — tagline"', () => {
    const doc = parse('<title>Eagle Eye Solutions | Retail intelligence</title>');
    expect(readSiteName(doc, 'https://eagleeye.example/')).toBe('Eagle Eye Solutions');
  });

  it('falls back to the hostname, which is right in substance if not in spelling', () => {
    expect(readSiteName(parse('<html></html>'), 'https://www.eagleeye.example/')).toBe(
      'eagleeye.example'
    );
  });
});
