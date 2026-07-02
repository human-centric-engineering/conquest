/**
 * FinalCheckModal — the early-finish submit-time contradiction "final check" (F7.3).
 *
 * @see components/app/questionnaire/lifecycle/final-check-modal.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { FinalCheckModal } from '@/components/app/questionnaire/lifecycle/final-check-modal';

const PROBE = 'Earlier you said X, but just now it sounds like Y — which is right?';

describe('FinalCheckModal', () => {
  it('renders the probe text when open', () => {
    render(
      <FinalCheckModal
        open
        probeText={PROBE}
        onClarify={vi.fn()}
        onFinishAnyway={vi.fn()}
        busy={false}
      />
    );
    expect(screen.getByText(PROBE)).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <FinalCheckModal
        open={false}
        probeText={PROBE}
        onClarify={vi.fn()}
        onFinishAnyway={vi.fn()}
        busy={false}
      />
    );
    expect(screen.queryByText(PROBE)).not.toBeInTheDocument();
  });

  it('fires onClarify from the "Clarify in chat" button', async () => {
    const onClarify = vi.fn();
    render(
      <FinalCheckModal
        open
        probeText={PROBE}
        onClarify={onClarify}
        onFinishAnyway={vi.fn()}
        busy={false}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /clarify in chat/i }));
    expect(onClarify).toHaveBeenCalledTimes(1);
  });

  it('treats an outside dismiss (Esc) as "clarify" — closing never completes the session', async () => {
    // The Dialog's onOpenChange(false) path (overlay click / Esc / ✕) routes to onClarify, the least
    // destructive default — it steps back into the chat rather than finishing.
    const onClarify = vi.fn();
    render(
      <FinalCheckModal
        open
        probeText={PROBE}
        onClarify={onClarify}
        onFinishAnyway={vi.fn()}
        busy={false}
      />
    );
    await userEvent.keyboard('{Escape}');
    expect(onClarify).toHaveBeenCalledTimes(1);
  });

  it('fires onFinishAnyway from the escape hatch', async () => {
    const onFinishAnyway = vi.fn();
    render(
      <FinalCheckModal
        open
        probeText={PROBE}
        onClarify={vi.fn()}
        onFinishAnyway={onFinishAnyway}
        busy={false}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /get my report anyway/i }));
    expect(onFinishAnyway).toHaveBeenCalledTimes(1);
  });

  it('disables both actions while a finish is in flight', () => {
    render(
      <FinalCheckModal open probeText={PROBE} onClarify={vi.fn()} onFinishAnyway={vi.fn()} busy />
    );
    expect(screen.getByRole('button', { name: /clarify in chat/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /finishing/i })).toBeDisabled();
  });
});
