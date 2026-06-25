/**
 * QuestionConfigWarning — the amber "not launch-ready" cue render tests.
 *
 * Scope: the DOM the component produces for a resolved issue. The verdict logic
 * lives in `questionConfigIssue` (covered by config-health.test); here we feed
 * the component issues produced by that real function and assert it renders the
 * right chip, and renders nothing for a null issue.
 *
 * @see components/admin/questionnaires/question-config-warning.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { QuestionConfigWarning } from '@/components/admin/questionnaires/question-config-warning';
import { questionConfigIssue } from '@/lib/app/questionnaire/authoring';

describe('QuestionConfigWarning', () => {
  it('renders nothing when there is no issue', () => {
    const { container } = render(<QuestionConfigWarning issue={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the range chip for a likert missing its bounds', () => {
    render(<QuestionConfigWarning issue={questionConfigIssue('likert', { labels: [] })} />);
    expect(screen.getByText('Set scale range')).toBeInTheDocument();
  });

  it('shows the labels chip for a bounded likert with no labels', () => {
    render(<QuestionConfigWarning issue={questionConfigIssue('likert', { min: 1, max: 5 })} />);
    expect(screen.getByText('Add scale labels')).toBeInTheDocument();
  });

  it('shows the options chip for a choice question with too few options', () => {
    render(
      <QuestionConfigWarning
        issue={questionConfigIssue('single_choice', { choices: [{ value: 'a', label: 'A' }] })}
      />
    );
    expect(screen.getByText('Add options')).toBeInTheDocument();
  });

  it('exposes the cue to assistive tech via role="status"', () => {
    render(<QuestionConfigWarning issue={questionConfigIssue('likert', { min: 1, max: 5 })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Add scale labels');
  });

  it('merges an overriding className via cn()', () => {
    render(
      <QuestionConfigWarning
        issue={questionConfigIssue('likert', { min: 1, max: 5 })}
        className="ml-4"
      />
    );
    expect(screen.getByRole('status')).toHaveClass('ml-4');
  });
});
