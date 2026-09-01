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
    droppedNonQuestionKeys: [],
    droppedNonQuestionCount: 0,
    retainedCount: 22,
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

  describe('spans removed for not being questions', () => {
    it('says what was removed and where to get it back', () => {
      render(
        <ExtractionFidelityBand
          fidelity={view({
            flaggedCount: 1,
            droppedNonQuestionCount: 1,
            droppedNonQuestionKeys: ['bot_script'],
          })}
        />
      );

      expect(screen.getByText(/removed because it is not a question/i)).toBeInTheDocument();
      // The route back matters more than the fact. Without it the admin knows something vanished
      // and has no way to judge whether it should have.
      expect(screen.getByText(/restored from there/i)).toBeInTheDocument();
      expect(screen.getByText('bot_script')).toBeInTheDocument();
    });

    it('stops promising nothing was changed once something was deleted', () => {
      render(
        <ExtractionFidelityBand
          fidelity={view({
            flaggedCount: 1,
            droppedNonQuestionCount: 1,
            droppedNonQuestionKeys: ['bot_script'],
          })}
        />
      );

      expect(screen.queryByText(/Nothing here was blocked or changed/i)).not.toBeInTheDocument();
      expect(screen.getByText(/can be undone below/i)).toBeInTheDocument();
    });

    it('does not also count a removed question as one left unfaithful in the draft', () => {
      // Three flagged, two of them deleted. "3 questions looked unfaithful ... they are saved
      // exactly as first extracted" would be false about two of the three.
      render(
        <ExtractionFidelityBand
          fidelity={view({
            flaggedCount: 3,
            repairOutcome: 'repair_failed',
            droppedNonQuestionCount: 2,
            droppedNonQuestionKeys: ['bot_script', 'section_transition'],
          })}
        />
      );

      expect(screen.getByText(/1 question looked unfaithful/i)).toBeInTheDocument();
      expect(screen.queryByText(/3 questions looked unfaithful/i)).not.toBeInTheDocument();
    });

    it('drops the repair line entirely when every flag was a removal', () => {
      render(
        <ExtractionFidelityBand
          fidelity={view({
            flaggedCount: 2,
            droppedNonQuestionCount: 2,
            droppedNonQuestionKeys: ['bot_script', 'section_transition'],
          })}
        />
      );

      expect(screen.queryByText(/looked unfaithful/i)).not.toBeInTheDocument();
      expect(screen.getByText(/2 lines were removed/i)).toBeInTheDocument();
    });

    it('does not badge a removed question in the go-and-re-read list', () => {
      // It is already named above, and it is not there to re-read.
      render(
        <ExtractionFidelityBand
          fidelity={view({
            flaggedCount: 2,
            repairOutcome: 'repaired',
            flagged: [
              { key: 'bot_script', issue: 'not_a_question', detail: null },
              { key: 'satisfaction', issue: 'type_mismatch', detail: null },
            ],
            droppedNonQuestionCount: 1,
            droppedNonQuestionKeys: ['bot_script'],
          })}
        />
      );

      expect(screen.getAllByText('bot_script')).toHaveLength(1);
      expect(screen.getByText('satisfaction')).toBeInTheDocument();
    });
  });

  describe('the count the questionnaire actually holds', () => {
    it('names both the extracted count and what survived, when they differ', () => {
      // The critic compared 12 against the document; the editor lists 9. Quoting only the first
      // leaves the admin holding a number that describes nothing they can see.
      render(
        <ExtractionFidelityBand
          fidelity={view({
            coverage: { sourceQuestionCount: 20, assessment: 'missing_questions' },
            totalCount: 12,
            retainedCount: 9,
            flaggedCount: 3,
            droppedNonQuestionCount: 3,
            droppedNonQuestionKeys: ['bot_script', 'transition', 'how_to_answer'],
          })}
        />
      );

      expect(screen.getByText(/but only 12 were extracted/i)).toBeInTheDocument();
      expect(screen.getByText(/now holds 9 questions/i)).toBeInTheDocument();
    });

    it('says nothing extra when the count never moved', () => {
      // The overwhelming majority of ingests. A clause repeating the number just said is noise.
      render(
        <ExtractionFidelityBand
          fidelity={view({
            coverage: { sourceQuestionCount: 20, assessment: 'missing_questions' },
            totalCount: 12,
            retainedCount: 12,
          })}
        />
      );

      expect(screen.getByText(/but only 12 were extracted/i)).toBeInTheDocument();
      expect(screen.queryByText(/now holds/i)).not.toBeInTheDocument();
    });
  });

  describe('a removal the ceiling refused', () => {
    it('says the removal was considered and abandoned, rather than nothing at all', () => {
      // Four flagged as script on a 12-question document is past the ceiling, so nothing is
      // dropped. Before this the panel said only "4 questions looked unfaithful to the document",
      // and the abandoned removal lived in a log line no admin reads.
      render(
        <ExtractionFidelityBand
          fidelity={view({
            flaggedCount: 4,
            totalCount: 12,
            retainedCount: 12,
            flagged: [
              { key: 'a', issue: 'not_a_question', detail: null },
              { key: 'b', issue: 'not_a_question', detail: null },
              { key: 'c', issue: 'not_a_question', detail: null },
              { key: 'd', issue: 'not_a_question', detail: null },
            ],
            droppedNonQuestionCount: 0,
            droppedNonQuestionKeys: [],
          })}
        />
      );

      expect(screen.getByText(/4 lines looked like interviewer script/i)).toBeInTheDocument();
      expect(screen.getByText(/so none were removed/i)).toBeInTheDocument();
      // They are still there, so the flagged badges must still name them to go and re-read.
      expect(screen.getByText('a')).toBeInTheDocument();
    });

    it('does not name a number it cannot stand behind when the snapshot was capped', () => {
      // A long questionnaire's verdict snapshot is truncated, so the visible list understates the
      // count. Speaking the short number would tell the admin the critic objected to less than it
      // did, which is the wrong direction to be wrong about a removal.
      render(
        <ExtractionFidelityBand
          fidelity={view({
            flaggedCount: 40,
            totalCount: 140,
            retainedCount: 140,
            flagged: [{ key: 'a', issue: 'not_a_question', detail: null }],
            droppedNonQuestionCount: 0,
            droppedNonQuestionKeys: [],
          })}
        />
      );

      expect(screen.getByText(/Some lines looked like interviewer script/i)).toBeInTheDocument();
      expect(screen.queryByText(/^1 line looked/i)).not.toBeInTheDocument();
    });

    it('stays quiet when the removal actually happened', () => {
      // Mutually exclusive with the removal line: saying both would report one event twice.
      render(
        <ExtractionFidelityBand
          fidelity={view({
            flaggedCount: 1,
            droppedNonQuestionCount: 1,
            droppedNonQuestionKeys: ['bot_script'],
            flagged: [{ key: 'bot_script', issue: 'not_a_question', detail: null }],
          })}
        />
      );

      expect(screen.queryByText(/too many to remove safely/i)).not.toBeInTheDocument();
      expect(screen.getByText(/removed because it is not a question/i)).toBeInTheDocument();
    });
  });

  it('stays silent for a disallowed edit alone — a build signal with no admin action', () => {
    const { container } = render(
      <ExtractionFidelityBand fidelity={view({ disallowedEditCount: 6 })} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
