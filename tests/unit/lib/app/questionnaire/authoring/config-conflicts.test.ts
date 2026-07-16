/**
 * Unit test: version-config conflict detection (authoring).
 *
 * Pure detector — no mocks. One case per rule (present ↔ absent), plus the "clean config → none" and
 * a couple of guard cases (capture off suppresses capture conflicts; non-form presentation suppresses
 * the form-only family). Each conflict is identified by its stable id.
 */

import { describe, it, expect } from 'vitest';

import {
  detectConfigConflicts,
  type ConfigConflictInput,
} from '@/lib/app/questionnaire/authoring/config-conflicts';

/** A coherent baseline — no conflicts. Override per case. */
function input(over: Partial<ConfigConflictInput> = {}): ConfigConflictInput {
  return {
    anonymousMode: false,
    presentationMode: 'both',
    captureEnabled: false,
    captureMode: 'form',
    profileFields: [],
    personaSelectionEnabled: false,
    reasoningStreamEnabled: false,
    voiceInputEnabled: false,
    attachmentInputEnabled: false,
    minQuestionsAnswered: 0,
    questionCount: 10,
    sensitivityAwareness: false,
    supportMessage: '',
    ...over,
  };
}

const ids = (over: Partial<ConfigConflictInput>) =>
  detectConfigConflicts(input(over)).map((c) => c.id);

describe('detectConfigConflicts', () => {
  it('returns no conflicts for a coherent config', () => {
    expect(detectConfigConflicts(input())).toEqual([]);
  });

  describe('anonymous mode vs profile capture', () => {
    it('flags capture configured on an anonymous version', () => {
      const conflicts = detectConfigConflicts(
        input({ anonymousMode: true, captureEnabled: true, profileFields: [{}] })
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        id: 'anonymous-hides-capture',
        severity: 'error',
        sectionId: 'profile-fields',
      });
    });

    it('does not flag when capture is off (even if anonymous)', () => {
      expect(
        ids({ anonymousMode: true, captureEnabled: false, profileFields: [{}] })
      ).not.toContain('anonymous-hides-capture');
    });

    it('does not flag when capture is on but there are no fields', () => {
      expect(ids({ anonymousMode: true, captureEnabled: true, profileFields: [] })).not.toContain(
        'anonymous-hides-capture'
      );
    });
  });

  describe('form-only presentation family', () => {
    it('flags a conversational-placement field in a form-only questionnaire', () => {
      expect(
        ids({
          presentationMode: 'form',
          captureEnabled: true,
          captureMode: 'form',
          profileFields: [{ captureVia: 'conversational' }],
        })
      ).toContain('form-only-conversational-capture');
    });

    it('flags fields inheriting a conversational default in form-only', () => {
      expect(
        ids({
          presentationMode: 'form',
          captureEnabled: true,
          captureMode: 'conversational',
          profileFields: [{}],
        })
      ).toContain('form-only-conversational-capture');
    });

    it('does NOT flag conversational-capture conflict when presentation includes chat', () => {
      expect(
        ids({
          presentationMode: 'both',
          captureEnabled: true,
          captureMode: 'conversational',
          profileFields: [{}],
        })
      ).not.toContain('form-only-conversational-capture');
    });

    it('flags persona selection in form-only', () => {
      expect(ids({ presentationMode: 'form', personaSelectionEnabled: true })).toContain(
        'form-only-persona'
      );
    });

    it('flags reasoning stream in form-only', () => {
      expect(ids({ presentationMode: 'form', reasoningStreamEnabled: true })).toContain(
        'form-only-reasoning'
      );
    });

    it('flags composer inputs in form-only (voice and/or attachments)', () => {
      expect(ids({ presentationMode: 'form', voiceInputEnabled: true })).toContain(
        'form-only-composer'
      );
      const both = detectConfigConflicts(
        input({ presentationMode: 'form', voiceInputEnabled: true, attachmentInputEnabled: true })
      ).find((c) => c.id === 'form-only-composer');
      expect(both?.title).toMatch(/voice input and attachments/i);
    });

    it('raises none of the form-only family for a chat/both questionnaire', () => {
      const conflicts = ids({
        presentationMode: 'both',
        personaSelectionEnabled: true,
        reasoningStreamEnabled: true,
        voiceInputEnabled: true,
        attachmentInputEnabled: true,
      });
      expect(conflicts).toEqual([]);
    });
  });

  describe('completion + safeguarding', () => {
    it('flags a minimum-questions floor above the question count', () => {
      expect(ids({ minQuestionsAnswered: 12, questionCount: 10 })).toContain(
        'min-questions-unreachable'
      );
    });

    it('does not flag when the minimum is within the count (or count unknown)', () => {
      expect(ids({ minQuestionsAnswered: 10, questionCount: 10 })).not.toContain(
        'min-questions-unreachable'
      );
      expect(ids({ minQuestionsAnswered: 5, questionCount: 0 })).not.toContain(
        'min-questions-unreachable'
      );
    });

    it('flags sensitivity awareness with no support message', () => {
      const conflicts = detectConfigConflicts(
        input({ sensitivityAwareness: true, supportMessage: '   ' })
      );
      expect(conflicts.map((c) => c.id)).toContain('sensitivity-no-support');
      expect(conflicts.find((c) => c.id === 'sensitivity-no-support')?.severity).toBe('info');
    });

    it('does not flag sensitivity when a support message is present', () => {
      expect(
        ids({ sensitivityAwareness: true, supportMessage: 'Call the helpline on 123.' })
      ).not.toContain('sensitivity-no-support');
    });
  });

  it('surfaces multiple simultaneous conflicts', () => {
    const conflicts = ids({
      presentationMode: 'form',
      anonymousMode: true,
      captureEnabled: true,
      profileFields: [{ captureVia: 'conversational' }],
      reasoningStreamEnabled: true,
    });
    expect(conflicts).toEqual(
      expect.arrayContaining([
        'anonymous-hides-capture',
        'form-only-conversational-capture',
        'form-only-reasoning',
      ])
    );
  });
});
