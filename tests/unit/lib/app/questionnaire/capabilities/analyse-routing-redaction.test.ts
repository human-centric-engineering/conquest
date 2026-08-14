/**
 * Unit test: the Routing Analyst capability's provenance redaction (P17.4).
 *
 * The capability is `processesPii = true` because BOTH of its inputs can carry personal or
 * confidential content: the questionnaire's own prompts, and — more importantly — the whole
 * uploaded instrument document, an arbitrary admin-supplied file this system never inspected. Its
 * OUTPUT quotes spans from both (`sourceQuote` on topics and rules).
 *
 * So the durable provenance row may record shapes and counts, and never text. These tests would
 * FAIL if a raw document/instructions string, a question prompt, or a proposed criterion/quote
 * leaked into what gets persisted to `AppAiRun` / audit rows.
 *
 * @see lib/app/questionnaire/capabilities/analyse-routing.ts
 */

import { describe, it, expect } from 'vitest';

import { AppAnalyseRoutingCapability } from '@/lib/app/questionnaire/capabilities/analyse-routing';
import type { AnalyseRoutingArgs } from '@/lib/app/questionnaire/capabilities/analyse-routing';

const capability = new AppAnalyseRoutingCapability();

const args: AnalyseRoutingArgs = {
  questions: [
    { key: 'q1', prompt: 'How many partners does your firm work through?' },
    { key: 'q2', prompt: 'Describe an incident with a channel conflict at Acme Corp.' },
  ],
  goal: 'Assess channel readiness',
  documentText:
    'CONFIDENTIAL INSTRUMENT: internal routing notes for respondent Jane Doe, case ref 90210. ' +
    'Only ask the Partner Channel section if the respondent sells through resellers.',
  documentFileName: 'channel-instrument.pdf',
  instructions: 'The routing rules are on page 4, under "Guardrails" — read that first.',
  existingTopics: [
    {
      id: 'topic-1',
      key: 'partner_channel',
      label: 'Partner channel',
      description: null,
      phase: 'conditional',
      criteria: 'They sell through partners',
      depth: 'full',
      members: { dataSlotKeys: [], questionKeys: [] },
      ordinal: 0,
      source: 'analyst',
    },
  ],
};

describe('AppAnalyseRoutingCapability.redactProvenance', () => {
  it('records counts and the file name, never the document text', () => {
    const { args: safeArgs } = capability.redactProvenance(args, {
      success: true,
      data: undefined,
    });
    const serialised = JSON.stringify(safeArgs);

    expect(serialised).toContain('channel-instrument.pdf');
    expect(serialised).toContain('"questionCount":2');
    expect(serialised).toContain('"existingTopicCount":1');
    // The redaction placeholder must be present — proof the field was processed, not dropped.
    expect(serialised).toContain('<redacted: documentText>');
    // The uploaded document is an arbitrary admin file — it must never land in an audit row.
    expect(serialised).not.toContain('CONFIDENTIAL');
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('90210');
    expect(serialised).not.toContain('Only ask the Partner Channel section');
  });

  it('records the instructions field as a redaction placeholder, never the admin note', () => {
    const { args: safeArgs } = capability.redactProvenance(args, {
      success: true,
      data: undefined,
    });
    const serialised = JSON.stringify(safeArgs);

    expect(serialised).toContain('<redacted: instructions>');
    expect(serialised).not.toContain('page 4');
    expect(serialised).not.toContain('Guardrails');
  });

  it('never records the question wording itself', () => {
    const { args: safeArgs } = capability.redactProvenance(args, {
      success: true,
      data: undefined,
    });
    const serialised = JSON.stringify(safeArgs);

    expect(serialised).not.toContain('How many partners');
    expect(serialised).not.toContain('channel conflict at Acme Corp');
  });

  it('summarises the result as counts, never the proposed criteria, rationale or quotes', () => {
    const { resultPreview } = capability.redactProvenance(args, {
      success: true,
      data: {
        result: {
          topics: [
            {
              key: 'partner_channel',
              label: 'Partner channel',
              phase: 'conditional',
              criteria: 'They sell through partners or resellers',
              depth: 'full',
              questionKeys: ['q1'],
              dataSlotKeys: [],
              rationale: 'The document routes on channel structure, per the Guardrails page.',
              sourceQuote:
                'Only ask the Partner Channel section if the respondent sells through resellers.',
            },
            {
              key: 'core_ops',
              label: 'Core operations',
              phase: 'core',
              criteria: null,
              depth: 'full',
              questionKeys: [],
              dataSlotKeys: [],
              rationale: 'Runs for everyone.',
            },
          ],
          rules: [
            {
              dataSlotKey: 'channel_type',
              operator: 'equals',
              value: 'reseller',
              action: 'include',
              topicKey: 'partner_channel',
              rationale: 'Stated as a certainty on the Guardrails page.',
              sourceQuote: 'always include Partner Channel when channel_type is reseller',
            },
          ],
          summary: 'Found one conditional section gated on channel structure.',
          fromDocument: true,
        },
      },
    });

    // Shape is useful and non-identifying.
    expect(resultPreview).toContain('"topicCount":2');
    expect(resultPreview).toContain('"conditionalCount":1');
    expect(resultPreview).toContain('"ruleCount":1');
    expect(resultPreview).toContain('"fromDocument":true');
    // The criteria, rationale and — critically — the quoted document spans must not appear.
    expect(resultPreview).not.toContain('sell through partners');
    expect(resultPreview).not.toContain('Guardrails page');
    expect(resultPreview).not.toContain('Only ask the Partner Channel section');
    expect(resultPreview).not.toContain('always include Partner Channel');
    expect(resultPreview).not.toContain('reseller');
  });

  it('omits the document and instructions markers entirely when neither was supplied', () => {
    const { args: safeArgs } = capability.redactProvenance(
      { questions: args.questions },
      { success: true, data: undefined }
    );
    const serialised = JSON.stringify(safeArgs);

    expect(serialised).not.toContain('documentFileName');
    expect(serialised).not.toContain('documentText');
    expect(serialised).not.toContain('instructions');
    expect(serialised).toContain('"dataSlotCount":0');
    expect(serialised).toContain('"existingTopicCount":0');
  });

  it('passes a failed result through without inventing a preview', () => {
    const { resultPreview } = capability.redactProvenance(args, {
      success: false,
      error: { code: 'provider_unavailable', message: 'No provider configured.' },
    });
    expect(resultPreview).toContain('provider_unavailable');
  });
});
