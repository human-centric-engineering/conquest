/**
 * The Adaptive Scope issue strip (F17.25) — the summary half of the two-level pattern
 * `config-conflicts.tsx` established.
 *
 * What matters here is that it never becomes a SECOND opinion about what is wrong. It renders the
 * same `validateAdaptiveScope` output `ScopeIssues` does, so the assertions are about emphasis and
 * affordance — errors first, consequences named, and a row that can actually take you somewhere.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ScopeIssueStrip } from '@/components/admin/questionnaires/topics/scope-issue-strip';
import type { ScopeIssue } from '@/lib/app/questionnaire/scope/validate';

const err = (over: Partial<ScopeIssue> = {}): ScopeIssue => ({
  severity: 'error',
  code: 'orphaned_questions',
  message: '3 questions belong to no topic.',
  ...over,
});

const warn = (over: Partial<ScopeIssue> = {}): ScopeIssue => ({
  severity: 'warning',
  code: 'no_conditional_topics',
  message: 'No topic is conditional yet.',
  ...over,
});

describe('ScopeIssueStrip', () => {
  it('renders nothing when the setup is coherent', () => {
    // The all-clear belongs to ScopeIssues lower down. A green strip pinned to the top of every
    // healthy tab is noise on the surface that has nothing to say.
    const { container } = render(<ScopeIssueStrip issues={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the consequence rather than the severity word', () => {
    // "Blocks launch" is literally true — `assertLaunchable` refuses on a non-zero error count —
    // and it is the half an admin can act on.
    render(<ScopeIssueStrip issues={[err(), err({ code: 'empty_topic' })]} />);
    expect(screen.getByText(/2 problems block launch/i)).toBeInTheDocument();
  });

  it('uses the singular for one error', () => {
    render(<ScopeIssueStrip issues={[err()]} />);
    expect(screen.getByText(/1 problem blocks launch/i)).toBeInTheDocument();
  });

  it('counts warnings separately, and does not call them blockers', () => {
    render(<ScopeIssueStrip issues={[err(), warn()]} />);

    expect(screen.getByText(/1 problem blocks launch/i)).toBeInTheDocument();
    expect(screen.getByText(/1 worth a look/i)).toBeInTheDocument();
  });

  it('reports warnings alone without claiming anything blocks launch', () => {
    render(<ScopeIssueStrip issues={[warn()]} />);

    expect(screen.getByText(/1 worth a look/i)).toBeInTheDocument();
    expect(screen.queryByText(/block/i)).not.toBeInTheDocument();
  });

  it('lists errors before warnings, whatever order they arrived in', () => {
    render(
      <ScopeIssueStrip issues={[warn({ message: 'WARNING ROW' }), err({ message: 'ERROR ROW' })]} />
    );

    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows[0]).toContain('ERROR ROW');
    expect(rows[1]).toContain('WARNING ROW');
  });

  it('caps the list and says how many are left', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      err({ message: `Issue ${i}`, topicKey: `t${i}` })
    );
    render(<ScopeIssueStrip issues={many} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText(/and 3 more below/i)).toBeInTheDocument();
  });
});

describe('ScopeIssueStrip — going to the thing that fixes it', () => {
  it('makes a topic-scoped finding a button that reports the issue', () => {
    const onSelectIssue = vi.fn();
    const issue = err({ topicKey: 'pricing', message: 'Pricing has no criteria.' });
    render(<ScopeIssueStrip issues={[issue]} onSelectIssue={onSelectIssue} />);

    fireEvent.click(screen.getByRole('button', { name: /Pricing has no criteria/i }));

    expect(onSelectIssue).toHaveBeenCalledWith(issue);
  });

  it('leaves a whole-setup finding as plain text', () => {
    // `no_opening_topic` is about the set, not a row. A button that moved the page somewhere
    // unrelated would be worse than no button.
    render(
      <ScopeIssueStrip
        issues={[err({ code: 'no_opening_topic', message: 'No topic is the opening.' })]}
        onSelectIssue={vi.fn()}
      />
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('No topic is the opening.')).toBeInTheDocument();
  });

  it('renders rows as text when no destination was supplied', () => {
    render(<ScopeIssueStrip issues={[err({ topicKey: 'pricing' })]} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('3 questions belong to no topic.')).toBeInTheDocument();
  });
});
