/**
 * ResumeByRefEntry — the collapsed public-footer "continue with your code" affordance (session resume).
 *
 * @see components/app/questionnaire/chat/resume-by-ref-entry.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ResumeByRefEntry } from '@/components/app/questionnaire/chat/resume-by-ref-entry';

describe('ResumeByRefEntry', () => {
  it('starts collapsed as a subtle link', () => {
    render(<ResumeByRefEntry versionId="v-1" />);
    expect(screen.getByRole('button', { name: /started on another device/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/session reference code/i)).not.toBeInTheDocument();
  });

  it('reveals the ref form when clicked', async () => {
    const user = userEvent.setup();
    render(<ResumeByRefEntry versionId="v-1" />);
    await user.click(screen.getByRole('button', { name: /started on another device/i }));
    expect(screen.getByLabelText(/session reference code/i)).toBeInTheDocument();
  });
});
