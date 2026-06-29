/**
 * QuestionnaireSplash — the respondent intro screen.
 *
 * @see components/app/questionnaire/intro/questionnaire-splash.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { QuestionnaireSplash } from '@/components/app/questionnaire/intro/questionnaire-splash';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';

function intro(over: Partial<ResolvedSessionIntro> = {}): ResolvedSessionIntro {
  return {
    enabled: true,
    questionnaireTitle: 'Team Health Check',
    background: '',
    copy: {
      howItWorks: { heading: 'How it works', body: 'This is a conversation, not a form.' },
      whatYouGet: { heading: 'What you’ll get at the end', body: 'A personalised written report.' },
      goodToKnow: ['There are no right or wrong answers — just answer honestly.'],
      buttonLabel: 'Start the conversation',
    },
    ...over,
  };
}

describe('QuestionnaireSplash', () => {
  it('renders the questionnaire title and the derived sections', () => {
    render(<QuestionnaireSplash intro={intro()} onProceed={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Team Health Check' })).toBeInTheDocument();
    expect(screen.getByText('How it works')).toBeInTheDocument();
    expect(screen.getByText(/conversation, not a form/i)).toBeInTheDocument();
    expect(screen.getByText('What you’ll get at the end')).toBeInTheDocument();
    expect(screen.getByText(/no right or wrong answers/i)).toBeInTheDocument();
  });

  it('renders the admin background section when present', () => {
    render(
      <QuestionnaireSplash
        intro={intro({ background: 'Run by **Acme** for the team.' })}
        onProceed={vi.fn()}
      />
    );
    expect(screen.getByText('About this questionnaire')).toBeInTheDocument();
    // Markdown bold renders to <strong>.
    expect(screen.getByText('Acme').tagName).toBe('STRONG');
  });

  it('hides the background section when empty', () => {
    render(<QuestionnaireSplash intro={intro({ background: '' })} onProceed={vi.fn()} />);
    expect(screen.queryByText('About this questionnaire')).not.toBeInTheDocument();
  });

  it('omits the "what you’ll get" section when there is no report copy', () => {
    render(
      <QuestionnaireSplash
        intro={intro({ copy: { ...intro().copy, whatYouGet: null } })}
        onProceed={vi.fn()}
      />
    );
    expect(screen.queryByText('What you’ll get at the end')).not.toBeInTheDocument();
  });

  it('labels the proceed button from the copy and fires onProceed on click', async () => {
    const onProceed = vi.fn();
    render(<QuestionnaireSplash intro={intro()} onProceed={onProceed} />);
    const button = screen.getByRole('button', { name: /start the conversation/i });
    await userEvent.click(button);
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  it('labels the CTA "Continue" only once the respondent has made progress', () => {
    // Default (no progress) keeps the begin label even though the workspace may be "started".
    const { rerender } = render(<QuestionnaireSplash intro={intro()} onProceed={vi.fn()} />);
    expect(screen.getByRole('button', { name: /start the conversation/i })).toBeInTheDocument();

    // With progress (≥1 answer), it switches to Continue.
    rerender(<QuestionnaireSplash intro={intro()} inProgress onProceed={vi.fn()} />);
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /start the conversation/i })
    ).not.toBeInTheDocument();
  });
});
