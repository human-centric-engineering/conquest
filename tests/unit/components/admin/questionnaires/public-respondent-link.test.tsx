import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PublicRespondentLink } from '@/components/admin/questionnaires/public-respondent-link';

describe('PublicRespondentLink', () => {
  it('renders the tokenless /q/<versionId> link using the current origin', () => {
    render(<PublicRespondentLink versionId="ver_9" isLaunched />);
    // Ends with /q/ver_9 — confirms the path and that no token query string is appended.
    expect(screen.getByDisplayValue(/\/q\/ver_9$/)).toBeInTheDocument();
  });

  it('reassures when launched', () => {
    render(<PublicRespondentLink versionId="ver_9" isLaunched />);
    expect(screen.getByText(/anyone with this link can answer/i)).toBeInTheDocument();
  });

  it('warns the link is inert until launch when not launched', () => {
    render(<PublicRespondentLink versionId="ver_9" isLaunched={false} />);
    expect(screen.getByText(/activates once this version is launched/i)).toBeInTheDocument();
  });
});
