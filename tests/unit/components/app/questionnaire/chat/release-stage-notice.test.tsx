/**
 * ReleaseStageNotice Tests
 *
 * The notice tells respondents their conversation is recorded while the product
 * is pre-release. It is driven entirely by the release-stage seam (no props), so
 * these tests mock `@/lib/app/release-stage` to exercise each stage:
 * - alpha/beta  → renders a role="status" notice naming the stage
 * - stable      → renders nothing (drops out cleanly)
 *
 * @see components/app/questionnaire/chat/release-stage-notice.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Hoisted mutable mock state for the release-stage seam.
const stageMock: { stage: 'alpha' | 'beta' | 'stable' } = vi.hoisted(() => ({ stage: 'stable' }));

vi.mock('@/lib/app/release-stage', () => ({
  get RELEASE_STAGE() {
    return stageMock.stage;
  },
  get IS_PRERELEASE() {
    return stageMock.stage === 'alpha' || stageMock.stage === 'beta';
  },
}));

import { ReleaseStageNotice } from '@/components/app/questionnaire/chat/release-stage-notice';

beforeEach(() => {
  stageMock.stage = 'stable';
});

afterEach(() => {
  cleanup();
});

describe('ReleaseStageNotice', () => {
  it('renders nothing on a stable build', () => {
    stageMock.stage = 'stable';
    const { container } = render(<ReleaseStageNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a polite status notice naming the alpha stage', () => {
    stageMock.stage = 'alpha';
    render(<ReleaseStageNotice />);

    const notice = screen.getByRole('status');
    expect(notice).toBeInTheDocument();
    // The exact consent copy the product owner specified, with the live stage interpolated.
    expect(notice).toHaveTextContent(
      'While ConQuest is in alpha your chats are being recorded for analysis and tuning purposes for our team.'
    );
  });

  it('names the beta stage when in beta', () => {
    stageMock.stage = 'beta';
    render(<ReleaseStageNotice />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'While ConQuest is in beta your chats are being recorded'
    );
  });

  it('does NOT use an assertive alert role (it should not interrupt the conversation)', () => {
    stageMock.stage = 'alpha';
    render(<ReleaseStageNotice />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forwards a custom className to the notice container', () => {
    stageMock.stage = 'alpha';
    render(<ReleaseStageNotice className="mx-4 mt-4" />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveClass('mx-4');
    expect(notice).toHaveClass('mt-4');
  });

  it('marks the icon aria-hidden so screen readers skip it', () => {
    stageMock.stage = 'alpha';
    render(<ReleaseStageNotice />);
    expect(document.querySelectorAll('svg[aria-hidden="true"]').length).toBeGreaterThan(0);
  });
});
