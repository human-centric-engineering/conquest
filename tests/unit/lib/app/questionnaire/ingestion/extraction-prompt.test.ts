import { describe, it, expect } from 'vitest';

import {
  buildExtractionPrompt,
  buildExtractionRetryMessage,
  adminSuppliedFieldPaths,
} from '@/lib/app/questionnaire/ingestion/extraction-prompt';
import { QUESTION_TYPES } from '@/lib/app/questionnaire/types';
import { CHANGE_TYPES } from '@/lib/app/questionnaire/ingestion/types';

/**
 * Contract tests for the extraction prompt builder (F1.1 / PR2).
 *
 * The builder owns the prompt's STRUCTURE, not its wording, so these assert the
 * load-bearing invariants: a system+user message pair, the document embedded
 * verbatim, the full type/change vocabularies surfaced from their single source
 * of truth, and the admin's do-not-infer list driving per-field suppression.
 */

function userContent(messages: ReturnType<typeof buildExtractionPrompt>): string {
  const user = messages.find((m) => m.role === 'user');
  if (!user || typeof user.content !== 'string') throw new Error('expected a string user message');
  return user.content;
}

function systemContent(messages: ReturnType<typeof buildExtractionPrompt>): string {
  const system = messages.find((m) => m.role === 'system');
  if (!system || typeof system.content !== 'string') {
    throw new Error('expected a string system message');
  }
  return system.content;
}

describe('adminSuppliedFieldPaths', () => {
  it('returns [] when nothing is supplied', () => {
    expect(adminSuppliedFieldPaths(undefined)).toEqual([]);
    expect(adminSuppliedFieldPaths({})).toEqual([]);
    expect(adminSuppliedFieldPaths({ audience: {} })).toEqual([]);
  });

  it('lists goal and dotted audience paths for every present field', () => {
    expect(
      adminSuppliedFieldPaths({
        goal: 'Understand needs',
        audience: { role: 'nurse', locale: 'en' },
      })
    ).toEqual(['goal', 'audience.role', 'audience.locale']);
  });

  it('treats an empty string as supplied but undefined as not supplied', () => {
    expect(adminSuppliedFieldPaths({ goal: '' })).toEqual(['goal']);
    expect(adminSuppliedFieldPaths({ goal: undefined, audience: { role: undefined } })).toEqual([]);
  });
});

describe('buildExtractionPrompt — structure', () => {
  it('returns exactly a system message then a user message', () => {
    const messages = buildExtractionPrompt({ documentText: 'Q1', fileName: 'survey.pdf' });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('embeds the document text verbatim and names the file', () => {
    const documentText = 'Section A\n1. What is your naem?\nFor office use only: ____';
    const messages = buildExtractionPrompt({ documentText, fileName: 'intake.docx' });
    const user = userContent(messages);
    expect(user).toContain(documentText);
    expect(user).toContain('intake.docx');
  });

  it('includes the media type only when provided', () => {
    const withType = userContent(
      buildExtractionPrompt({ documentText: 'x', fileName: 'f.pdf', mediaType: 'application/pdf' })
    );
    expect(withType).toContain('application/pdf');

    const withoutType = userContent(
      buildExtractionPrompt({ documentText: 'x', fileName: 'f.pdf' })
    );
    expect(withoutType).not.toContain('Media type:');
  });
});

describe('buildExtractionPrompt — vocabulary from the single source of truth', () => {
  const system = systemContent(buildExtractionPrompt({ documentText: 'x', fileName: 'f.txt' }));

  it('surfaces every canonical question type', () => {
    for (const type of QUESTION_TYPES) expect(system).toContain(type);
  });

  it('surfaces every change type', () => {
    for (const changeType of CHANGE_TYPES) expect(system).toContain(changeType);
  });

  it('states the two coherence rules the normaliser also enforces', () => {
    // prune ⇒ afterJson null; infer ⇒ version-targeted.
    expect(system).toMatch(/prune.*afterJson.*null/is);
    expect(system).toMatch(/infer_goal.*infer_audience/is);
    expect(system).toMatch(/version/i);
  });

  it('requires a change record per edit and none for verbatim questions', () => {
    expect(system).toMatch(/every editorial decision/i);
    expect(system).toMatch(/verbatim[\s\S]*NO change/i);
  });
});

describe('buildExtractionPrompt — inference suppression instruction', () => {
  it('tells the model to infer both when the admin supplied nothing', () => {
    const user = userContent(buildExtractionPrompt({ documentText: 'x', fileName: 'f.txt' }));
    expect(user).toMatch(/infer both/i);
    expect(user).not.toMatch(/do NOT infer/);
  });

  it('names exactly the supplied fields in a do-not-infer instruction', () => {
    const user = userContent(
      buildExtractionPrompt({
        documentText: 'x',
        fileName: 'f.txt',
        adminSupplied: { goal: 'G', audience: { role: 'patient' } },
      })
    );
    expect(user).toMatch(/do NOT infer/);
    expect(user).toContain('goal');
    expect(user).toContain('audience.role');
    // A field the admin did NOT supply must not be in the skip list.
    expect(user).not.toContain('audience.sensitivity');
  });
});

describe('buildExtractionRetryMessage', () => {
  it('names the failing issue paths when provided', () => {
    const message = buildExtractionRetryMessage([
      'questions.0.suggestedType',
      'changes.1.changeType',
    ]);
    expect(message).toContain('questions.0.suggestedType');
    expect(message).toContain('changes.1.changeType');
    expect(message).toMatch(/required keys/i);
  });

  it('falls back to a generic instruction with no paths', () => {
    const message = buildExtractionRetryMessage([]);
    expect(message).toMatch(/not valid JSON/i);
    expect(message).toMatch(/sections.*questions.*changes/i);
  });
});
