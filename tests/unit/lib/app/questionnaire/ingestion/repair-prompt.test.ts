import { describe, it, expect } from 'vitest';

import { buildRepairPrompt } from '@/lib/app/questionnaire/ingestion/repair-prompt';

/**
 * Contract tests for the scales & matrix repair specialist's prompt.
 *
 * The specialist is the step that acts on a critic flag, and its corrections are re-validated
 * against the tight authoring write schema by `mergeRepairs` — anything that fails is discarded
 * and the original kept. So a rule that steers it toward an unvalidatable shape costs a model
 * call and changes nothing. That is exactly what happened on the routing corpus: told a
 * "Rating 1-5" was mis-typed as numeric, it built a likert with no anchors, which
 * `likertWriteConfigSchema` rejects by design.
 */

function systemRules(): string {
  const messages = buildRepairPrompt({ targets: [], matrixGroups: [], documentText: 'Q1' });
  const system = messages.find((m) => m.role === 'system');
  if (!system || typeof system.content !== 'string') {
    throw new Error('expected a string system message');
  }
  return system.content;
}

describe('buildRepairPrompt — numeric rules', () => {
  it('tells the specialist to carry a stated range into min/max', () => {
    const rules = systemRules();
    expect(rules).toMatch(/Rating 1-5/);
    expect(rules).toMatch(/\{"min":1,"max":5\}/);
  });

  it('forbids "upgrading" an unanchored numeric to a likert to give it labels', () => {
    const rules = systemRules();
    expect(rules).toMatch(/Do NOT "upgrade"/i);
    // The reason matters more than the instruction: an unlabelled likert is discarded downstream.
    expect(rules).toMatch(/REJECTED by the authoring schema|discarded/i);
  });
});

describe('buildRepairPrompt — structure', () => {
  it('passes the verifier flags through so the specialist knows what to fix', () => {
    const messages = buildRepairPrompt({
      targets: [],
      matrixGroups: [],
      issueByKey: { pm1: 'type_mismatch — source says Rating 1-5' },
      documentText: 'PM1,Rating 1-5',
      fileName: 'medication-review.csv',
    });
    const user = messages[1].content;
    expect(user).toContain('pm1');
    expect(user).toContain('type_mismatch');
    expect(user).toContain('medication-review.csv');
  });
});
