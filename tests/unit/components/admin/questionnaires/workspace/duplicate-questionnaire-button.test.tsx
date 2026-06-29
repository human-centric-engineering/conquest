/**
 * DuplicateQuestionnaireButton — workspace-header button wrapping useDuplicateQuestionnaire.
 *
 * The hook is mocked to drive different states deterministically — the hook's own
 * behaviour is covered by use-duplicate-questionnaire.test.ts.
 *
 * Test Coverage:
 * - Renders the "Duplicate" button with the correct accessible title
 * - Clicking calls the hook's duplicate function with the questionnaireId prop
 * - Shows spinner and disables the button while isDuplicating is true
 * - Shows the error message when the hook returns a non-null error
 * - Hides the error element when error is null
 *
 * @see components/admin/questionnaires/workspace/duplicate-questionnaire-button.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the hook so we can control every state without running the real API path.
vi.mock('@/components/admin/questionnaires/use-duplicate-questionnaire', () => ({
  useDuplicateQuestionnaire: vi.fn(),
}));

import type { UseDuplicateQuestionnaire } from '@/components/admin/questionnaires/use-duplicate-questionnaire';
import { useDuplicateQuestionnaire } from '@/components/admin/questionnaires/use-duplicate-questionnaire';
import { DuplicateQuestionnaireButton } from '@/components/admin/questionnaires/workspace/duplicate-questionnaire-button';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wire up the hook mock with the given state for one test. */
function mockHook(overrides: { isDuplicating?: boolean; error?: string | null }) {
  const mockDuplicate = vi.fn<UseDuplicateQuestionnaire['duplicate']>();
  vi.mocked(useDuplicateQuestionnaire).mockReturnValue({
    duplicate: mockDuplicate,
    isDuplicating: overrides.isDuplicating ?? false,
    error: overrides.error ?? null,
    clearError: vi.fn(),
  });
  return { mockDuplicate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DuplicateQuestionnaireButton', () => {
  it('renders the Duplicate button with a descriptive title attribute', () => {
    // Arrange
    mockHook({});

    // Act
    render(<DuplicateQuestionnaireButton questionnaireId="q-1" />);

    // Assert: the button exists and describes its action for sighted users
    const button = screen.getByRole('button', { name: /duplicate/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('title', expect.stringContaining('copy'));
  });

  it('calls duplicate() with the questionnaireId prop when clicked', async () => {
    // Arrange
    const user = userEvent.setup();
    const { mockDuplicate } = mockHook({});
    render(<DuplicateQuestionnaireButton questionnaireId="q-xyz" />);

    // Act
    await user.click(screen.getByRole('button', { name: /duplicate/i }));

    // Assert: the prop id is forwarded to the hook — proves the button is not
    // hardcoding an id or calling with an unexpected value.
    expect(mockDuplicate).toHaveBeenCalledWith('q-xyz');
    expect(mockDuplicate).toHaveBeenCalledTimes(1);
  });

  it('disables the button while isDuplicating is true', () => {
    // Arrange: hook reports an in-progress duplication
    mockHook({ isDuplicating: true });

    // Act
    render(<DuplicateQuestionnaireButton questionnaireId="q-1" />);

    // Assert: the button is disabled so users cannot trigger a second duplicate
    expect(screen.getByRole('button', { name: /duplicate/i })).toBeDisabled();
  });

  it('enables the button when isDuplicating is false', () => {
    // Arrange
    mockHook({ isDuplicating: false });

    // Act
    render(<DuplicateQuestionnaireButton questionnaireId="q-1" />);

    // Assert
    expect(screen.getByRole('button', { name: /duplicate/i })).not.toBeDisabled();
  });

  it('renders the error message when the hook returns a non-null error', () => {
    // Arrange
    mockHook({ error: 'Could not duplicate the questionnaire.' });

    // Act
    render(<DuplicateQuestionnaireButton questionnaireId="q-1" />);

    // Assert: the call-site renders the hook's error string (hook decides wording)
    expect(screen.getByText('Could not duplicate the questionnaire.')).toBeInTheDocument();
  });

  it('does not render an error element when error is null', () => {
    // Arrange
    mockHook({ error: null });

    // Act
    render(<DuplicateQuestionnaireButton questionnaireId="q-1" />);

    // Assert: no error text is present
    expect(screen.queryByText(/could not duplicate/i)).not.toBeInTheDocument();
  });
});
