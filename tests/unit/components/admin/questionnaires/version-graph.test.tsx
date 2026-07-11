/**
 * VersionGraph — read-only structural graph render tests.
 *
 * Scope: DOM output the component produces from a `VersionGraphView` fixture.
 * The component is purely presentational (no hooks, no async, no 'use client')
 * so React Testing Library renders it synchronously.
 *
 * Tested behaviours:
 *   - Goal text renders; "Not set" fallback when goal is null.
 *   - InferredBadge appears next to the goal when goalProvenance === 'inferred'.
 *   - Audience fields render with their human-readable labels.
 *   - InferredBadge appears next to an audience field value when its provenance is 'inferred'.
 *   - "Not set" fallback when audience is null.
 *   - Tags render via <TagChip>.
 *   - Empty-sections fallback text.
 *   - Section titles, descriptions, and question prompts render.
 *   - Question type labels are mapped via QUESTION_TYPE_LABELS.
 *   - "required" badge renders only when q.required is true.
 *   - Guidelines render when present.
 *   - Extraction-confidence renders when not null.
 *   - "No questions" fallback for a section with no questions.
 *
 * @see components/admin/questionnaires/version-graph.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { VersionGraph } from '@/components/admin/questionnaires/version-graph';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type {
  VersionGraphView,
  SectionView,
  QuestionSlotView,
} from '@/lib/app/questionnaire/views';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeQuestion(over: Partial<QuestionSlotView> = {}): QuestionSlotView {
  return {
    id: 'q-1',
    ordinal: 0,
    key: 'q_role',
    prompt: 'What is your role?',
    guidelines: null,
    rationale: null,
    type: 'free_text',
    typeConfig: null,
    required: false,
    weight: 1,
    extractionConfidence: null,
    tags: [],
    ...over,
  };
}

function makeSection(over: Partial<SectionView> = {}): SectionView {
  return {
    id: 's-1',
    ordinal: 0,
    title: 'Background',
    description: null,
    questions: [makeQuestion()],
    ...over,
  };
}

function makeGraph(over: Partial<VersionGraphView> = {}): VersionGraphView {
  return {
    id: 'v-1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
    goal: 'Understand onboarding churn',
    audience: { role: 'Customer success manager', expertiseLevel: 'intermediate' },
    goalProvenance: 'admin-supplied',
    audienceProvenance: { role: 'admin-supplied', expertiseLevel: 'inferred' },
    sections: [makeSection()],
    tags: [],
    config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: false },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Goal section
// ---------------------------------------------------------------------------

describe('VersionGraph — goal', () => {
  it('renders the goal text', () => {
    render(<VersionGraph graph={makeGraph()} />);
    expect(screen.getByText('Understand onboarding churn')).toBeInTheDocument();
  });

  it('renders "Not set" italic span when goal is null', () => {
    render(<VersionGraph graph={makeGraph({ goal: null })} />);
    expect(screen.getByText('Not set')).toBeInTheDocument();
  });

  it('does NOT render the InferredBadge when goalProvenance is admin-supplied', () => {
    // Use all-admin-supplied provenances so no inferred badge appears anywhere on the page.
    render(
      <VersionGraph
        graph={makeGraph({
          goalProvenance: 'admin-supplied',
          audienceProvenance: { role: 'admin-supplied', expertiseLevel: 'admin-supplied' },
        })}
      />
    );
    // With every provenance = 'admin-supplied', no inferred badge should appear.
    expect(screen.queryByText('inferred')).not.toBeInTheDocument();
  });

  it('renders the InferredBadge next to the goal when goalProvenance is inferred', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          goalProvenance: 'inferred',
          // No audience fields to avoid other inferred badges muddying the assertion.
          audience: null,
          audienceProvenance: null,
        })}
      />
    );
    expect(screen.getByText('inferred')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Audience section
// ---------------------------------------------------------------------------

describe('VersionGraph — audience', () => {
  it('renders audience field labels and values', () => {
    render(<VersionGraph graph={makeGraph()} />);
    // Human-readable label from AUDIENCE_FIELD_LABEL
    expect(screen.getByText('Role')).toBeInTheDocument();
    expect(screen.getByText('Customer success manager')).toBeInTheDocument();
    expect(screen.getByText('Expertise level')).toBeInTheDocument();
    expect(screen.getByText('intermediate')).toBeInTheDocument();
  });

  it('renders "Not set" italic when audience is null', () => {
    render(<VersionGraph graph={makeGraph({ audience: null, audienceProvenance: null })} />);
    // Goal renders its own "Not set" if goal is null too; here goal is set so this is audience's.
    expect(screen.getByText('Not set')).toBeInTheDocument();
  });

  it('does NOT render an InferredBadge for an audience field whose provenance is admin-supplied', () => {
    // role = admin-supplied; expertiseLevel = admin-supplied → no inferred badge anywhere.
    render(
      <VersionGraph
        graph={makeGraph({
          audienceProvenance: { role: 'admin-supplied', expertiseLevel: 'admin-supplied' },
          goalProvenance: 'admin-supplied',
        })}
      />
    );
    expect(screen.queryByText('inferred')).not.toBeInTheDocument();
  });

  it('renders InferredBadge next to an audience field value when its provenance is inferred', () => {
    // expertiseLevel is inferred → its dd cell should contain an "inferred" badge.
    render(<VersionGraph graph={makeGraph()} />);
    // audienceProvenance.expertiseLevel = 'inferred' in makeGraph's default.
    const expertiseDd = screen.getByText('intermediate').closest('dd');
    expect(expertiseDd).not.toBeNull();
    // The inferred badge sits inside the same <dd>.
    expect(within(expertiseDd!).getByText('inferred')).toBeInTheDocument();
  });

  it('does NOT render an InferredBadge in the dd of a non-inferred audience field', () => {
    // role = admin-supplied → its dd must have NO inferred badge.
    render(<VersionGraph graph={makeGraph()} />);
    const roleDd = screen.getByText('Customer success manager').closest('dd');
    expect(roleDd).not.toBeNull();
    expect(within(roleDd!).queryByText('inferred')).not.toBeInTheDocument();
  });

  it('omits audience fields whose value is null or undefined', () => {
    // Only role is set; description, expertiseLevel, etc. are absent.
    render(
      <VersionGraph
        graph={makeGraph({
          audience: { role: 'HR lead' },
          audienceProvenance: { role: 'admin-supplied' },
        })}
      />
    );
    expect(screen.queryByText('Description')).not.toBeInTheDocument();
    expect(screen.queryByText('Expertise level')).not.toBeInTheDocument();
    expect(screen.getByText('Role')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tags section
// ---------------------------------------------------------------------------

describe('VersionGraph — tags', () => {
  it('renders tag labels via TagChip when tags are present', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          tags: [
            { id: 't-1', label: 'Churn', color: 'red' },
            { id: 't-2', label: 'Onboarding', color: null },
          ],
        })}
      />
    );
    expect(screen.getByText('Churn')).toBeInTheDocument();
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
  });

  it('does NOT render the tags section when tags array is empty', () => {
    render(<VersionGraph graph={makeGraph({ tags: [] })} />);
    expect(screen.queryByText('Tags')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sections / questions
// ---------------------------------------------------------------------------

describe('VersionGraph — sections', () => {
  it('renders the empty-sections fallback when sections array is empty', () => {
    render(<VersionGraph graph={makeGraph({ sections: [] })} />);
    expect(screen.getByText(/this version has no sections/i)).toBeInTheDocument();
  });

  it('renders section titles with their 1-based ordinal', () => {
    const sections = [
      makeSection({ id: 's-1', ordinal: 0, title: 'Background', questions: [] }),
      makeSection({ id: 's-2', ordinal: 1, title: 'Goals', questions: [] }),
    ];
    render(<VersionGraph graph={makeGraph({ sections })} />);

    expect(screen.getByText('Background')).toBeInTheDocument();
    expect(screen.getByText('Goals')).toBeInTheDocument();
    // Ordinal labels: ordinal 0 → "1.", ordinal 1 → "2."
    expect(screen.getByText('1.')).toBeInTheDocument();
    expect(screen.getByText('2.')).toBeInTheDocument();
  });

  it('renders the section description when present', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [makeSection({ description: 'Gather context about the respondent.' })],
        })}
      />
    );
    expect(screen.getByText('Gather context about the respondent.')).toBeInTheDocument();
  });

  it('does NOT render a description element when section.description is null', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [makeSection({ description: null })],
        })}
      />
    );
    // The section description paragraph is conditionally rendered — query to check absence.
    // We can check by looking for a muted-description paragraph; since no other muted text
    // is in the description slot, we verify no stray empty paragraph appears.
    const sectionEl = screen.getByText('Background').closest('section');
    expect(sectionEl).not.toBeNull();
    // The description <p> is absent — only the title <h3> and question list should be present.
    const descParagraphs = sectionEl!.querySelectorAll('div.border-b p');
    expect(descParagraphs.length).toBe(0);
  });

  it('renders the "No questions" fallback when a section has no questions', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [makeSection({ questions: [] })],
        })}
      />
    );
    expect(screen.getByText(/no questions in this section/i)).toBeInTheDocument();
  });

  it('renders question prompts', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [
            makeSection({
              questions: [
                makeQuestion({ id: 'q-1', prompt: 'What is your role?' }),
                makeQuestion({ id: 'q-2', prompt: 'How long have you been in this role?' }),
              ],
            }),
          ],
        })}
      />
    );
    expect(screen.getByText('What is your role?')).toBeInTheDocument();
    expect(screen.getByText('How long have you been in this role?')).toBeInTheDocument();
  });

  it('renders the question type label via QUESTION_TYPE_LABELS', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [
            makeSection({
              questions: [makeQuestion({ type: 'single_choice' })],
            }),
          ],
        })}
      />
    );
    // QUESTION_TYPE_LABELS.single_choice === 'Multi-Choice (One Answer)'
    expect(screen.getByText('Multi-Choice (One Answer)')).toBeInTheDocument();
  });

  it('falls back to the raw type string when the type is unknown', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [
            makeSection({
              // Force an unexpected type through via type assertion (simulates schema drift).
              questions: [makeQuestion({ type: 'legacy_unknown' as never })],
            }),
          ],
        })}
      />
    );
    // QUESTION_TYPE_LABELS['legacy_unknown'] is undefined → the component renders q.type.
    expect(screen.getByText('legacy_unknown')).toBeInTheDocument();
  });

  it('renders the "required" badge when q.required is true', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [makeSection({ questions: [makeQuestion({ required: true })] })],
        })}
      />
    );
    expect(screen.getByText('required')).toBeInTheDocument();
  });

  it('does NOT render the "required" badge when q.required is false', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [makeSection({ questions: [makeQuestion({ required: false })] })],
        })}
      />
    );
    expect(screen.queryByText('required')).not.toBeInTheDocument();
  });

  it('renders question guidelines when present', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [
            makeSection({
              questions: [makeQuestion({ guidelines: 'Be concise — a sentence or two is fine.' })],
            }),
          ],
        })}
      />
    );
    expect(screen.getByText('Be concise — a sentence or two is fine.')).toBeInTheDocument();
  });

  it('does NOT render a guidelines paragraph when q.guidelines is null', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [makeSection({ questions: [makeQuestion({ guidelines: null })] })],
        })}
      />
    );
    // The only text in the question card should be the prompt + key line + type badge.
    // Assert the guidelines element is absent by checking the unique sentinel text.
    expect(screen.queryByText('Be concise — a sentence or two is fine.')).not.toBeInTheDocument();
  });

  it('renders the extraction confidence when not null', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [
            makeSection({
              questions: [makeQuestion({ extractionConfidence: 0.87 })],
            }),
          ],
        })}
      />
    );
    // Math.round(0.87 * 100) === 87 → "confidence: 87%"
    expect(screen.getByText(/confidence: 87%/i)).toBeInTheDocument();
  });

  it('does NOT render a confidence span when extractionConfidence is null', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [makeSection({ questions: [makeQuestion({ extractionConfidence: null })] })],
        })}
      />
    );
    expect(screen.queryByText(/confidence:/i)).not.toBeInTheDocument();
  });

  it('renders the question key', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [makeSection({ questions: [makeQuestion({ key: 'churn_reason' })] })],
        })}
      />
    );
    expect(screen.getByText(/key: churn_reason/)).toBeInTheDocument();
  });

  it('renders question-level tags via TagChip', () => {
    render(
      <VersionGraph
        graph={makeGraph({
          sections: [
            makeSection({
              questions: [
                makeQuestion({
                  tags: [{ id: 't-q1', label: 'sentiment', color: 'blue' }],
                }),
              ],
            }),
          ],
        })}
      />
    );
    expect(screen.getByText('sentiment')).toBeInTheDocument();
  });
});
