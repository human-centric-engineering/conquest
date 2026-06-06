/**
 * RefinementHistory — disclosure of an answer's revision trail (F7.2).
 *
 * @see components/app/questionnaire/panel/refinement-history.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { RefinementHistory } from '@/components/app/questionnaire/panel/refinement-history';
import type { PanelRefinementEntry } from '@/lib/app/questionnaire/panel/types';

const ENTRY: PanelRefinementEntry = {
  previousValue: 'Dev',
  previousProvenance: 'direct',
  newValue: 'Engineer',
  rationale: 'Clarified the title.',
  source: 'clarification',
  turnIndex: 2,
};

describe('RefinementHistory', () => {
  it('renders nothing when there is no history', () => {
    const { container } = render(<RefinementHistory entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a revision count trigger and reveals the change on open', () => {
    render(<RefinementHistory entries={[ENTRY]} />);
    // Collapsed: count is shown, detail is hidden.
    expect(screen.getByText('1 revision')).toBeInTheDocument();
    expect(screen.queryByText('Clarified the title.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('1 revision'));

    expect(screen.getByText('Engineer')).toBeInTheDocument();
    expect(screen.getByText(/Clarified the title\./)).toBeInTheDocument();
  });

  it('pluralises the revision count', () => {
    render(<RefinementHistory entries={[ENTRY, { ...ENTRY, newValue: 'Staff Engineer' }]} />);
    expect(screen.getByText('2 revisions')).toBeInTheDocument();
  });

  it('labels each refinement by its source once expanded', () => {
    render(
      <RefinementHistory
        entries={[
          { ...ENTRY, source: 'contradiction' },
          { ...ENTRY, source: 'correction' },
        ]}
      />
    );
    fireEvent.click(screen.getByText('2 revisions'));
    expect(screen.getByText(/Resolved a contradiction/)).toBeInTheDocument();
    expect(screen.getByText(/Corrected/)).toBeInTheDocument();
  });
});
