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

import { analyseScreenshot } from '@/lib/app/questionnaire/brand-import/analyse';

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
