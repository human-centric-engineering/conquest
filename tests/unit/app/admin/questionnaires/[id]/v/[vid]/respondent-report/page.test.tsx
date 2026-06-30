/**
 * Respondent report tab page — unit tests.
 *
 *  - notFound() when the respondentReport flag is off
 *  - renders the editor with the resolved config slice + data-slots flag when on
 *  - falls back to DEFAULT_RESPONDENT_REPORT_SETTINGS when the version has no config
 *
 * @see app/admin/questionnaires/[id]/v/[vid]/respondent-report/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { QuestionnaireDetail, VersionGraphView } from '@/lib/app/questionnaire/views';
import type { QuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';
import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
} from '@/lib/app/questionnaire/types';

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ notFound: mockNotFound, redirect: vi.fn() }));

const workspaceDataMock = vi.hoisted(() => ({
  getVersionGraphCached: vi.fn<() => Promise<VersionGraphView | null>>(),
  getQuestionnaireDetailCached: vi.fn<() => Promise<QuestionnaireDetail | null>>(),
  resolveQuestionnaireWorkspaceFlags: vi.fn<() => Promise<QuestionnaireWorkspaceFlags>>(),
}));
vi.mock('@/lib/app/questionnaire/workspace-data', () => workspaceDataMock);

vi.mock('@/components/admin/questionnaires/report/respondent-report-editor', () => ({
  RespondentReportEditor: (props: {
    questionnaireId: string;
    versionId: string;
    initial: { mode: string };
    dataSlotsEnabled: boolean;
    client: { id: string; name: string } | null;
  }) => (
    <div
      data-testid="rr-editor"
      data-qid={props.questionnaireId}
      data-vid={props.versionId}
      data-mode={props.initial.mode}
      data-dataslots={String(props.dataSlotsEnabled)}
      data-client-id={props.client?.id ?? ''}
      data-client-name={props.client?.name ?? ''}
    />
  ),
}));

import RespondentReportTab from '@/app/admin/questionnaires/[id]/v/[vid]/respondent-report/page';

function flags(over: Partial<QuestionnaireWorkspaceFlags> = {}): QuestionnaireWorkspaceFlags {
  return {
    master: true,
    dataSlots: false,
    designEval: false,
    liveSessions: true,
    adaptive: false,
    adaptiveDataSlots: false,
    respondentReport: true,
    cohortReport: true,
    introScreen: false,
    advisor: false,
    editAgent: false,
    ...over,
  };
}

const ctx = { params: Promise.resolve({ id: 'qn-1', vid: 'v1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(flags());
  workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(null);
  workspaceDataMock.getVersionGraphCached.mockResolvedValue({
    config: {
      ...DEFAULT_QUESTIONNAIRE_CONFIG,
      respondentReport: { ...DEFAULT_RESPONDENT_REPORT_SETTINGS, mode: 'raw_plus_insights' },
      saved: true,
    },
  } as unknown as VersionGraphView);
});

describe('RespondentReportTab', () => {
  it('notFound()s when the respondentReport flag is off', async () => {
    workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(
      flags({ respondentReport: false })
    );
    await expect(RespondentReportTab({ params: ctx.params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled();
  });

  it('renders the editor with the resolved config + data-slots flag', async () => {
    workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(
      flags({ dataSlots: true })
    );
    render(await RespondentReportTab({ params: ctx.params }));
    const editor = screen.getByTestId('rr-editor');
    expect(editor.dataset.qid).toBe('qn-1');
    expect(editor.dataset.vid).toBe('v1');
    expect(editor.dataset.mode).toBe('raw_plus_insights');
    expect(editor.dataset.dataslots).toBe('true');
  });

  it('falls back to default settings when the version has no graph/config', async () => {
    workspaceDataMock.getVersionGraphCached.mockResolvedValue(null);
    render(await RespondentReportTab({ params: ctx.params }));
    expect(screen.getByTestId('rr-editor').dataset.mode).toBe(
      DEFAULT_RESPONDENT_REPORT_SETTINGS.mode
    );
  });

  it('forwards the attributed demo client (id + name) to the editor', async () => {
    workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue({
      demoClient: { id: 'client-9', slug: 'acme', name: 'Acme Bank' },
    } as unknown as QuestionnaireDetail);
    render(await RespondentReportTab({ params: ctx.params }));
    const editor = screen.getByTestId('rr-editor');
    expect(editor.dataset.clientId).toBe('client-9');
    expect(editor.dataset.clientName).toBe('Acme Bank');
  });

  it('passes a null client for a generic (unattributed) questionnaire', async () => {
    workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue({
      demoClient: null,
    } as unknown as QuestionnaireDetail);
    render(await RespondentReportTab({ params: ctx.params }));
    expect(screen.getByTestId('rr-editor').dataset.clientId).toBe('');
  });
});
