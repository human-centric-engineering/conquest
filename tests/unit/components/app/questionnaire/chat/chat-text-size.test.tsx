import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { ChatTextSize } from '@/components/app/questionnaire/chat/chat-text-size';
import {
  CHAT_TEXT_SCALES,
  DEFAULT_CHAT_TEXT_SCALE_INDEX,
} from '@/lib/app/questionnaire/chat/text-scale';

/**
 * The respondent's text-size stepper. Its whole job is to be operable by someone who is struggling
 * to read the screen, so the assertions here are about naming and reachability rather than looks:
 * the buttons must be findable by accessible name (the visible glyphs are `aria-hidden`), must
 * disable at the ends of the ladder, and must announce the resulting size — pressing a button that
 * then disables itself moves focus nowhere and shows a non-sighted user nothing otherwise.
 */
const TOP = CHAT_TEXT_SCALES.length - 1;

describe('ChatTextSize', () => {
  it('exposes both controls by accessible name despite the icon-only glyphs', () => {
    render(
      React.createElement(ChatTextSize, {
        index: DEFAULT_CHAT_TEXT_SCALE_INDEX,
        onStep: vi.fn(),
      })
    );
    expect(screen.getByRole('button', { name: 'Increase text size' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decrease text size' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Text size' })).toBeTruthy();
  });

  it('emits a direction rather than a computed index', async () => {
    const onStep = vi.fn();
    const user = userEvent.setup();
    render(React.createElement(ChatTextSize, { index: DEFAULT_CHAT_TEXT_SCALE_INDEX, onStep }));

    await user.click(screen.getByRole('button', { name: 'Increase text size' }));
    expect(onStep).toHaveBeenCalledWith('up');

    await user.click(screen.getByRole('button', { name: 'Decrease text size' }));
    expect(onStep).toHaveBeenCalledWith('down');
  });

  it('blocks increase at the largest step so repeated presses cannot wrap', async () => {
    const onStep = vi.fn();
    const user = userEvent.setup();
    render(React.createElement(ChatTextSize, { index: TOP, onStep }));

    const grow = screen.getByRole('button', { name: 'Increase text size' });
    expect(grow.getAttribute('aria-disabled')).toBe('true');
    await user.click(grow);
    expect(onStep).not.toHaveBeenCalled();

    // The other direction stays live — a ceiling must not strand the respondent.
    expect(
      screen.getByRole('button', { name: 'Decrease text size' }).getAttribute('aria-disabled')
    ).toBe('false');
  });

  it('blocks decrease at the smallest step', async () => {
    const onStep = vi.fn();
    const user = userEvent.setup();
    render(React.createElement(ChatTextSize, { index: 0, onStep }));

    const shrink = screen.getByRole('button', { name: 'Decrease text size' });
    expect(shrink.getAttribute('aria-disabled')).toBe('true');
    await user.click(shrink);
    expect(onStep).not.toHaveBeenCalled();

    expect(
      screen.getByRole('button', { name: 'Increase text size' }).getAttribute('aria-disabled')
    ).toBe('false');
  });

  /**
   * The reason the bounds use `aria-disabled` rather than the native `disabled`: a native disabled
   * button leaves the tab order the moment it is pressed, dropping focus to <body>. A keyboard user
   * stepping to the end of the ladder would lose their place mid-adjustment.
   */
  it('keeps a bounded button focusable so keyboard focus is not dropped at the ladder end', () => {
    render(React.createElement(ChatTextSize, { index: TOP, onStep: vi.fn() }));
    const grow = screen.getByRole('button', { name: 'Increase text size' });

    expect(grow.hasAttribute('disabled')).toBe(false);
    grow.focus();
    expect(document.activeElement).toBe(grow);
  });

  it('announces the current size politely, and updates as it changes', () => {
    const { rerender } = render(
      React.createElement(ChatTextSize, {
        index: DEFAULT_CHAT_TEXT_SCALE_INDEX,
        onStep: vi.fn(),
      })
    );
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Default');

    rerender(React.createElement(ChatTextSize, { index: TOP, onStep: vi.fn() }));
    expect(screen.getByRole('status').textContent).toContain('Largest');
  });

  it('renders a corrupt index as the default rather than blank', () => {
    render(
      React.createElement(ChatTextSize, {
        index: 99,
        onStep: vi.fn(),
      })
    );
    expect(screen.getByRole('status').textContent).toContain('Default');
  });
});
