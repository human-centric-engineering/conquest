/**
 * RespondentReportEditor — component tests.
 *
 * Verifies the controlled state → save payload (the whole respondentReport block), the master
 * enable toggle, and the mode gating (Generation fields are disabled in raw mode). UI primitives are
 * mocked to plain elements so assertions don't fight Radix/jsdom; the ClientKnowledgePanel is stubbed
 * (it fetches on mount and is covered separately).
 *
 * @see components/admin/questionnaires/report/respondent-report-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn().mockResolvedValue({}) },
  APIClientError: class extends Error {},
}));
// Tabs → render all panels (so we can assert across them without switching).
vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    id,
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    disabled?: boolean;
    id?: string;
  }) => (
    <input
      type="checkbox"
      role="switch"
      id={id}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
    disabled,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
    disabled?: boolean;
  }) => (
    <select
      data-testid="mode-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock('@/components/admin/questionnaires/report/client-knowledge-panel', () => ({
  ClientKnowledgePanel: () => <div data-testid="kb-panel" />,
}));

import { apiClient } from '@/lib/api/client';
import { RespondentReportEditor } from '@/components/admin/questionnaires/report/respondent-report-editor';
import { DEFAULT_RESPONDENT_REPORT_SETTINGS } from '@/lib/app/questionnaire/types';

type Mock = ReturnType<typeof vi.fn>;

function renderEditor(over: Partial<typeof DEFAULT_RESPONDENT_REPORT_SETTINGS> = {}) {
  return render(
    <RespondentReportEditor
      questionnaireId="qn-1"
      versionId="v1"
      initial={{ ...DEFAULT_RESPONDENT_REPORT_SETTINGS, ...over }}
      dataSlotsEnabled
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RespondentReportEditor', () => {
  it('saves the whole respondentReport block via the config PATCH', async () => {
    renderEditor({ enabled: true, mode: 'raw_plus_insights' });
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

    const patch = apiClient.patch as unknown as Mock;
    expect(patch).toHaveBeenCalledTimes(1);
    const [path, opts] = patch.mock.calls[0];
    expect(path).toBe('/api/v1/app/questionnaires/qn-1/versions/v1/config');
    expect(opts.body.respondentReport).toMatchObject({ enabled: true, mode: 'raw_plus_insights' });
  });

  it('reflects an edited mode in the save payload', async () => {
    renderEditor({ mode: 'raw' });
    fireEvent.change(screen.getByTestId('mode-select'), {
      target: { value: 'raw_plus_insights' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

    const opts = (apiClient.patch as unknown as Mock).mock.calls[0][1];
    expect(opts.body.respondentReport.mode).toBe('raw_plus_insights');
  });

  it('disables the generation fields in raw mode and enables them when switched to insights', () => {
    renderEditor({ mode: 'raw' });
    expect(screen.getByPlaceholderText(/Warm and encouraging/i)).toBeDisabled();

    // Switching the mode select to insights flips the gate (controlled state).
    fireEvent.change(screen.getByTestId('mode-select'), {
      target: { value: 'raw_plus_insights' },
    });
    expect(screen.getByPlaceholderText(/Warm and encouraging/i)).not.toBeDisabled();
  });

  it('offers the narrative mode option', () => {
    renderEditor({ mode: 'raw' });
    const select = screen.getByTestId('mode-select');
    const values = Array.from(select.querySelectorAll('option')).map((o) =>
      o.getAttribute('value')
    );
    expect(values).toContain('narrative');
  });

  it('enables the generation fields in narrative mode (an AI mode)', () => {
    renderEditor({ mode: 'narrative' });
    expect(screen.getByPlaceholderText(/Warm and encouraging/i)).not.toBeDisabled();
  });

  it('hides the raw-content toggles in narrative mode (woven, no separate raw section)', () => {
    const { container } = renderEditor({ mode: 'narrative' });
    expect(container.querySelector('#rr-questions')).toBeNull();
    expect(container.querySelector('#rr-dataslots')).toBeNull();
    expect(screen.getByText(/no separate raw answer section/i)).toBeInTheDocument();
  });

  it('keeps the raw-content toggles for raw + insights modes', () => {
    const { container } = renderEditor({ mode: 'raw_plus_insights' });
    expect(container.querySelector('#rr-questions')).not.toBeNull();
  });

  it('shows the embedded KB panel for narrative + useClientKnowledge', () => {
    renderEditor({
      mode: 'narrative',
      generation: {
        ...DEFAULT_RESPONDENT_REPORT_SETTINGS.generation,
        useClientKnowledge: true,
      },
    });
    expect(screen.getByTestId('kb-panel')).toBeInTheDocument();
  });

  it('shows the embedded KB panel only when insights + useClientKnowledge are on', () => {
    renderEditor({
      mode: 'raw_plus_insights',
      generation: {
        ...DEFAULT_RESPONDENT_REPORT_SETTINGS.generation,
        useClientKnowledge: true,
      },
    });
    expect(screen.getByTestId('kb-panel')).toBeInTheDocument();
  });

  it('hides the KB panel when useClientKnowledge is off', () => {
    renderEditor({ mode: 'raw_plus_insights' });
    expect(screen.queryByTestId('kb-panel')).not.toBeInTheDocument();
  });

  it('edits content, generation, and delivery toggles into the save payload', () => {
    const { container } = renderEditor({ mode: 'raw_plus_insights' });
    const sw = (id: string) => container.querySelector(`#${id}`) as HTMLInputElement;

    fireEvent.click(sw('rr-enabled')); // false → true
    fireEvent.click(sw('rr-questions')); // true → false
    fireEvent.click(sw('rr-dataslots')); // false → true
    fireEvent.click(sw('rr-onscreen')); // true → false
    fireEvent.click(sw('rr-download')); // true → false
    fireEvent.click(sw('rr-kb')); // false → true
    fireEvent.change(screen.getByPlaceholderText(/Warm and encouraging/i), {
      target: { value: 'Be warm.' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));
    const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
    expect(rr.enabled).toBe(true);
    expect(rr.rawIncludes).toEqual({ dataSlots: true, questionsAsPresented: false });
    expect(rr.delivery).toEqual({ onScreen: false, download: false });
    expect(rr.generation.instructions).toBe('Be warm.');
    expect(rr.generation.useClientKnowledge).toBe(true);
  });

  it('shows an error message when saving fails', async () => {
    (apiClient.patch as unknown as Mock).mockRejectedValueOnce(new Error('nope'));
    renderEditor({ enabled: true });
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));
    expect(await screen.findByText(/Could not save the report config/i)).toBeInTheDocument();
  });

  it('confirms a successful save', async () => {
    renderEditor({ enabled: true });
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));
    expect(await screen.findByText(/^Saved\.$/)).toBeInTheDocument();
  });
});
