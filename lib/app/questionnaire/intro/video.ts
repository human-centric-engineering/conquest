/**
 * Intro video link → safe embed resolution (pure, no I/O).
 *
 * The admin pastes an ordinary YouTube or Vimeo URL; this turns it into an embeddable iframe `src`
 * on a TRUSTED host, built from a VALIDATED id — never the raw input. That inversion is the security
 * property: the only iframe sources this can ever yield are `youtube-nocookie.com/embed/<id>` and
 * `player.vimeo.com/video/<id>`, so a hostile stored value (seed, direct DB write, or a value that
 * slipped past write-time validation) cannot produce an arbitrary or `javascript:`/`data:` embed —
 * it simply resolves to `null` and no iframe renders.
 *
 * Used at two seams: the config Zod schema rejects an unrecognised link at write time, and the splash
 * resolves the stored link to an embed at render time. Shared so both agree on what "valid" means.
 */

export type IntroVideoProvider = 'youtube' | 'vimeo';

export interface IntroVideo {
  provider: IntroVideoProvider;
  /** Embeddable iframe `src` on a trusted host, built from the parsed id. */
  embedUrl: string;
  /** A11y title for the iframe. */
  title: string;
}

/** YouTube ids are exactly 11 chars of an unreserved alphabet. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
/** Vimeo ids are numeric; the optional unlisted hash is alphanumeric. */
const VIMEO_ID = /^\d+$/;
const VIMEO_HASH = /^[A-Za-z0-9]+$/;

/** Trim a path into its non-empty segments. */
function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

/** Resolve a YouTube watch/short/embed/youtu.be URL to a `youtube-nocookie` embed, or null. */
function resolveYouTube(url: URL): IntroVideo | null {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  let id: string | null = null;

  if (host === 'youtu.be') {
    id = segments(url.pathname)[0] ?? null;
  } else if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'youtube-nocookie.com'
  ) {
    const segs = segments(url.pathname);
    if (segs[0] === 'watch') id = url.searchParams.get('v');
    // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
    else if (['embed', 'shorts', 'live', 'v'].includes(segs[0] ?? '')) id = segs[1] ?? null;
  } else {
    return null;
  }

  if (!id || !YOUTUBE_ID.test(id)) return null;
  return {
    provider: 'youtube',
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
    title: 'Introduction video',
  };
}

/** Resolve a Vimeo URL (incl. unlisted `/<id>/<hash>`) to a `player.vimeo.com` embed, or null. */
function resolveVimeo(url: URL): IntroVideo | null {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const segs = segments(url.pathname);
  let id: string | null = null;
  let hash: string | null = null;

  if (host === 'player.vimeo.com') {
    // /video/<id>
    if (segs[0] === 'video') id = segs[1] ?? null;
  } else if (host === 'vimeo.com') {
    // /<id> or /<id>/<hash> (unlisted) or /channels/<name>/<id>
    const numeric = segs.find((s) => VIMEO_ID.test(s));
    id = numeric ?? null;
    if (id) {
      const after = segs[segs.indexOf(id) + 1];
      if (after && VIMEO_HASH.test(after)) hash = after;
    }
  } else {
    return null;
  }

  if (!id || !VIMEO_ID.test(id)) return null;
  const embedUrl = hash
    ? `https://player.vimeo.com/video/${id}?h=${hash}`
    : `https://player.vimeo.com/video/${id}`;
  return { provider: 'vimeo', embedUrl, title: 'Introduction video' };
}

/**
 * Resolve a raw intro video link to a safe embed, or `null` when it is empty, unparseable, not
 * http(s), or not a recognised YouTube/Vimeo video. Callers treat `null` as "no video".
 */
export function resolveIntroVideo(raw: string | null | undefined): IntroVideo | null {
  const value = raw?.trim();
  if (!value || !URL.canParse(value)) return null;

  const url = new URL(value);
  // Scheme allow-list — never embed `javascript:`, `data:`, `file:`, etc.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  return resolveYouTube(url) ?? resolveVimeo(url);
}
