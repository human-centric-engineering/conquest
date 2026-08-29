/**
 * Unit tests: fetching a Google Fonts family for self-hosting.
 *
 * The subset behaviour is the one worth pinning. Google emits a `@font-face` per unicode subset —
 * latin, latin-ext, cyrillic, greek and more — all carrying the same `font-weight`. Taking them all
 * would multiply the download by six for scripts a demo questionnaire will not set, so only the
 * first block per weight is kept. A regression there is invisible: everything still works, it just
 * stores six times the bytes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.hoisted(() => ({
  fetchResource: vi.fn(),
  HarvestBudget: class {},
}));
vi.mock('@/lib/app/questionnaire/brand-import/fetch', () => fetchMock);

import {
  fetchGoogleFontFaces,
  parseFaceUrls,
} from '@/lib/app/questionnaire/brand-import/google-fonts';

/** The shape Google actually returns: one block per subset, per weight. */
const STYLESHEET = `
/* cyrillic */
@font-face { font-family: 'Poppins'; font-style: normal; font-weight: 400;
  src: url(https://fonts.gstatic.com/s/poppins/v20/cyrillic-400.woff2) format('woff2'); }
/* latin */
@font-face { font-family: 'Poppins'; font-style: normal; font-weight: 400;
  src: url(https://fonts.gstatic.com/s/poppins/v20/latin-400.woff2) format('woff2'); }
/* latin */
@font-face { font-family: 'Poppins'; font-style: normal; font-weight: 700;
  src: url(https://fonts.gstatic.com/s/poppins/v20/latin-700.woff2) format('woff2'); }
/* latin */
@font-face { font-family: 'Poppins'; font-style: normal; font-weight: 900;
  src: url(https://fonts.gstatic.com/s/poppins/v20/latin-900.woff2) format('woff2'); }
`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseFaceUrls', () => {
  it('keeps one file per weight, not one per unicode subset', () => {
    const faces = parseFaceUrls(STYLESHEET);

    expect(faces).toHaveLength(2);
    // The cyrillic block comes first in the sheet, so "first wins" has to mean first-per-weight,
    // not first-overall — and Google orders subsets with latin last.
    expect(faces.find((f) => f.weight === 400)?.url).toContain('cyrillic-400');
  });

  it('ignores weights we did not ask for', () => {
    // 900 is in the stylesheet (Google returns the whole family for some requests) and is not one
    // of the three the surface sets.
    expect(parseFaceUrls(STYLESHEET).map((f) => f.weight)).toEqual([400, 700]);
  });

  it('ignores a block with no gstatic source', () => {
    expect(parseFaceUrls(`@font-face { font-weight: 400; src: local('Poppins'); }`)).toEqual([]);
  });

  it('finds nothing in an empty stylesheet', () => {
    expect(parseFaceUrls('')).toEqual([]);
  });
});

describe('fetchGoogleFontFaces', () => {
  it('rejects a family name that could reach a different URL', async () => {
    // The family goes into a URL we build server-side, so this is the boundary that matters.
    const result = await fetchGoogleFontFaces('Inter&text=secret');

    expect(result.ok).toBe(false);
    expect(fetchMock.fetchResource).not.toHaveBeenCalled();
  });

  it('asks Google for a browser format, because our own agent gets TTF', async () => {
    fetchMock.fetchResource.mockResolvedValue({
      ok: true,
      buffer: Buffer.from(STYLESHEET),
      contentType: 'text/css',
      finalUrl: 'https://fonts.googleapis.com/css2',
    });

    await fetchGoogleFontFaces('Poppins');

    const [url, , options] = fetchMock.fetchResource.mock.calls[0];
    expect(url).toContain('family=Poppins');
    expect(url).toContain('wght@400;600;700');
    // Several times the bytes for the same glyphs, on a file every respondent downloads.
    expect(options.userAgent).toContain('Chrome');
  });

  it('treats a missing family as a nameable failure, not a crash', async () => {
    // There is no offline catalogue to validate against — asking Google IS the validation.
    fetchMock.fetchResource.mockResolvedValue({
      ok: false,
      reason: 'That page was not found (404).',
    });

    const result = await fetchGoogleFontFaces('Notafont');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Notafont');
  });

  it('returns the weights it could fetch, skipping the ones it could not', async () => {
    fetchMock.fetchResource
      .mockResolvedValueOnce({
        ok: true,
        buffer: Buffer.from(STYLESHEET),
        contentType: 'text/css',
        finalUrl: 'https://fonts.googleapis.com/css2',
      })
      .mockResolvedValueOnce({
        ok: true,
        buffer: Buffer.from('woff2-400'),
        contentType: 'font/woff2',
        finalUrl: 'https://fonts.gstatic.com/400',
      })
      .mockResolvedValueOnce({ ok: false, reason: 'We could not reach that address.' });

    const result = await fetchGoogleFontFaces('Poppins');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One missing weight is not a failed family: the browser synthesises what is absent.
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0].weight).toBe(400);
  });

  it('fails when no weight could be fetched at all', async () => {
    fetchMock.fetchResource
      .mockResolvedValueOnce({
        ok: true,
        buffer: Buffer.from(STYLESHEET),
        contentType: 'text/css',
        finalUrl: 'https://fonts.googleapis.com/css2',
      })
      .mockResolvedValue({ ok: false, reason: 'nope' });

    const result = await fetchGoogleFontFaces('Poppins');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('could not download');
  });
});
