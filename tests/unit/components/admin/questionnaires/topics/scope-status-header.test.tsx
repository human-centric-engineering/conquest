// @vitest-environment happy-dom

/**
 * The Conditional Topics status header (F17.25).
 *
 * Two properties carry real weight here and the rest is layout:
 *
 *   1. **The switch is controlled by the server's value.** It renders what it is handed and calls
 *      back; it holds no draft. That is what makes a declined fork correct — nothing was written,
 *      so the next render puts the switch back where it was rather than leaving it in the position
 *      the admin clicked, describing a version that never existed.
 *   2. **`budgetSeconds === 0` means NO budget**, not a zero-second one. Rendering it through
 *      `formatSeconds` would print "0m", which reads as a limit so tight nothing can run.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';

import { ScopeStatusHeader } from '@/components/admin/questionnaires/topics/scope-status-header';

function renderHeader(props: Partial<ComponentProps<typeof ScopeStatusHeader>> = {}) {
  const onToggleEnabled = vi.fn();
  render(
    <ScopeStatusHeader
      enabled={false}
      topicCount={12}
      conditionalCount={4}
      uncoveredQuestions={0}
      alwaysSeconds={840}
      budgetSeconds={0}
      busy={false}
      onToggleEnabled={onToggleEnabled}
      {...props}
    />
  );
  return { onToggleEnabled };
}

const switchEl = () => document.getElementById('scope-status-enabled') as HTMLElement;

describe('ScopeStatusHeader — the on/off state', () => {
  it('says what OFF actually means, not just that it is off', () => {
    // An admin who reads "Off" and nothing else has to infer what off means, and the inference
    // people reach for — "broken", "not set up" — is wrong in a way that makes them start
    // changing things.
    renderHeader({ enabled: false });
    expect(
      screen.getByText(/every respondent is asked the whole questionnaire/i)
    ).toBeInTheDocument();
  });

  it('describes the on state in terms of what a respondent gets', () => {
    renderHeader({ enabled: true });
    expect(
      screen.getByText(/whichever conditional topics fit what they said/i)
    ).toBeInTheDocument();
  });

  it('reflects the value it is handed rather than any state of its own', () => {
    const { onToggleEnabled } = renderHeader({ enabled: false });

    fireEvent.click(switchEl());

    // It reports the intent and does NOT flip itself. A locally-drafted switch would sit in the
    // clicked position after a declined fork, describing a version that was never written.
    expect(onToggleEnabled).toHaveBeenCalledWith(true);
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('is disabled while a save is in flight', () => {
    renderHeader({ busy: true });
    expect(switchEl()).toBeDisabled();
  });
});

describe('ScopeStatusHeader — the time line', () => {
  it('says "no time limit set" for a budget of zero, never "0m"', () => {
    renderHeader({ budgetSeconds: 0 });

    expect(screen.getByText(/no time limit set/i)).toBeInTheDocument();
    expect(screen.queryByText('0m')).not.toBeInTheDocument();
  });

  it('formats a real budget through the house formatter', () => {
    renderHeader({ budgetSeconds: 900, alwaysSeconds: 840 });

    expect(screen.getByText('15m')).toBeInTheDocument();
    expect(screen.getByText('14m')).toBeInTheDocument();
  });
});

describe('ScopeStatusHeader — the counts', () => {
  it('shows topics and conditionals', () => {
    renderHeader({ topicCount: 12, conditionalCount: 4 });

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('surfaces uncovered questions — the one number that changes what switching on DOES', () => {
    renderHeader({ uncoveredQuestions: 3 });
    expect(screen.getByText(/questions in no topic/i)).toBeInTheDocument();
  });

  it('says nothing about uncovered questions when there are none', () => {
    renderHeader({ uncoveredQuestions: 0 });
    expect(screen.queryByText(/in no topic/i)).not.toBeInTheDocument();
  });

  it('uses the singular for one uncovered question', () => {
    renderHeader({ uncoveredQuestions: 1 });
    expect(screen.getByText(/question in no topic/i)).toBeInTheDocument();
  });
});
