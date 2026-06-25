/**
 * CorrectionStrip — the chat-side "fix what I just noted" affordance (Variant B). Pins that it
 * lists what the latest turn captured, opens the inline editor on Fix, and renders nothing when
 * there's nothing fixable.
 *
 * @see components/app/questionnaire/chat/correction-strip.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { CorrectionStrip } from '@/components/app/questionnaire/chat/correction-strip';
import type { CorrectionTarget } from '@/lib/app/questionnaire/panel/correction-targets';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: {} }) })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function target(over: Partial<CorrectionTarget> = {}): CorrectionTarget {
  return {
    key: 'role',
    label: 'Your role?',
    summary: 'Engineer',
    questions: [
      {
        slot: { slotKey: 'role', prompt: 'Your role?', type: 'free_text', typeConfig: null },
        initialValue: 'Engineer',
      },
    ],
    ...over,
  };
}

describe('CorrectionStrip', () => {
  it('renders nothing when there are no targets', () => {
    const { container } = render(
      <CorrectionStrip targets={[]} sessionId="sess-1" onCorrected={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each captured target with its read-back summary', () => {
    render(<CorrectionStrip targets={[target()]} sessionId="sess-1" onCorrected={vi.fn()} />);
    expect(screen.getByText('Your role?')).toBeInTheDocument();
    expect(screen.getByText('→ Engineer')).toBeInTheDocument();
  });

  it('opens the inline editor (seeded) when Fix is clicked', () => {
    render(<CorrectionStrip targets={[target()]} sessionId="sess-1" onCorrected={vi.fn()} />);
    // No editor field before clicking Fix.
    expect(screen.queryByDisplayValue('Engineer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Fix/ }));
    expect(screen.getByDisplayValue('Engineer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('closes the editor and restores the read-back row when Cancel is clicked', () => {
    render(<CorrectionStrip targets={[target()]} sessionId="sess-1" onCorrected={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Fix/ }));
    expect(screen.getByDisplayValue('Engineer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Editor gone, the captured summary is shown again, and Fix can re-open it.
    expect(screen.queryByDisplayValue('Engineer')).not.toBeInTheDocument();
    expect(screen.getByText('→ Engineer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fix/ })).toBeInTheDocument();
  });
});
