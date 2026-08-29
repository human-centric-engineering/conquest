// @vitest-environment happy-dom

/**
 * ExtractionFidelityBand component tests.
 *
 * Anti-green-bar: these assert the WORDS an admin reads, not that a component mounted. The band's
 * whole job is to say something true and actionable about an extraction, and the two ways it can
 * fail are both silent — appearing when there is nothing to say (which trains people to ignore
 * it), or reporting a clean bill when the run actually found something.
 *
 * @see components/admin/questionnaires/extraction-fidelity-band.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ExtractionFidelityBand } from '@/components/admin/questionnaires/extraction-fidelity-band';
import type { VersionFidelityView } from '@/lib/app/questionnaire/ingestion/fidelity-detail';

function view(over: Partial<VersionFidelityView> = {}): VersionFidelityView {
  return {
    totalCount: 22,
    flagged: [],
    flaggedCount: 0,
    repairOutcome: 'none_flagged',
    coverage: { sourceQuestionCount: 22, assessment: 'matches' },
    unattributedPromptKeys: [],
    unattributedPromptCount: 0,
    disallowedEditCount: 0,
    fileName: 'instrument.docx',
    checkedAt: '2026-08-20T10:30:00.000Z',
    verifierUnavailable: false,
    ...over,
  };
}

describe('ExtractionFidelityBand', () => {
  it('renders nothing when no verify pass ran', () => {
    const { container } = render(<ExtractionFidelityBand fidelity={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on a clean extraction', () => {
    // A panel that always appears saying "all good" is a panel people stop reading, which costs
    // exactly the runs where it does have something to say.
    const { container } = render(<ExtractionFidelityBand fidelity={view()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the source simply could not be counted', () => {
    // The common case: most instruments do not number their questions.
    const { container } = render(
      <ExtractionFidelityBand
        fidelity={view({ coverage: { sourceQuestionCount: null, assessment: 'uncountable' } })}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the document it re-read, so the finding is anchored to a file', () => {
    render(<ExtractionFidelityBand fidelity={view({ flaggedCount: 1 })} />);
    expect(screen.getByText('instrument.docx')).toBeInTheDocument();
  });

  it('states both numbers on a missing-questions verdict, with the critic’s explanation', () => {
    render(
      <ExtractionFidelityBand
        fidelity={view({
          totalCount: 19,
          coverage: {
            sourceQuestionCount: 22,
            assessment: 'missing_questions',
            detail: 'Section 4 does not appear to have been read.',
          },
        })}
      />
    );

    expect(screen.getByText(/22 questions, but only 19 were extracted/i)).toBeInTheDocument();
    expect(screen.getByText(/Section 4 does not appear to have been read/i)).toBeInTheDocument();
  });

  it('says the questions were saved as-is when the repair pass could not fix them', () => {
    // The distinction that matters: `repaired` needs no action, `repair_failed` means the flagged
    // questions are live exactly as first extracted and nothing else in the product says so.
    render(
      <ExtractionFidelityBand
        fidelity={view({ flaggedCount: 2, repairOutcome: 'repair_failed' })}
      />
    );

    expect(screen.getByText(/saved exactly as first extracted/i)).toBeInTheDocument();
  });

  it('does not claim a correction when so many were flagged that the pass was skipped', () => {
    render(
      <ExtractionFidelityBand
        fidelity={view({ flaggedCount: 14, repairOutcome: 'skipped_systemic' })}
      />
    );

    expect(screen.getByText(/correction pass was skipped/i)).toBeInTheDocument();
    expect(screen.queryByText(/corrected\./i)).not.toBeInTheDocument();
  });

  it('lists the flagged question keys when the run still carries them', () => {
    render(
      <ExtractionFidelityBand
        fidelity={view({
          flaggedCount: 1,
          repairOutcome: 'repaired',
          flagged: [
            { key: 'plant_proximity', issue: 'matrix_flattened', detail: 'Grid lost rows.' },
          ],
        })}
      />
    );

    expect(screen.getByText('plant_proximity')).toBeInTheDocument();
  });

  it('still reports the flagged count when the snapshot no longer holds the verdicts', () => {
    // Long questionnaire, capped snapshot. Reporting `flagged.length` here would say "0 flagged"
    // on a run that flagged three.
    render(
      <ExtractionFidelityBand
        fidelity={view({ flaggedCount: 3, repairOutcome: 'repaired', flagged: [] })}
      />
    );

    expect(screen.getByText(/3 questions looked unfaithful/i)).toBeInTheDocument();
  });

  it('explains an unattributed prompt as an edit with no record, and names it', () => {
    render(
      <ExtractionFidelityBand
        fidelity={view({ unattributedPromptCount: 1, unattributedPromptKeys: ['register_owner'] })}
      />
    );

    expect(
      screen.getByText(/matches neither the document nor any change below/i)
    ).toBeInTheDocument();
    // The consequence, not just the fact: an unrecorded rewrite is indistinguishable from the
    // author's own wording in the editor, and there is nothing to revert it to.
    expect(screen.getByText(/in the editor as your own words/i)).toBeInTheDocument();
    expect(screen.getByText('register_owner')).toBeInTheDocument();
  });

  it('reports an unattributed count from a legacy row that cannot name the questions', () => {
    render(<ExtractionFidelityBand fidelity={view({ unattributedPromptCount: 2 })} />);

    expect(screen.getByText(/2 questions/)).toBeInTheDocument();
  });

  it('leads with the check never having run, since every other reassurance would be vacuous', () => {
    render(<ExtractionFidelityBand fidelity={view({ verifierUnavailable: true })} />);

    expect(
      screen.getByText(/has not been re-read against the document at all/i)
    ).toBeInTheDocument();
  });

  it('stays silent for a disallowed edit alone — a build signal with no admin action', () => {
    const { container } = render(
      <ExtractionFidelityBand fidelity={view({ disallowedEditCount: 6 })} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
