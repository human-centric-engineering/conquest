/**
 * Intro-background route input — schema + upload guard (F12.2).
 *
 * @see app/api/v1/app/questionnaires/intro-background/_lib/input.ts
 */

import { describe, it, expect } from 'vitest';

import {
  authorIntroBackgroundSchema,
  parseUploadGuard,
  INTRO_BACKGROUND_MAX_UPLOAD_BYTES,
} from '@/app/api/v1/app/questionnaires/intro-background/_lib/input';

describe('authorIntroBackgroundSchema', () => {
  it('accepts a generate request with a brief', () => {
    expect(authorIntroBackgroundSchema.safeParse({ mode: 'generate', brief: 'x' }).success).toBe(
      true
    );
  });

  it('rejects generate without a brief', () => {
    const r = authorIntroBackgroundSchema.safeParse({ mode: 'generate' });
    expect(r.success).toBe(false);
  });

  it('accepts a refine request with current text + instruction', () => {
    const r = authorIntroBackgroundSchema.safeParse({
      mode: 'refine',
      currentText: 'cur',
      instruction: 'shorter',
    });
    expect(r.success).toBe(true);
  });

  it('rejects refine missing currentText or instruction', () => {
    expect(
      authorIntroBackgroundSchema.safeParse({ mode: 'refine', instruction: 'x' }).success
    ).toBe(false);
    expect(
      authorIntroBackgroundSchema.safeParse({ mode: 'refine', currentText: 'x' }).success
    ).toBe(false);
  });

  it('rejects an unknown mode', () => {
    expect(authorIntroBackgroundSchema.safeParse({ mode: 'other', brief: 'x' }).success).toBe(
      false
    );
  });

  it('accepts a generate request with a questionnaire + version pair', () => {
    const r = authorIntroBackgroundSchema.safeParse({
      mode: 'generate',
      brief: 'x',
      questionnaireId: 'q-1',
      versionId: 'v-1',
    });
    expect(r.success).toBe(true);
  });

  it('rejects when only one of questionnaireId / versionId is sent', () => {
    expect(
      authorIntroBackgroundSchema.safeParse({
        mode: 'generate',
        brief: 'x',
        questionnaireId: 'q-1',
      }).success
    ).toBe(false);
    expect(
      authorIntroBackgroundSchema.safeParse({ mode: 'generate', brief: 'x', versionId: 'v-1' })
        .success
    ).toBe(false);
  });
});

function uploadRequest(file: File | null): Request {
  const form = new FormData();
  if (file) form.append('file', file);
  return new Request('http://localhost/parse', { method: 'POST', body: form });
}

describe('parseUploadGuard', () => {
  it('accepts a small allowed file', async () => {
    const file = new File(['hello'], 'about.txt', { type: 'text/plain' });
    const res = await parseUploadGuard(uploadRequest(file));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.file.name).toBe('about.txt');
  });

  it('rejects when no file is provided', async () => {
    const res = await parseUploadGuard(uploadRequest(null));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it('rejects an unsupported extension', async () => {
    const file = new File(['x'], 'image.png', { type: 'image/png' });
    const res = await parseUploadGuard(uploadRequest(file));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(415);
  });

  it('rejects a file over the size cap', async () => {
    // Allocate just past the cap so the real File.size (preserved through FormData) trips the guard.
    const big = new File([new Uint8Array(INTRO_BACKGROUND_MAX_UPLOAD_BYTES + 1)], 'big.pdf', {
      type: 'application/pdf',
    });
    const res = await parseUploadGuard(uploadRequest(big));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);
  });
});
