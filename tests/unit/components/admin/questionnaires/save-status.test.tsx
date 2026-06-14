import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SaveStatus } from '@/components/admin/questionnaires/save-status';

/**
 * SaveStatus is the answer to "where's the Save button?" — the editor autosaves, so this
 * surfaces the live state. These lock the copy each state shows (the reassurance the
 * editor depends on) and that the floating pill pulses only while a write is in flight.
 */
describe('SaveStatus', () => {
  it('reassures that changes save automatically when idle', () => {
    render(<SaveStatus state="idle" lastSavedAt={null} />);
    expect(screen.getByText('Changes save automatically')).toBeInTheDocument();
  });

  it('shows a saving state while a write is in flight', () => {
    render(<SaveStatus state="saving" lastSavedAt={null} />);
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });

  it('confirms the save landed, with a relative timestamp', () => {
    render(<SaveStatus state="saved" lastSavedAt={Date.now()} />);
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('omits the timestamp when there is no recorded save', () => {
    render(<SaveStatus state="saved" lastSavedAt={null} />);
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
    expect(screen.queryByText('just now')).not.toBeInTheDocument();
  });

  it('surfaces a retry-able error state', () => {
    render(<SaveStatus state="error" lastSavedAt={null} />);
    expect(screen.getByText('Couldn’t save — try again')).toBeInTheDocument();
  });

  it('pulses the floating pill only while saving', () => {
    const { container, rerender } = render(
      <SaveStatus state="saving" lastSavedAt={null} variant="floating" />
    );
    expect(container.querySelector('.cq-pulse')).not.toBeNull();

    rerender(<SaveStatus state="saved" lastSavedAt={Date.now()} variant="floating" />);
    expect(container.querySelector('.cq-pulse')).toBeNull();
  });
});
