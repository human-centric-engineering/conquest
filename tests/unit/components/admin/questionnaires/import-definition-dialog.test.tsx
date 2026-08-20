/**
 * ImportDefinitionDialog — unit tests for the "Import definition" flow (F14.9).
 *
 * Pins what the component DOES:
 *  - Picking a valid file parses it client-side and previews section/question/data-slot/topic
 *    counts (Adaptive Scope topics only shown when the file carries any — the bug this dialog's
 *    preview was extended to surface, see lib/app/questionnaire/authoring/definition-export.ts)
 *  - Picking an invalid file surfaces a parse error and leaves no preview
 *  - Confirming POSTs the raw file text to the import endpoint (optionally with a demoClientId
 *    query param) and routes to the new draft's Structure editor on success
 *  - A rejected import (non-success response) surfaces the server's error and stays on the dialog
 *  - The demo-client picker only renders when options are supplied
 *
 * Dialog/Select/FieldHelp are stubbed to transparent passthroughs so assertions focus on this
 * component's own behaviour rather than Radix portal mechanics — same convention as
 * config-import-export.test.tsx.
 *
 * @see components/admin/questionnaires/import-definition-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { createMockRouter, type MockRouter } from '@/tests/types/mocks';
import {
  DEFINITION_EXPORT_KIND,
  DEFINITION_EXPORT_SCHEMA_VERSION,
} from '@/lib/app/questionnaire/authoring';
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';

// ─── next/navigation → mock router ────────────────────────────────────────────
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

// ─── Dialog → inline passthrough (skip Radix portal) ─────────────────────────
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

// ─── Select → native <select> passthrough ─────────────────────────────────────
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="Demo client"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

// ─── FieldHelp → transparent passthrough ─────────────────────────────────────
vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import { ImportDefinitionDialog } from '@/components/admin/questionnaires/import-definition-dialog';

const DEMO_CLIENTS: AttributedDemoClient[] = [{ id: 'client-1', slug: 'acme', name: 'Acme Co' }];

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    kind: DEFINITION_EXPORT_KIND,
    schemaVersion: DEFINITION_EXPORT_SCHEMA_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    questionnaire: { title: 'Staff Morale' },
    version: {
      sections: [
        {
          ordinal: 0,
          title: 'S',
          questions: [
            { ordinal: 0, key: 'q', prompt: 'Q?', type: 'free_text', required: true, weight: 1 },
          ],
        },
      ],
      ...overrides,
    },
  };
}

function file(body: unknown, name = 'definition.json'): File {
  return new File([JSON.stringify(body)], name, { type: 'application/json' });
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input as HTMLInputElement;
}

let push: MockRouter['push'];

beforeEach(async () => {
  vi.restoreAllMocks();
  push = vi.fn();
  const { useRouter } = await import('next/navigation');
  vi.mocked(useRouter).mockReturnValue(createMockRouter({ push }));
  vi.stubGlobal('fetch', vi.fn());
});

describe('ImportDefinitionDialog — file preview', () => {
  it('previews section/question counts for a valid file with no data slots or topics', async () => {
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: [file(envelope())] } });

    expect(await screen.findByText('Staff Morale')).toBeInTheDocument();
    expect(screen.getByText(/1 section · 1 question/)).toBeInTheDocument();
    expect(screen.queryByText(/\d+ data slot/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ adaptive scope topic/)).not.toBeInTheDocument();
  });

  it('includes the Adaptive Scope topic count in the preview when the file carries topics', async () => {
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(fileInput(), {
      target: {
        files: [
          file(
            envelope({
              dataSlots: [
                {
                  key: 'd',
                  name: 'D',
                  description: '',
                  theme: 't',
                  ordinal: 0,
                  weight: 1,
                  questionKeys: [],
                },
              ],
              topics: [
                {
                  key: 't1',
                  label: 'Topic',
                  description: null,
                  phase: 'conditional',
                  criteria: null,
                  depth: 'full',
                  ordinal: 0,
                  source: 'manual',
                  questionKeys: [],
                  dataSlotKeys: [],
                },
              ],
            })
          ),
        ],
      },
    });

    expect(await screen.findByText(/1 data slot/)).toBeInTheDocument();
    expect(screen.getByText(/1 adaptive scope topic/)).toBeInTheDocument();
  });

  it('pluralises the topic count for more than one topic', async () => {
    const twoTopics = Array.from({ length: 2 }, (_, i) => ({
      key: `t${i}`,
      label: `Topic ${i}`,
      description: null,
      phase: 'conditional' as const,
      criteria: null,
      depth: 'full' as const,
      ordinal: i,
      source: 'manual' as const,
      questionKeys: [],
      dataSlotKeys: [],
    }));
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: [file(envelope({ topics: twoTopics }))] } });

    expect(await screen.findByText(/2 adaptive scope topics/)).toBeInTheDocument();
  });

  it('surfaces a parse error and does not show a preview for an invalid file', async () => {
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: [file({ kind: 'nope' })] } });

    expect(await screen.findByText(/isn't a questionnaire definition/i)).toBeInTheDocument();
    expect(screen.queryByText('Staff Morale')).not.toBeInTheDocument();
  });
});

describe('ImportDefinitionDialog — import', () => {
  it('POSTs the raw file text and routes to the new draft on success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            questionnaireId: 'qn-1',
            versionId: 'ver-1',
            sectionCount: 1,
            questionCount: 1,
            dataSlotCount: 0,
            topicCount: 0,
          },
        }),
        { status: 201 }
      )
    );
    const onOpenChange = vi.fn();
    render(<ImportDefinitionDialog open onOpenChange={onOpenChange} />);
    fireEvent.change(fileInput(), { target: { files: [file(envelope())] } });
    await screen.findByText('Staff Morale');

    fireEvent.click(screen.getByRole('button', { name: /import as new questionnaire/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/app/questionnaires/import');
    expect(url).not.toContain('demoClientId');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string).questionnaire.title).toBe('Staff Morale');

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(push).toHaveBeenCalledWith('/admin/questionnaires/qn-1/v/ver-1/structure?edit=1');
  });

  it('surfaces the server error and keeps the dialog open when the import is rejected', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Malformed file' },
        }),
        { status: 400 }
      )
    );
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: [file(envelope())] } });
    await screen.findByText('Staff Morale');

    fireEvent.click(screen.getByRole('button', { name: /import as new questionnaire/i }));

    expect(await screen.findByText('Malformed file')).toBeInTheDocument();
    expect(screen.getByTestId('dialog')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('surfaces a generic error when the fetch itself throws', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: [file(envelope())] } });
    await screen.findByText('Staff Morale');

    fireEvent.click(screen.getByRole('button', { name: /import as new questionnaire/i }));

    expect(await screen.findByText(/import failed/i)).toBeInTheDocument();
  });
});

describe('ImportDefinitionDialog — demo-client attribution', () => {
  it('hides the picker when no demo clients are supplied', () => {
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    expect(screen.queryByLabelText('Demo client')).not.toBeInTheDocument();
  });

  it('shows the picker and appends demoClientId to the import URL when one is chosen', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            questionnaireId: 'qn-1',
            versionId: 'ver-1',
            sectionCount: 1,
            questionCount: 1,
            dataSlotCount: 0,
            topicCount: 0,
          },
        }),
        { status: 201 }
      )
    );
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} demoClientOptions={DEMO_CLIENTS} />);
    fireEvent.change(fileInput(), { target: { files: [file(envelope())] } });
    await screen.findByText('Staff Morale');

    fireEvent.change(screen.getByLabelText('Demo client'), { target: { value: 'client-1' } });
    fireEvent.click(screen.getByRole('button', { name: /import as new questionnaire/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('demoClientId=client-1');
  });
});

describe('ImportDefinitionDialog — chrome', () => {
  it('rejects a file over the 5 MB size cap before parsing it', async () => {
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    const big = file(envelope());
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    fireEvent.change(fileInput(), { target: { files: [big] } });

    expect(await screen.findByText(/too large/i)).toBeInTheDocument();
    expect(screen.queryByText('Staff Morale')).not.toBeInTheDocument();
  });

  it('opens the file picker from the initial "Choose definition file" button', () => {
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    const clickSpy = vi.spyOn(fileInput(), 'click');

    fireEvent.click(screen.getByRole('button', { name: /choose definition file/i }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('re-opens the file picker from "Choose a different file" once a preview exists', async () => {
    render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: [file(envelope())] } });
    await screen.findByText('Staff Morale');
    const clickSpy = vi.spyOn(fileInput(), 'click');

    fireEvent.click(screen.getByRole('button', { name: /choose a different file/i }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenChange(false) on Cancel', () => {
    const onOpenChange = vi.fn();
    render(<ImportDefinitionDialog open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('resets staged preview/error/importing state when the dialog closes', async () => {
    const { rerender } = render(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: [file({ kind: 'nope' })] } });
    await screen.findByText(/isn't a questionnaire definition/i);

    rerender(<ImportDefinitionDialog open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument();

    // Re-opening starts clean — the stale error from before closing is gone.
    rerender(<ImportDefinitionDialog open onOpenChange={vi.fn()} />);
    expect(screen.queryByText(/isn't a questionnaire definition/i)).not.toBeInTheDocument();
  });
});
