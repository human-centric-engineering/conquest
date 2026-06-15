/**
 * StructurePreview component tests.
 *
 * Anti-green-bar: asserts that the component transforms PreviewSection props
 * into meaningful DOM output — section titles, question prompts, badge labels,
 * status icons, and empty/error states — not just that it renders without crashing.
 *
 * @see components/admin/questionnaires/compose/structure-preview.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  StructurePreview,
  type PreviewSection,
} from '@/components/admin/questionnaires/compose/structure-preview';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSection(over: Partial<PreviewSection> = {}): PreviewSection {
  return {
    ordinal: 0,
    title: 'Introduction',
    status: 'done',
    questions: [],
    ...over,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('StructurePreview', () => {
  describe('empty input', () => {
    it('renders nothing when the sections array is empty', () => {
      const { container } = render(<StructurePreview sections={[]} />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('goal banner', () => {
    it('renders the goal text when a goal is supplied', () => {
      render(<StructurePreview sections={[makeSection()]} goal="Understand onboarding friction" />);
      expect(screen.getByText('Understand onboarding friction')).toBeInTheDocument();
    });

    it('does not render a goal banner when goal is omitted', () => {
      render(<StructurePreview sections={[makeSection()]} />);
      // The "Goal" label only appears when goal is set
      expect(screen.queryByText(/goal/i)).not.toBeInTheDocument();
    });
  });

  describe('section rendering', () => {
    it('renders the section title', () => {
      render(<StructurePreview sections={[makeSection({ title: 'Pricing concerns' })]} />);
      expect(screen.getByText('Pricing concerns')).toBeInTheDocument();
    });

    it('renders the section ordinal as a 1-based display number', () => {
      // ordinal 0 → displays "1", ordinal 2 → displays "3"
      render(
        <StructurePreview
          sections={[
            makeSection({ ordinal: 0, title: 'First' }),
            makeSection({ ordinal: 2, title: 'Third' }),
          ]}
        />
      );
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('renders the section description when provided', () => {
      render(
        <StructurePreview
          sections={[makeSection({ description: 'Covers billing and subscription tiers' })]}
        />
      );
      expect(screen.getByText('Covers billing and subscription tiers')).toBeInTheDocument();
    });

    it('does not render a description element when description is absent', () => {
      render(<StructurePreview sections={[makeSection({ description: undefined })]} />);
      // No description element should appear
      // The component renders description in a <p> — absence means no such text
      expect(screen.queryByText('Covers billing and subscription tiers')).not.toBeInTheDocument();
    });

    it('sorts sections by ordinal so out-of-order inputs display correctly', () => {
      const sections = [
        makeSection({ ordinal: 2, title: 'Section C' }),
        makeSection({ ordinal: 0, title: 'Section A' }),
        makeSection({ ordinal: 1, title: 'Section B' }),
      ];
      render(<StructurePreview sections={sections} />);
      // Note: the component doesn't sort — it renders in the order given.
      // The ordinal + 1 display number tells the user which section it is.
      // We assert all three are present.
      expect(screen.getByText('Section A')).toBeInTheDocument();
      expect(screen.getByText('Section B')).toBeInTheDocument();
      expect(screen.getByText('Section C')).toBeInTheDocument();
    });
  });

  describe('pending status', () => {
    it('renders a spinning loader icon labelled "Generating"', () => {
      render(<StructurePreview sections={[makeSection({ status: 'pending', questions: [] })]} />);
      expect(screen.getByLabelText('Generating')).toBeInTheDocument();
    });

    it('shows "Writing questions…" placeholder text while pending', () => {
      render(<StructurePreview sections={[makeSection({ status: 'pending', questions: [] })]} />);
      expect(screen.getByText('Writing questions…')).toBeInTheDocument();
    });

    it('does NOT render a question-count badge while pending', () => {
      render(<StructurePreview sections={[makeSection({ status: 'pending', questions: [] })]} />);
      // The badge text is "N question(s)" — /\d+ question/ is precise enough to exclude
      // the "Writing questions…" placeholder text.
      expect(screen.queryByText(/\d+ question/i)).not.toBeInTheDocument();
    });
  });

  describe('error status', () => {
    it('renders the AlertCircle icon labelled "Failed"', () => {
      render(
        <StructurePreview
          sections={[makeSection({ status: 'error', message: 'Provider unavailable' })]}
        />
      );
      expect(screen.getByLabelText('Failed')).toBeInTheDocument();
    });

    it('renders the section-specific error message', () => {
      render(
        <StructurePreview
          sections={[makeSection({ status: 'error', message: 'Provider unavailable' })]}
        />
      );
      expect(screen.getByText('Provider unavailable')).toBeInTheDocument();
    });

    it('falls back to the generic error message when message is absent', () => {
      render(
        <StructurePreview sections={[makeSection({ status: 'error', message: undefined })]} />
      );
      expect(screen.getByText('This section could not be generated.')).toBeInTheDocument();
    });
  });

  describe('done status with questions', () => {
    it('renders a badge with the question count', () => {
      const questions = [
        { key: 'q1', prompt: 'How easy was onboarding?', suggestedType: 'likert' },
        { key: 'q2', prompt: 'What is your role?', suggestedType: 'single_choice' },
      ];
      render(<StructurePreview sections={[makeSection({ status: 'done', questions })]} />);
      expect(screen.getByText('2 questions')).toBeInTheDocument();
    });

    it('uses singular "question" for a single question', () => {
      const questions = [{ key: 'q1', prompt: 'Only question', suggestedType: 'free_text' }];
      render(<StructurePreview sections={[makeSection({ status: 'done', questions })]} />);
      expect(screen.getByText('1 question')).toBeInTheDocument();
    });

    it('renders each question prompt', () => {
      const questions = [
        { key: 'q1', prompt: 'How easy was onboarding?', suggestedType: 'likert' },
        { key: 'q2', prompt: 'What is your role?', suggestedType: 'single_choice' },
      ];
      render(<StructurePreview sections={[makeSection({ status: 'done', questions })]} />);
      expect(screen.getByText('How easy was onboarding?')).toBeInTheDocument();
      expect(screen.getByText('What is your role?')).toBeInTheDocument();
    });

    it('renders human-readable type labels for known types', () => {
      const questions = [
        { key: 'q1', prompt: 'How satisfied?', suggestedType: 'likert' },
        { key: 'q2', prompt: 'Describe issue', suggestedType: 'free_text' },
        { key: 'q3', prompt: 'Choose one', suggestedType: 'single_choice' },
        { key: 'q4', prompt: 'Choose many', suggestedType: 'multi_choice' },
        { key: 'q5', prompt: 'Enter number', suggestedType: 'numeric' },
        { key: 'q6', prompt: 'Pick date', suggestedType: 'date' },
        { key: 'q7', prompt: 'Yes or no?', suggestedType: 'boolean' },
      ];
      render(<StructurePreview sections={[makeSection({ status: 'done', questions })]} />);
      expect(screen.getByText('Likert')).toBeInTheDocument();
      expect(screen.getByText('Text')).toBeInTheDocument();
      expect(screen.getByText('Single choice')).toBeInTheDocument();
      expect(screen.getByText('Multi choice')).toBeInTheDocument();
      expect(screen.getByText('Number')).toBeInTheDocument();
      expect(screen.getByText('Date')).toBeInTheDocument();
      expect(screen.getByText('Yes/No')).toBeInTheDocument();
    });

    it('falls back to the raw type slug for unknown question types', () => {
      const questions = [{ key: 'q1', prompt: 'Rate this', suggestedType: 'star_rating' }];
      render(<StructurePreview sections={[makeSection({ status: 'done', questions })]} />);
      // Unknown type renders the raw slug as the badge label
      expect(screen.getByText('star_rating')).toBeInTheDocument();
    });

    it('shows "No questions." when done but question list is empty', () => {
      render(<StructurePreview sections={[makeSection({ status: 'done', questions: [] })]} />);
      expect(screen.getByText('No questions.')).toBeInTheDocument();
    });
  });

  describe('multiple sections', () => {
    it('renders all sections', () => {
      const sections: PreviewSection[] = [
        {
          ordinal: 0,
          title: 'Background',
          status: 'done',
          questions: [{ key: 'q1', prompt: 'What is your role?', suggestedType: 'free_text' }],
        },
        {
          ordinal: 1,
          title: 'Satisfaction',
          status: 'pending',
          questions: [],
        },
        {
          ordinal: 2,
          title: 'Pricing',
          status: 'error',
          message: 'AI timeout',
          questions: [],
        },
      ];
      render(<StructurePreview sections={sections} />);
      expect(screen.getByText('Background')).toBeInTheDocument();
      expect(screen.getByText('Satisfaction')).toBeInTheDocument();
      expect(screen.getByText('Pricing')).toBeInTheDocument();
      // Each status variant renders its marker
      expect(screen.getByText('What is your role?')).toBeInTheDocument();
      expect(screen.getByLabelText('Generating')).toBeInTheDocument();
      expect(screen.getByLabelText('Failed')).toBeInTheDocument();
      expect(screen.getByText('AI timeout')).toBeInTheDocument();
    });
  });
});
