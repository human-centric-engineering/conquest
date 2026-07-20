/**
 * ExperienceStepForm — regression coverage for the duration-clear bug.
 *
 * The "Duration" field on a breakout step is optional — its help text promises "leave blank for
 * no clock". It used to be registered with `{ valueAsNumber: true }`, which turns a CLEARED
 * number input into `NaN` rather than an empty value. The Zod schema (`z.number().int().min(1)
 * .max(120).nullable()`) rejects `NaN`, so clearing an existing duration to remove the clock
 * blocked the save entirely — the exact case the help text promised would work.
 *
 * The fix swapped to `setValueAs: (v) => (v === '' || v === null ? null : Number(v))`, mapping a
 * cleared input to `null` (valid) instead of `NaN` (rejected). These tests lock in: the cleared-
 * existing-duration save path (the regression), minutes→seconds conversion on the wire, that
 * min/max range validation still rejects out-of-range values, and that a blank duration on create
 * submits `durationSeconds: null`.
 *
 * @see components/admin/experiences/experience-step-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExperienceStepForm } from '@/components/admin/experiences/experience-step-form';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { ExperienceStepView } from '@/lib/app/questionnaire/experiences/views';

// Mock the API client — assertions target the actual request body it received, not what it returns.
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: vi.fn(),
    patch: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
    }
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
}));

/** An existing breakout step with an 8-minute (480s) clock — the fixture the bug report used. */
const existingBreakoutStep: ExperienceStepView = {
  id: 'step-1',
  key: 'step-key-1',
  kind: 'breakout',
  title: 'Warm-up discussion',
  purpose: null,
  selectionCriteria: null,
  ordinal: 0,
  questionnaireId: null,
  questionnaireTitle: null,
  versionId: null,
  versionNumber: null,
  roundId: null,
  durationSeconds: 480,
  briefing: null,
  synthesisFocus: null,
  rooms: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('components/admin/experiences/experience-step-form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('regression: clearing an existing breakout duration', () => {
    it('saves durationSeconds: null when the duration input is cleared on an existing step', async () => {
      // Arrange — an existing breakout step with a clock already set.
      const user = userEvent.setup();
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true, data: {} });

      render(
        <ExperienceStepForm
          experienceId="exp-1"
          experienceKind="facilitated_meeting"
          questionnaireOptions={[]}
          step={existingBreakoutStep}
          hasEntry
        />
      );

      const durationInput = screen.getByRole('spinbutton', { name: /how long, in minutes/i });
      expect(durationInput).toHaveValue(8);

      // Act — clear the box (this is the "leave blank for no clock" gesture the help text
      // promises) and submit.
      await user.clear(durationInput);
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert — the save SUCCEEDS (this was the broken case: the resolver used to reject a
      // cleared box with NaN before onSubmit ever ran) and sends durationSeconds: null.
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledTimes(1);
      });
      expect(apiClient.patch).toHaveBeenCalledWith(API.APP.EXPERIENCES.step('exp-1', 'step-1'), {
        body: expect.objectContaining({ durationSeconds: null }),
      });

      // No validation error should have blocked the submit.
      expect(
        screen.queryByText(/enter a number of minutes, or leave blank/i)
      ).not.toBeInTheDocument();
    });
  });

  describe('minutes-to-seconds conversion', () => {
    it('submits durationSeconds in seconds when a duration is entered in minutes', async () => {
      // Arrange — create mode; hasEntry defaults a new step's kind to 'breakout' so the field renders.
      const user = userEvent.setup();
      vi.mocked(apiClient.post).mockResolvedValue({ success: true, data: {} });

      render(
        <ExperienceStepForm
          experienceId="exp-1"
          experienceKind="facilitated_meeting"
          questionnaireOptions={[]}
          hasEntry
        />
      );

      await user.type(screen.getByRole('textbox', { name: /title/i }), 'Round one');
      await user.type(screen.getByRole('spinbutton', { name: /how long, in minutes/i }), '8');
      await user.click(screen.getByRole('button', { name: /add step/i }));

      // Assert — 8 minutes on the form becomes 480 seconds on the wire.
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledTimes(1);
      });
      expect(apiClient.post).toHaveBeenCalledWith(API.APP.EXPERIENCES.steps('exp-1'), {
        body: expect.objectContaining({ durationSeconds: 480 }),
      });
    });

    it('defaults durationSeconds to null when creating a step with duration left blank', async () => {
      // Arrange
      const user = userEvent.setup();
      vi.mocked(apiClient.post).mockResolvedValue({ success: true, data: {} });

      render(
        <ExperienceStepForm
          experienceId="exp-1"
          experienceKind="facilitated_meeting"
          questionnaireOptions={[]}
          hasEntry
        />
      );

      // Act — fill only the required Title field; leave duration untouched.
      await user.type(screen.getByRole('textbox', { name: /title/i }), 'Round one');
      await user.click(screen.getByRole('button', { name: /add step/i }));

      // Assert
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledTimes(1);
      });
      expect(apiClient.post).toHaveBeenCalledWith(API.APP.EXPERIENCES.steps('exp-1'), {
        body: expect.objectContaining({ durationSeconds: null }),
      });
    });
  });

  describe('range validation still holds', () => {
    // The input also carries HTML `min`/`max` attributes, which happy-dom enforces natively on a
    // click-triggered submit — that native check would short-circuit before the Zod resolver ever
    // ran, so these tests dispatch `submit` directly on the form to exercise the schema itself
    // (the layer that still has to hold if the HTML attributes are ever removed or bypassed).
    it('rejects a duration of 0 and does not submit', async () => {
      // Arrange
      const user = userEvent.setup();

      const { container } = render(
        <ExperienceStepForm
          experienceId="exp-1"
          experienceKind="facilitated_meeting"
          questionnaireOptions={[]}
          hasEntry
        />
      );

      await user.type(screen.getByRole('textbox', { name: /title/i }), 'Round one');
      // fireEvent.change for a precise numeric literal — avoids any userEvent typing quirks.
      fireEvent.change(screen.getByRole('spinbutton', { name: /how long, in minutes/i }), {
        target: { value: '0' },
      });
      const form = container.querySelector('form');
      expect(form).not.toBeNull();
      fireEvent.submit(form as HTMLFormElement);

      // Assert — the fix must not have loosened the schema's min(1); the resolver still blocks
      // submission and apiClient is never called.
      await waitFor(() => {
        expect(screen.getByText(/too small/i)).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('rejects a duration of 121 and does not submit', async () => {
      // Arrange
      const user = userEvent.setup();

      const { container } = render(
        <ExperienceStepForm
          experienceId="exp-1"
          experienceKind="facilitated_meeting"
          questionnaireOptions={[]}
          hasEntry
        />
      );

      await user.type(screen.getByRole('textbox', { name: /title/i }), 'Round one');
      fireEvent.change(screen.getByRole('spinbutton', { name: /how long, in minutes/i }), {
        target: { value: '121' },
      });
      const form = container.querySelector('form');
      expect(form).not.toBeNull();
      fireEvent.submit(form as HTMLFormElement);

      // Assert — max(120) still holds.
      await waitFor(() => {
        expect(screen.getByText(/too big/i)).toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });
  });
});
