/**
 * RespondentReportEditor — component tests.
 *
 * Verifies the controlled state → save payload (the whole respondentReport block), the master
 * enable toggle, the mode gating (Generation fields are hidden in raw mode), and the narrative-style
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
  apiClient: {
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({
      questionnaireTitle: 'Pulse',
      mode: 'narrative',
      content: { summary: 'Sample.', sections: [], actions: [] },
      formatted: false,
      completionPct: 100,
    }),
  },
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
// The editor has several Selects (report mode, narrative style, research timing, research
// display). Distinguish them by their value-space so `getByTestId('mode-select')` etc. stay
// unambiguous. (Arrays inlined — a vi.mock factory is hoisted and can't close over an outer const.)
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
  }) => {
    const testId = ['raw', 'raw_plus_insights', 'narrative'].includes(value)
      ? 'mode-select'
      : ['flowing', 'concise', 'structured'].includes(value)
        ? 'style-select'
        : ['before', 'after', 'both'].includes(value)
          ? 'timing-select'
          : ['table', 'list', 'hidden'].includes(value)
            ? 'display-select'
            : 'unknown-select';
    return (
      <select
        data-testid={testId}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {children}
      </select>
    );
  },
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));
import { apiClient } from '@/lib/api/client';
import { RespondentReportEditor } from '@/components/admin/questionnaires/report/respondent-report-editor';
import {
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
  MAX_REPORT_RESEARCH_ROUNDS,
  MAX_REPORT_RESEARCH_RESULTS,
} from '@/lib/app/questionnaire/types';

type Mock = ReturnType<typeof vi.fn>;

function renderEditor(
  over: Partial<typeof DEFAULT_RESPONDENT_REPORT_SETTINGS> = {},
  client: { id: string; name: string } | null = { id: 'clt-1', name: 'Acme' },
  webSearchEnabled = false
) {
  return render(
    <RespondentReportEditor
      questionnaireId="qn-1"
      versionId="v1"
      initial={{ ...DEFAULT_RESPONDENT_REPORT_SETTINGS, ...over }}
      dataSlotsEnabled
      client={client}
      webSearchEnabled={webSearchEnabled}
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

  it('hides the generation fields in raw mode and shows them when switched to insights', () => {
    renderEditor({ mode: 'raw' });
    // Raw mode has no AI report: the Generation panel replaces its inputs with a hint.
    expect(screen.queryByPlaceholderText(/Warm and encouraging/i)).toBeNull();

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

  it('reflects the confidence toggle in the save payload', () => {
    const { container } = renderEditor({ mode: 'narrative' });
    const confidence = container.querySelector('#rr-confidence') as HTMLInputElement;
    expect(confidence).not.toBeNull();
    expect(confidence.checked).toBe(true); // default on
    fireEvent.click(confidence);
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

    const opts = (apiClient.patch as unknown as Mock).mock.calls[0][1];
    expect(opts.body.respondentReport.generation.discountLowConfidence).toBe(false);
    // The default influence rides along untouched.
    expect(opts.body.respondentReport.generation.dataSlotInfluence).toBe(50);
  });

  it('generates a preview from the current config via the preview endpoint', () => {
    renderEditor({
      mode: 'narrative',
      generation: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.generation, dataSlotInfluence: 70 },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview report/i }));

    const post = apiClient.post as unknown as Mock;
    expect(post).toHaveBeenCalledTimes(1);
    const [path, opts] = post.mock.calls[0];
    expect(path).toBe('/api/v1/app/questionnaires/qn-1/versions/v1/report/preview');
    expect(opts.body.config.mode).toBe('narrative');
    expect(opts.body.config.generation.dataSlotInfluence).toBe(70);
  });

  it('hides the Q&A toggle in narrative mode (woven-only) but keeps the captured-data toggle', () => {
    const { container } = renderEditor({ mode: 'narrative' });
    // A narrative report never appends the Q&A recap (restores the pre-F10.6 woven-only invariant),
    // so the questions toggle is not offered; the captured data-slot appendix stays opt-in.
    expect(container.querySelector('#rr-questions')).toBeNull();
    expect(container.querySelector('#rr-dataslots')).not.toBeNull();
    expect(screen.getByText(/is not appended/i)).toBeInTheDocument();
  });

  it('keeps the raw-content toggles for raw + insights modes', () => {
    const { container } = renderEditor({ mode: 'raw_plus_insights' });
    expect(container.querySelector('#rr-questions')).not.toBeNull();
  });

  it('hides the Q&A toggle and clears the data-slot toggle when switching to narrative', () => {
    const { container } = renderEditor({ mode: 'raw_plus_insights' });
    // The non-narrative default surfaces the answers.
    expect(container.querySelector<HTMLInputElement>('#rr-questions')?.checked).toBe(true);
    fireEvent.change(screen.getByTestId('mode-select'), { target: { value: 'narrative' } });
    // Narrative is woven-only: the Q&A toggle disappears entirely and the data-slot appendix resets off.
    expect(container.querySelector('#rr-questions')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('#rr-dataslots')?.checked).toBe(false);
  });

  it('restores the answer listing when switching away from narrative', () => {
    const { container } = renderEditor({
      mode: 'narrative',
      rawIncludes: { questionsAsPresented: false, dataSlots: false },
    });
    // No Q&A toggle while in narrative mode.
    expect(container.querySelector('#rr-questions')).toBeNull();
    fireEvent.change(screen.getByTestId('mode-select'), { target: { value: 'raw_plus_insights' } });
    // Switching back surfaces the toggle again, defaulted on.
    expect(container.querySelector<HTMLInputElement>('#rr-questions')?.checked).toBe(true);
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
    fireEvent.click(sw('rr-explain-method')); // false → true
    fireEvent.click(sw('rr-kb')); // false → true
    fireEvent.change(screen.getByPlaceholderText(/Warm and encouraging/i), {
      target: { value: 'Be warm.' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));
    const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
    expect(rr.enabled).toBe(true);
    expect(rr.rawIncludes).toEqual({ dataSlots: true, questionsAsPresented: false });
    expect(rr.delivery).toEqual({ onScreen: false, download: false, explainMethod: true });
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

  it('hides the narrative-style select in raw mode (no AI report)', () => {
    renderEditor({ mode: 'raw' });
    // The whole Generation panel is replaced by a hint in raw mode, so the style select is absent.
    expect(screen.queryByTestId('style-select')).toBeNull();
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

  describe('Research tab (web search)', () => {
    it('does not render the Research tab trigger when web search is disabled', () => {
      renderEditor({}, undefined, false);
      expect(screen.queryByRole('button', { name: 'Research' })).not.toBeInTheDocument();
      expect(screen.queryByText(/Enable web-search rounds/i)).not.toBeInTheDocument();
    });

    it('renders the Research tab trigger and panel when web search is enabled', () => {
      renderEditor({}, undefined, true);
      expect(screen.getByRole('button', { name: 'Research' })).toBeInTheDocument();
      expect(screen.getByText(/Enable web-search rounds/i)).toBeInTheDocument();
    });

    it('disables the research-enabled switch when the mode does not use an agent', () => {
      const { container } = renderEditor(
        {
          mode: 'raw',
          research: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research, enabled: true },
        },
        undefined,
        true
      );
      const sw = (id: string) => container.querySelector(`#${id}`) as HTMLInputElement;
      expect(sw('rr-research-enabled')).toBeDisabled();
      // usesAgent=false overrides research.enabled=true — the rest stay disabled too.
      expect(screen.getByTestId('timing-select')).toBeDisabled();
      expect(container.querySelector('#rr-research-rounds')).toBeDisabled();
      expect(container.querySelector('#rr-research-results')).toBeDisabled();
      expect(screen.getByTestId('display-select')).toBeDisabled();
      expect(sw('rr-research-inform')).toBeDisabled();
      expect(sw('rr-research-appendix')).toBeDisabled();
    });

    it('enables the research-enabled switch in an AI mode but keeps dependent controls disabled until research is turned on', () => {
      const { container } = renderEditor({ mode: 'raw_plus_insights' }, undefined, true);
      const sw = (id: string) => container.querySelector(`#${id}`) as HTMLInputElement;
      // research.enabled defaults to false — the switch itself is enabled (usesAgent is true)...
      expect(sw('rr-research-enabled')).not.toBeDisabled();
      // ...but everything gated on research.enabled stays disabled.
      expect(screen.getByTestId('timing-select')).toBeDisabled();
      expect(container.querySelector('#rr-research-rounds')).toBeDisabled();
      expect(container.querySelector('#rr-research-results')).toBeDisabled();
      expect(screen.getByTestId('display-select')).toBeDisabled();
      expect(sw('rr-research-inform')).toBeDisabled();
      expect(sw('rr-research-appendix')).toBeDisabled();
    });

    it('enables the timing/rounds/results/display controls once research is on in an AI mode', () => {
      const { container } = renderEditor(
        {
          mode: 'raw_plus_insights',
          research: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research, enabled: true },
        },
        undefined,
        true
      );
      expect(screen.getByTestId('timing-select')).not.toBeDisabled();
      expect(container.querySelector('#rr-research-rounds')).not.toBeDisabled();
      expect(container.querySelector('#rr-research-results')).not.toBeDisabled();
      expect(screen.getByTestId('display-select')).not.toBeDisabled();
      // Default timing is 'before', so showsBefore is true and the inform switch is enabled too.
      expect(container.querySelector('#rr-research-inform')).not.toBeDisabled();
      // The appendix switch is enabled whenever research is on (it works at any timing).
      expect(container.querySelector('#rr-research-appendix')).not.toBeDisabled();
    });

    it('disables the inform-narrative switch when timing does not include a before phase', () => {
      const { container } = renderEditor(
        {
          mode: 'raw_plus_insights',
          research: {
            ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research,
            enabled: true,
            timing: 'after',
          },
        },
        undefined,
        true
      );
      expect(container.querySelector('#rr-research-inform')).toBeDisabled();
      // ...but the appendix switch stays enabled — it can draw on after-search findings.
      expect(container.querySelector('#rr-research-appendix')).not.toBeDisabled();
    });

    it('shows only the before-search instructions when timing is "before"', () => {
      renderEditor(
        {
          mode: 'raw_plus_insights',
          research: {
            ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research,
            enabled: true,
            timing: 'before',
          },
        },
        undefined,
        true
      );
      expect(
        screen.getByPlaceholderText(/Research current best-practice guidance/i)
      ).toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText(/Find supporting sources and helpful links/i)
      ).not.toBeInTheDocument();
    });

    it('shows only the after-search instructions when timing is "after"', () => {
      renderEditor(
        {
          mode: 'raw_plus_insights',
          research: {
            ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research,
            enabled: true,
            timing: 'after',
          },
        },
        undefined,
        true
      );
      expect(
        screen.queryByPlaceholderText(/Research current best-practice guidance/i)
      ).not.toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/Find supporting sources and helpful links/i)
      ).toBeInTheDocument();
    });

    it('shows both instructions sections when timing is "both"', () => {
      renderEditor(
        {
          mode: 'raw_plus_insights',
          research: {
            ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research,
            enabled: true,
            timing: 'both',
          },
        },
        undefined,
        true
      );
      expect(
        screen.getByPlaceholderText(/Research current best-practice guidance/i)
      ).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/Find supporting sources and helpful links/i)
      ).toBeInTheDocument();
    });

    it('switches the visible instructions section when timing is changed interactively', () => {
      renderEditor(
        {
          mode: 'raw_plus_insights',
          research: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research, enabled: true },
        },
        undefined,
        true
      );
      // Starts on the default 'before' timing.
      expect(
        screen.getByPlaceholderText(/Research current best-practice guidance/i)
      ).toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText(/Find supporting sources and helpful links/i)
      ).not.toBeInTheDocument();

      fireEvent.change(screen.getByTestId('timing-select'), { target: { value: 'both' } });

      expect(
        screen.getByPlaceholderText(/Research current best-practice guidance/i)
      ).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/Find supporting sources and helpful links/i)
      ).toBeInTheDocument();
    });

    it('propagates an edited timing into the save payload', () => {
      renderEditor(
        {
          mode: 'raw_plus_insights',
          research: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research, enabled: true },
        },
        undefined,
        true
      );
      fireEvent.change(screen.getByTestId('timing-select'), { target: { value: 'after' } });
      fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
      expect(rr.research.timing).toBe('after');
    });

    it('propagates the appendix opt-in into the save payload', () => {
      const { container } = renderEditor(
        {
          mode: 'raw_plus_insights',
          research: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research, enabled: true },
        },
        undefined,
        true
      );
      // Default is off; toggling it on must reach the payload.
      fireEvent.click(container.querySelector('#rr-research-appendix') as HTMLElement);
      fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
      expect(rr.research.appendix).toBe(true);
    });

    it('propagates edited rounds and maxResults into the save payload', () => {
      const { container } = renderEditor(
        {
          mode: 'raw_plus_insights',
          research: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research, enabled: true },
        },
        undefined,
        true
      );
      fireEvent.change(container.querySelector('#rr-research-rounds') as HTMLInputElement, {
        target: { value: '3' },
      });
      fireEvent.change(container.querySelector('#rr-research-results') as HTMLInputElement, {
        target: { value: '8' },
      });
      fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
      expect(rr.research.rounds).toBe(3);
      expect(rr.research.maxResults).toBe(8);
    });

    it('clamps an out-of-range rounds input to the maximum before saving', () => {
      const { container } = renderEditor(
        {
          mode: 'raw_plus_insights',
          research: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research, enabled: true },
        },
        undefined,
        true
      );
      fireEvent.change(container.querySelector('#rr-research-rounds') as HTMLInputElement, {
        target: { value: '999' },
      });
      fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
      expect(rr.research.rounds).toBe(MAX_REPORT_RESEARCH_ROUNDS);
    });

    it('clamps an out-of-range maxResults input to the maximum before saving', () => {
      const { container } = renderEditor(
        {
          mode: 'raw_plus_insights',
          research: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research, enabled: true },
        },
        undefined,
        true
      );
      fireEvent.change(container.querySelector('#rr-research-results') as HTMLInputElement, {
        target: { value: '999' },
      });
      fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
      expect(rr.research.maxResults).toBe(MAX_REPORT_RESEARCH_RESULTS);
    });

    it('clamps a below-range rounds input to the minimum (1) before saving', () => {
      const { container } = renderEditor(
        {
          mode: 'raw_plus_insights',
          research: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research, enabled: true },
        },
        undefined,
        true
      );
      fireEvent.change(container.querySelector('#rr-research-rounds') as HTMLInputElement, {
        target: { value: '0' },
      });
      fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
      expect(rr.research.rounds).toBe(1);
    });

    it('propagates edited before and after instructions independently into the save payload', () => {
      renderEditor(
        {
          mode: 'raw_plus_insights',
          research: {
            ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research,
            enabled: true,
            timing: 'both',
          },
        },
        undefined,
        true
      );
      fireEvent.change(screen.getByPlaceholderText(/Research current best-practice guidance/i), {
        target: { value: 'Check industry benchmarks.' },
      });
      fireEvent.change(screen.getByPlaceholderText(/Find supporting sources and helpful links/i), {
        target: { value: 'Verify sources.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
      expect(rr.research.before.instructions).toBe('Check industry benchmarks.');
      expect(rr.research.after.instructions).toBe('Verify sources.');
    });

    it('propagates the display selection into the save payload', () => {
      renderEditor(
        {
          mode: 'raw_plus_insights',
          research: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS.research, enabled: true },
        },
        undefined,
        true
      );
      fireEvent.change(screen.getByTestId('display-select'), { target: { value: 'hidden' } });
      fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
      expect(rr.research.display).toBe('hidden');
    });

    it('propagates the research-enabled and inform-narrative toggles into the save payload', () => {
      const { container } = renderEditor({ mode: 'raw_plus_insights' }, undefined, true);
      const sw = (id: string) => container.querySelector(`#${id}`) as HTMLInputElement;

      fireEvent.click(sw('rr-research-enabled')); // false → true; unlocks the inform switch too
      fireEvent.click(sw('rr-research-inform')); // true → false (default informNarrative is true)
      fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const rr = (apiClient.patch as unknown as Mock).mock.calls[0][1].body.respondentReport;
      expect(rr.research.enabled).toBe(true);
      expect(rr.research.informNarrative).toBe(false);
    });
  });
});
