/**
 * RespondentReportEditor — component tests.
 *
 * Verifies the controlled state → save payload (the whole respondentReport block), the master
 * enable toggle, the mode gating (Generation fields are disabled in raw mode), and the narrative-style
 * selector. UI primitives (Tabs/Switch/Select/FieldHelp) are mocked to plain elements so assertions
 * don't fight Radix/jsdom. The embedded `ReportConfigAssistant` is rendered live — it only calls the
 * craft API on user interaction, so it stays inert in these save/gating tests.
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
// The editor has two Selects (report mode + narrative style). Distinguish them by their value-space
// so `getByTestId('mode-select')` stays unambiguous and the style select is separately addressable.
// (Array inlined — a vi.mock factory is hoisted and can't close over an outer const.)
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
      data-testid={
        ['raw', 'raw_plus_insights', 'narrative'].includes(value) ? 'mode-select' : 'style-select'
      }
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
import { apiClient } from '@/lib/api/client';
import { RespondentReportEditor } from '@/components/admin/questionnaires/report/respondent-report-editor';
import { DEFAULT_RESPONDENT_REPORT_SETTINGS } from '@/lib/app/questionnaire/types';

type Mock = ReturnType<typeof vi.fn>;

function renderEditor(
  over: Partial<typeof DEFAULT_RESPONDENT_REPORT_SETTINGS> = {},
  client: { id: string; name: string } | null = { id: 'clt-1', name: 'Acme' }
) {
  return render(
    <RespondentReportEditor
      questionnaireId="qn-1"
      versionId="v1"
      initial={{ ...DEFAULT_RESPONDENT_REPORT_SETTINGS, ...over }}
      dataSlotsEnabled
      client={client}
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

  it('links to the client KB page when grounding is on (insights or narrative)', () => {
    renderEditor({
      mode: 'raw_plus_insights',
      generation: {
        ...DEFAULT_RESPONDENT_REPORT_SETTINGS.generation,
        useClientKnowledge: true,
      },
    });
    const link = screen.getByRole('link', { name: /Manage Acme.s knowledge base/i });
    expect(link).toHaveAttribute('href', '/admin/demo-clients/clt-1');
  });

  it('also links to the client KB page in narrative mode', () => {
    renderEditor({
      mode: 'narrative',
      generation: {
        ...DEFAULT_RESPONDENT_REPORT_SETTINGS.generation,
        useClientKnowledge: true,
      },
    });
    expect(screen.getByRole('link', { name: /Manage Acme.s knowledge base/i })).toBeInTheDocument();
  });

  it('does not embed a document uploader (management lives on the client page)', () => {
    renderEditor({
      mode: 'raw_plus_insights',
      generation: {
        ...DEFAULT_RESPONDENT_REPORT_SETTINGS.generation,
        useClientKnowledge: true,
      },
    });
    expect(screen.queryByRole('button', { name: /Upload document/i })).not.toBeInTheDocument();
  });

  it('shows the no-client notice when grounding is on but no client is attributed', () => {
    renderEditor(
      {
        mode: 'raw_plus_insights',
        generation: {
          ...DEFAULT_RESPONDENT_REPORT_SETTINGS.generation,
          useClientKnowledge: true,
        },
      },
      null
    );
    expect(screen.getByText(/No demo client is attributed/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /knowledge base/i })).not.toBeInTheDocument();
  });

  it('hides the KB link when useClientKnowledge is off', () => {
    renderEditor({ mode: 'raw_plus_insights' });
    expect(screen.queryByRole('link', { name: /knowledge base/i })).not.toBeInTheDocument();
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

  it('offers the narrative-style presets and defaults to flowing', () => {
    renderEditor({ mode: 'narrative' });
    const style = screen.getByTestId<HTMLSelectElement>('style-select');
    const values = Array.from(style.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values).toEqual(['flowing', 'concise', 'structured']);
    expect(style.value).toBe('flowing');
  });

  it('reflects the chosen narrative style in the save payload', () => {
    renderEditor({ mode: 'narrative' });
    fireEvent.change(screen.getByTestId('style-select'), { target: { value: 'structured' } });
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));
    const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
    expect(rr.generation.narrativeStyle).toBe('structured');
  });

  it('disables the narrative-style select in raw mode (no AI report)', () => {
    renderEditor({ mode: 'raw' });
    expect(screen.getByTestId('style-select')).toBeDisabled();
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
