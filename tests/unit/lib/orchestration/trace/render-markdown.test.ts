/**
 * Tests for `lib/orchestration/trace/render-markdown.ts`.
 *
 * No snapshot files — just structural assertions on the emitted
 * Markdown. Snapshot tests would freeze the template on every cosmetic
 * tweak; these target the load-bearing properties: header data,
 * supervisor block ordering, step timeline, footer.
 */

import { describe, it, expect } from 'vitest';

import {
  renderExecutionMarkdown,
  type RenderExecutionInfo,
} from '@/lib/orchestration/trace/render-markdown';
import type { ExecutionTraceEntry } from '@/types/orchestration';

function makeExecution(overrides: Partial<RenderExecutionInfo> = {}): RenderExecutionInfo {
  return {
    id: 'exec_1',
    workflowId: 'wf_1',
    workflowName: 'Test workflow',
    status: 'completed',
    totalTokensUsed: 1500,
    totalCostUsd: 0.0234,
    startedAt: '2026-05-17T10:00:00.000Z',
    completedAt: '2026-05-17T10:00:05.000Z',
    inputData: { foo: 'bar' },
    outputData: { result: 'ok' },
    errorMessage: null,
    ...overrides,
  };
}

function makeTrace(): ExecutionTraceEntry[] {
  return [
    {
      stepId: 's1',
      stepType: 'llm_call',
      label: 'First step',
      status: 'completed',
      output: 'first output',
      durationMs: 1500,
      tokensUsed: 200,
      costUsd: 0.001,
      startedAt: '2026-05-17T10:00:00.000Z',
      completedAt: '2026-05-17T10:00:01.500Z',
    } as ExecutionTraceEntry,
    {
      stepId: 's2',
      stepType: 'evaluate',
      label: 'Second step',
      status: 'completed',
      output: { score: 0.9 },
      durationMs: 3500,
      tokensUsed: 1300,
      costUsd: 0.0224,
      startedAt: '2026-05-17T10:00:01.500Z',
      completedAt: '2026-05-17T10:00:05.000Z',
    } as ExecutionTraceEntry,
  ];
}

describe('renderExecutionMarkdown', () => {
  it('renders a header with id, workflow, status, duration, cost, tokens', () => {
    const md = renderExecutionMarkdown(makeExecution(), makeTrace());
    expect(md).toContain('# Execution report — `exec_1`');
    expect(md).toContain('Test workflow');
    expect(md).toContain('`completed`');
    expect(md).toContain('1,500'); // totalTokens with grouping
    expect(md).toContain('$0.0234');
    expect(md).toContain('5.00s'); // duration formatted
  });

  it('renders each step with type, status, duration, tokens, cost', () => {
    const md = renderExecutionMarkdown(makeExecution(), makeTrace());
    expect(md).toContain('### 1. First step `[completed]`');
    expect(md).toContain('Type `llm_call`');
    expect(md).toContain('Duration 1.50s');
    expect(md).toContain('Tokens 200');
    expect(md).toContain('### 2. Second step');
    expect(md).toContain('Type `evaluate`');
  });

  it('omits supervisor block when no supervisorReport on execution', () => {
    const md = renderExecutionMarkdown(makeExecution(), makeTrace());
    expect(md).not.toContain('Neutral supervisor assessment');
  });

  it('renders supervisor block above the input section when supervisorReport is present', () => {
    const md = renderExecutionMarkdown(
      makeExecution({
        supervisorVerdict: 'concerns',
        supervisorScore: 0.6,
        supervisorReport: {
          verdict: 'concerns',
          score: 0.6,
          summary: 'Some issues found.',
          strengths: [],
          weaknesses: [
            {
              severity: 'medium',
              claim: 'Validator passed weak proposal',
              evidenceStepId: 's2',
              evidenceQuote: 'score',
              recommendation: 'Tighten the schema',
            },
          ],
          anomalies: [],
          unverifiedAreas: ['cost projection downstream'],
          confidence: 'medium',
        },
      }),
      makeTrace()
    );
    expect(md).toContain('Neutral supervisor assessment');
    expect(md).toContain('`concerns`');
    expect(md).toContain('Validator passed weak proposal');
    expect(md).toContain('Tighten the schema');
    expect(md).toContain('cost projection downstream');
    // Verdict block precedes input + step timeline
    const verdictIdx = md.indexOf('Neutral supervisor assessment');
    const inputIdx = md.indexOf('## Input data');
    expect(verdictIdx).toBeGreaterThan(0);
    expect(inputIdx).toBeGreaterThan(verdictIdx);
  });

  it('surfaces error message in a fenced block when present', () => {
    const md = renderExecutionMarkdown(
      makeExecution({ status: 'failed', errorMessage: 'connection refused' }),
      makeTrace()
    );
    expect(md).toContain('## Error');
    expect(md).toContain('connection refused');
  });

  it('renders step retries inline when present', () => {
    const traceWithRetries: ExecutionTraceEntry[] = [
      {
        ...makeTrace()[0],
        retries: [
          { attempt: 1, maxRetries: 2, reason: 'timeout', targetStepId: 's1' },
          { attempt: 2, maxRetries: 2, reason: 'timeout', targetStepId: 's1', exhausted: true },
        ],
      } as ExecutionTraceEntry,
    ];
    const md = renderExecutionMarkdown(makeExecution(), traceWithRetries);
    expect(md).toContain('**Retries:**');
    expect(md).toContain('attempt 1/2: timeout');
    expect(md).toContain('attempt 2/2: timeout (exhausted)');
  });

  it('marks expectedSkip steps with a friendly note', () => {
    const skipTrace: ExecutionTraceEntry[] = [
      {
        stepId: 's1',
        stepType: 'external_call',
        label: 'optional enrichment',
        status: 'skipped',
        expectedSkip: true,
        durationMs: 0,
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2026-05-17T10:00:00.000Z',
      } as ExecutionTraceEntry,
    ];
    const md = renderExecutionMarkdown(makeExecution(), skipTrace);
    expect(md).toContain('expectedSkip');
  });

  it('emits the footer with the execution id and admin link', () => {
    const md = renderExecutionMarkdown(makeExecution(), makeTrace(), {
      hostPrefix: 'https://admin.example.com',
    });
    expect(md).toContain('https://admin.example.com/admin/orchestration/executions/exec_1');
    expect(md).toContain('Execution `exec_1`');
    expect(md).toContain('Generated');
  });

  it('truncates large step outputs in auto mode with elision markers', () => {
    const longOutput = 'A'.repeat(20_000);
    const t: ExecutionTraceEntry[] = [
      {
        stepId: 's1',
        stepType: 'llm_call',
        label: 'huge output',
        status: 'completed',
        output: longOutput,
        durationMs: 100,
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2026-05-17T10:00:00.000Z',
      } as ExecutionTraceEntry,
    ];
    const md = renderExecutionMarkdown(makeExecution(), t);
    expect(md).toContain('truncated');
    expect(md.length).toBeLessThan(longOutput.length);
  });

  it('includeStepOutputs="all" disables truncation', () => {
    const longOutput = 'A'.repeat(10_000);
    const t: ExecutionTraceEntry[] = [
      {
        stepId: 's1',
        stepType: 'llm_call',
        label: 'huge output',
        status: 'completed',
        output: longOutput,
        durationMs: 100,
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2026-05-17T10:00:00.000Z',
      } as ExecutionTraceEntry,
    ];
    const md = renderExecutionMarkdown(makeExecution(), t, { includeStepOutputs: 'all' });
    expect(md).not.toContain('truncated');
    expect(md).toContain(longOutput);
  });

  it('handles an empty trace gracefully', () => {
    const md = renderExecutionMarkdown(makeExecution(), []);
    expect(md).toContain('No trace entries recorded');
  });

  it('renders workflow id without a name when workflowName is null', () => {
    const md = renderExecutionMarkdown(makeExecution({ workflowName: null }), makeTrace());
    // No human name appears; just the raw id.
    expect(md).toContain('`wf_1`');
    expect(md).not.toContain('Test workflow');
  });

  it('renders em-dash when started/completed timestamps are missing', () => {
    const md = renderExecutionMarkdown(
      makeExecution({ startedAt: null, completedAt: null }),
      makeTrace()
    );
    expect(md).toContain('| Started | — |');
    expect(md).toContain('| Completed | — |');
    expect(md).toContain('| Duration | — |');
  });

  it('renders em-dash when the started/completed timestamps are invalid date strings', () => {
    const md = renderExecutionMarkdown(
      makeExecution({ startedAt: 'not-a-date', completedAt: 'also-bad' }),
      makeTrace()
    );
    // formatTotalDuration NaN-check branch fires
    expect(md).toContain('| Duration | — |');
  });

  it('formats sub-second durations in ms and multi-minute durations as "Mm Ss"', () => {
    const traceWithDurations: ExecutionTraceEntry[] = [
      {
        stepId: 'fast',
        stepType: 'llm_call',
        label: 'fast step',
        status: 'completed',
        output: 'x',
        durationMs: 250, // < 1s — rendered as "250ms"
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2026-05-17T10:00:00.000Z',
      } as ExecutionTraceEntry,
      {
        stepId: 'slow',
        stepType: 'llm_call',
        label: 'slow step',
        status: 'completed',
        output: 'x',
        durationMs: 75_000, // 1m 15s
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2026-05-17T10:00:00.000Z',
      } as ExecutionTraceEntry,
    ];
    const md = renderExecutionMarkdown(makeExecution(), traceWithDurations);
    expect(md).toContain('Duration 250ms');
    expect(md).toContain('Duration 1m 15s');
  });

  it('shows em-dash for steps with missing or NaN durationMs', () => {
    const t: ExecutionTraceEntry[] = [
      {
        stepId: 's1',
        stepType: 'llm_call',
        label: 'no duration',
        status: 'completed',
        output: 'x',
        // durationMs intentionally undefined
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2026-05-17T10:00:00.000Z',
      } as unknown as ExecutionTraceEntry,
    ];
    const md = renderExecutionMarkdown(makeExecution(), t);
    expect(md).toContain('Duration —');
  });

  it('renders the model and provider chips when present on a step', () => {
    const t: ExecutionTraceEntry[] = [
      {
        stepId: 's1',
        stepType: 'llm_call',
        label: 'step with llm meta',
        status: 'completed',
        output: 'x',
        durationMs: 100,
        tokensUsed: 10,
        costUsd: 0.001,
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        startedAt: '2026-05-17T10:00:00.000Z',
      } as ExecutionTraceEntry,
    ];
    const md = renderExecutionMarkdown(makeExecution(), t);
    expect(md).toContain('Model `claude-sonnet-4-6`');
    expect(md).toContain('Provider `anthropic`');
  });

  it('renders the step input block when entry.input is set', () => {
    const t: ExecutionTraceEntry[] = [
      {
        stepId: 's1',
        stepType: 'llm_call',
        label: 'step with input',
        status: 'completed',
        input: { prompt: 'go' },
        output: { result: 'done' },
        durationMs: 100,
        tokensUsed: 10,
        costUsd: 0.001,
        startedAt: '2026-05-17T10:00:00.000Z',
      } as unknown as ExecutionTraceEntry,
    ];
    const md = renderExecutionMarkdown(makeExecution(), t);
    expect(md).toContain('**Input**');
    expect(md).toContain('"prompt": "go"');
  });

  it('renders anomalies and unverifiedAreas blocks in the supervisor section', () => {
    const md = renderExecutionMarkdown(
      makeExecution({
        supervisorVerdict: 'concerns',
        supervisorReport: {
          verdict: 'concerns',
          score: 0.6,
          summary: 's',
          strengths: [],
          weaknesses: [],
          anomalies: [{ stepId: 's2', observation: 'duration spike' }],
          unverifiedAreas: ['cost projection'],
          confidence: 'medium',
        },
      }),
      makeTrace()
    );
    expect(md).toContain('**Anomalies**');
    expect(md).toContain('duration spike');
    expect(md).toContain('**Unverified areas**');
    expect(md).toContain('cost projection');
  });

  it('notes when the citation validator stripped citations (invalidCitations present)', () => {
    const md = renderExecutionMarkdown(
      makeExecution({
        supervisorVerdict: 'concerns',
        supervisorReport: {
          verdict: 'concerns',
          score: 0.5,
          summary: 's',
          strengths: [],
          weaknesses: [],
          anomalies: [],
          unverifiedAreas: [],
          confidence: 'medium',
          invalidCitations: [
            {
              location: 'weakness',
              index: 0,
              reason: 'unknown_step_id',
              evidenceStepId: 'ghost',
              evidenceQuote: 'q',
            },
          ],
        },
      }),
      makeTrace()
    );
    expect(md).toContain('citation validator stripped');
  });

  it('renders a weakness without citation fields (null evidence — the no-defects escape hatch)', () => {
    const md = renderExecutionMarkdown(
      makeExecution({
        supervisorVerdict: 'pass',
        supervisorReport: {
          verdict: 'pass',
          score: 0.95,
          summary: 'clean',
          strengths: [],
          weaknesses: [
            {
              severity: 'low',
              claim: 'no defects found, verified: s1',
              evidenceStepId: null,
              evidenceQuote: null,
              recommendation: 'continue monitoring',
            },
          ],
          anomalies: [],
          unverifiedAreas: [],
          confidence: 'high',
        },
      }),
      makeTrace()
    );
    // No "(see step `...`...)" citation appears, just the claim + recommendation
    expect(md).toContain('no defects found, verified: s1');
    expect(md).toContain('continue monitoring');
    expect(md).not.toMatch(/\(see step `[^`]+`/);
  });

  it('renders the supervisor verdict row with no score when supervisorScore is null', () => {
    const md = renderExecutionMarkdown(
      makeExecution({
        supervisorVerdict: 'pass',
        supervisorScore: null,
        supervisorReport: {
          verdict: 'pass',
          score: 0.9,
          summary: 's',
          strengths: [],
          weaknesses: [],
          anomalies: [],
          unverifiedAreas: [],
          confidence: 'high',
        },
      }),
      makeTrace()
    );
    expect(md).toContain('| Supervisor verdict | `pass` |');
    // The "(score X.XX)" parenthetical is omitted when supervisorScore is non-number
    expect(md).not.toContain('Supervisor verdict | `pass` (score');
  });

  it('falls back to "(serialise failure)" placeholder when inputData has a circular ref', () => {
    const cycle: Record<string, unknown> = { name: 'x' };
    cycle.self = cycle;
    const md = renderExecutionMarkdown(makeExecution({ inputData: cycle }), makeTrace());
    expect(md).toContain('could not serialize');
  });

  it('renders "_none_" for the Output data section when outputData is null', () => {
    const md = renderExecutionMarkdown(makeExecution({ outputData: null }), makeTrace());
    expect(md).toContain('## Output data');
    expect(md).toContain('_none_');
  });
});
