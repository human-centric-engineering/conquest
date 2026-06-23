/**
 * Best-effort brand-logo fetch, shared by the session export seams (F7.4 / F7.6).
 *
 * Fetches a brand logo and returns it as a base64 `data:` URI for embedding in a
 * React-PDF `<Image>`. Returns null on ANY failure (absent URL, non-image, oversize,
 * timeout, network error) so a flaky remote image renders no logo rather than throwing
 * mid-render. Only https URLs are fetched (the theme write boundary already validates
 * this; re-checked here as defence in depth).
 *
 * Call only AFTER the route authorises — the fetch must never run for an unauthorised
 * request.
 */

/** How long to wait for the brand logo before rendering without it. */
const LOGO_FETCH_TIMEOUT_MS = 3000;
/** Cap the logo we embed (a runaway image shouldn't bloat the PDF / memory). */
const LOGO_MAX_BYTES = 1_000_000;

export async function fetchLogoDataUri(url: string | null): Promise<string | null> {
  if (!url || !url.startsWith('https://')) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;
    // Strip any MIME parameters (e.g. `image/svg+xml; charset=utf-8`) — a space/param in the
    // media-type makes the data: URI non-conformant and some renderers reject it.
    const mediaType = contentType.split(';')[0].trim();
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > LOGO_MAX_BYTES) return null;
    return `data:${mediaType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
