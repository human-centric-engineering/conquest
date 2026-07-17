/**
 * Integration test: AI invitee-extraction endpoint (invitations Phase D).
 *
 * The extraction runner, PDF parser, auth, flags, and rate limiter are mocked; the test pins the
 * route's gates (flag, file presence/type/size), the PDF→text vs image→vision branch, the empty-PDF
 * short-circuit, and the fail-soft 502.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/security/rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/security/rate-limit')>();
  return { ...real, inviteLimiter: { check: vi.fn(() => ({ success: true })) } };
});

const parsersMock = vi.hoisted(() => ({ parsePdf: vi.fn() }));
vi.mock('@/lib/orchestration/knowledge/parsers/pdf-parser', () => parsersMock);

const extractMock = vi.hoisted(() => ({
  extractPeopleFromText: vi.fn(),
  extractPeopleFromImage: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/invitations/extract/extract-people', () => extractMock);

import { POST } from '@/app/api/v1/app/questionnaires/[id]/invitations/import/extract/route';
import { auth } from '@/lib/auth/config';
import { inviteLimiter } from '@/lib/security/rate-limit';
import { mockAdminUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const ctx = { params: Promise.resolve({ id: 'qn-1' }) };

function req(file: File | null): NextRequest {
  const fd = new FormData();
  if (file) fd.append('file', file);
  return new Request(
    'http://localhost:3000/api/v1/app/questionnaires/qn-1/invitations/import/extract',
    {
      method: 'POST',
      body: fd,
    }
  ) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  parsersMock.parsePdf.mockResolvedValue({ fullText: 'Ada <ada@x.com>', warnings: [] });
  extractMock.extractPeopleFromText.mockResolvedValue([{ email: 'ada@x.com', firstName: 'Ada' }]);
  extractMock.extractPeopleFromImage.mockResolvedValue([{ email: 'grace@y.com' }]);
});

describe('POST invitations/import/extract', () => {
  it('400s when no file is supplied', async () => {
    const res = await POST(req(null), ctx);
    expect(res.status).toBe(400);
  });

  it('400s for an unsupported file type', async () => {
    const res = await POST(req(new File(['x'], 'a.txt', { type: 'text/plain' })), ctx);
    expect(res.status).toBe(400);
  });

  it('extracts from a PDF via parsePdf → extractPeopleFromText', async () => {
    const res = await POST(req(new File(['%PDF'], 'list.pdf', { type: 'application/pdf' })), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.people).toEqual([{ email: 'ada@x.com', firstName: 'Ada' }]);
    expect(parsersMock.parsePdf).toHaveBeenCalledTimes(1);
    expect(extractMock.extractPeopleFromImage).not.toHaveBeenCalled();
  });

  it('short-circuits a text-less (scanned) PDF without calling the model', async () => {
    parsersMock.parsePdf.mockResolvedValue({ fullText: '   ', warnings: [] });
    const res = await POST(req(new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' })), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.people).toEqual([]);
    expect(extractMock.extractPeopleFromText).not.toHaveBeenCalled();
  });

  it('extracts from an image via extractPeopleFromImage', async () => {
    const res = await POST(req(new File(['img'], 'shot.png', { type: 'image/png' })), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.people).toEqual([{ email: 'grace@y.com' }]);
    expect(extractMock.extractPeopleFromImage).toHaveBeenCalledTimes(1);
  });

  it('fails soft to 502 when extraction throws', async () => {
    extractMock.extractPeopleFromText.mockRejectedValue(new Error('no provider'));
    const res = await POST(req(new File(['%PDF'], 'list.pdf', { type: 'application/pdf' })), ctx);
    expect(res.status).toBe(502);
  });

  it('429s when the rate limit is exceeded', async () => {
    (inviteLimiter.check as unknown as Mock).mockReturnValueOnce({
      success: false,
      limit: 1,
      remaining: 0,
      reset: 0,
    });
    const res = await POST(req(new File(['%PDF'], 'list.pdf', { type: 'application/pdf' })), ctx);
    expect(res.status).toBe(429);
  });
});
