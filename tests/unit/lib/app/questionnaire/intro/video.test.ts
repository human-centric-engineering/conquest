/**
 * resolveIntroVideo — turns a raw YouTube/Vimeo link into a safe, trusted-host embed, or null.
 *
 * @see lib/app/questionnaire/intro/video.ts
 */

import { describe, it, expect } from 'vitest';

import { resolveIntroVideo } from '@/lib/app/questionnaire/intro/video';

describe('resolveIntroVideo — YouTube', () => {
  it('parses watch, youtu.be, embed, shorts and m. links to a nocookie embed', () => {
    const expected = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) {
      const v = resolveIntroVideo(url);
      expect(v, url).not.toBeNull();
      expect(v?.provider).toBe('youtube');
      expect(v?.embedUrl).toBe(expected);
    }
  });

  it('rejects a malformed YouTube id (wrong length / charset)', () => {
    expect(resolveIntroVideo('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(resolveIntroVideo('https://youtu.be/has spaces!')).toBeNull();
    expect(resolveIntroVideo('https://www.youtube.com/watch')).toBeNull(); // no v param
  });
});

describe('resolveIntroVideo — Vimeo', () => {
  it('parses vimeo.com/<id> and player.vimeo.com/video/<id>', () => {
    expect(resolveIntroVideo('https://vimeo.com/123456789')?.embedUrl).toBe(
      'https://player.vimeo.com/video/123456789'
    );
    expect(resolveIntroVideo('https://player.vimeo.com/video/123456789')?.provider).toBe('vimeo');
  });

  it('carries the unlisted hash through as ?h=', () => {
    expect(resolveIntroVideo('https://vimeo.com/123456789/abc123def')?.embedUrl).toBe(
      'https://player.vimeo.com/video/123456789?h=abc123def'
    );
  });

  it('finds the numeric id inside a channel path', () => {
    expect(resolveIntroVideo('https://vimeo.com/channels/staffpicks/123456789')?.embedUrl).toBe(
      'https://player.vimeo.com/video/123456789'
    );
  });
});

describe('resolveIntroVideo — rejects everything else', () => {
  it('returns null for empty / nullish input', () => {
    expect(resolveIntroVideo('')).toBeNull();
    expect(resolveIntroVideo('   ')).toBeNull();
    expect(resolveIntroVideo(null)).toBeNull();
    expect(resolveIntroVideo(undefined)).toBeNull();
  });

  it('returns null for unparseable or non-http(s) schemes (no javascript:/data:)', () => {
    expect(resolveIntroVideo('not a url')).toBeNull();
    expect(resolveIntroVideo('javascript:alert(1)')).toBeNull();
    expect(resolveIntroVideo('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(resolveIntroVideo('file:///etc/passwd')).toBeNull();
  });

  it('returns null for an unrecognised host (only YouTube/Vimeo embed)', () => {
    expect(resolveIntroVideo('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(resolveIntroVideo('https://vimeo.evil.com/123456789')).toBeNull();
    expect(resolveIntroVideo('https://notyoutube.com/embed/dQw4w9WgXcQ')).toBeNull();
  });
});
