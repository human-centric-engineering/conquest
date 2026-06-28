/**
 * ConfigImportExport — unit tests for the Settings tab import / export toolbar.
 *
 * Pins what the component DOES:
 *  - Export builds a JSON envelope blob and triggers a download
 *  - Importing a valid file opens a confirm dialog previewing the settings count
 *  - Confirming PATCHes the whole parsed config through `run` and closes the dialog
 *  - An invalid file surfaces a parse error and never calls `run`
 *  - A rejected import (run → false) keeps the dialog open with an error
 *
 * Dialog + FieldHelp are stubbed to transparent passthroughs so the assertions focus on this
 * component's own behaviour rather than Radix portal mechanics.
 *
 * @see components/admin/questionnaires/config-import-export.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import type { ConfigView } from '@/lib/app/questionnaire/views';
import type {
  MutationSpec,
  RunMutation,
} from '@/components/admin/questionnaires/version-editor-types';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import { CONFIG_EXPORT_KIND } from '@/lib/app/questionnaire/authoring';

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

// ─── FieldHelp → transparent passthrough ─────────────────────────────────────
vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import { ConfigImportExport } from '@/components/admin/questionnaires/config-import-export';

const CONFIG: ConfigView = { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: true };

function setup(over: { run?: ReturnType<typeof vi.fn>; busy?: boolean } = {}) {
  const run =
    over.run ?? vi.fn((_thunk: () => MutationSpec): Promise<boolean> => Promise.resolve(true));
  render(
    <ConfigImportExport
      questionnaireId="q1"
      versionId="v1"
      config={CONFIG}
      run={run as RunMutation}
      busy={over.busy ?? false}
    />
  );
  return { run };
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input as HTMLInputElement;
}

describe('ConfigImportExport — export', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds an envelope blob and triggers a download on Export', async () => {
    const created: Blob[] = [];
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob: Blob | MediaSource) => {
        created.push(blob as Blob);
        return 'blob:mock';
      });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    setup();
    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);

    const text = await created[0].text();
    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe(CONFIG_EXPORT_KIND);
    expect(parsed.config.selectionStrategy).toBe(DEFAULT_QUESTIONNAIRE_CONFIG.selectionStrategy);
    expect('saved' in parsed.config).toBe(false);
  });
});

describe('ConfigImportExport — import', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a confirm dialog previewing the settings count for a valid file', async () => {
    setup();
    const file = new File(
      [JSON.stringify({ kind: CONFIG_EXPORT_KIND, config: { voiceEnabled: true } })],
      'settings.json',
      { type: 'application/json' }
    );
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(await screen.findByTestId('dialog')).toBeInTheDocument();
    expect(screen.getByText('settings.json')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument(); // settings-found count
  });

  it('PATCHes the parsed config through run and closes the dialog on confirm', async () => {
    const run = vi.fn((_thunk: () => MutationSpec): Promise<boolean> => Promise.resolve(true));
    setup({ run });

    const file = new File(
      [JSON.stringify({ kind: CONFIG_EXPORT_KIND, config: { voiceEnabled: true, saved: true } })],
      'settings.json',
      { type: 'application/json' }
    );
    fireEvent.change(fileInput(), { target: { files: [file] } });

    fireEvent.click(await screen.findByRole('button', { name: /import & save/i }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const [method, path, body] = run.mock.calls[0][0]();
    expect(method).toBe('PATCH');
    expect(path).toContain('/api/v1/app/questionnaires/q1/versions/v1/config');
    expect(body).toEqual({ voiceEnabled: true }); // `saved` stripped
    await waitFor(() => expect(screen.queryByTestId('dialog')).not.toBeInTheDocument());
  });

  it('surfaces a parse error and never calls run for an invalid file', async () => {
    const run = vi.fn((_thunk: () => MutationSpec): Promise<boolean> => Promise.resolve(true));
    setup({ run });

    const file = new File(['{ not json'], 'broken.json', { type: 'application/json' });
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(await screen.findByText(/not valid json/i)).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with an error when the import is rejected', async () => {
    const run = vi.fn((_thunk: () => MutationSpec): Promise<boolean> => Promise.resolve(false));
    setup({ run });

    const file = new File(
      [JSON.stringify({ kind: CONFIG_EXPORT_KIND, config: { voiceEnabled: true } })],
      'settings.json',
      { type: 'application/json' }
    );
    fireEvent.change(fileInput(), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: /import & save/i }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/import failed/i)).toBeInTheDocument();
    expect(screen.getByTestId('dialog')).toBeInTheDocument();
  });
});
