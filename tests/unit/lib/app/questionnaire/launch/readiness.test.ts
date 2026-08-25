/**
 * Launch / preview readiness — pure-logic tests.
 *
 * `readiness.ts` is the single source of the criteria a version must meet before it can be
 * launched OR previewed. Four consumers depend on it (launch checklist UI, status-route launch
 * gate, preview gate, overview page), so the rules are pinned here directly rather than only
 * through those consumers: each base check, the empty-audience edge, and the conditional
 * data-slots check.
 */

import { describe, it, expect } from 'vitest';

import {
  blocksLaunch,
  hasAudience,
  isLaunchReady,
  isPreviewAvailable,
  launchReadinessChecks,
  type LaunchReadinessInput,
} from '@/lib/app/questionnaire/launch/readiness';

/** A version that passes every base check (no data-slots requirement). */
const READY: LaunchReadinessInput = {
  goal: 'Understand the prospect',
  audience: { description: 'Prospective customers' },
  sectionCount: 2,
  questionCount: 5,
  configSaved: true,
  dataSlotsRequired: false,
  dataSlotsReady: false,
};

describe('hasAudience', () => {
  it('is true when at least one field is defined', () => {
    expect(hasAudience({ description: 'Customers' })).toBe(true);
    expect(hasAudience({ role: 'Buyer' })).toBe(true);
  });

  it('is false for null, an empty object, or a non-object', () => {
    expect(hasAudience(null)).toBe(false);
    expect(hasAudience({})).toBe(false);
    expect(hasAudience('audience')).toBe(false);
    expect(hasAudience(['description'])).toBe(false);
  });

  it('is false when every field is null/undefined (a persisted-but-empty shape)', () => {
    expect(hasAudience({ description: undefined, role: null })).toBe(false);
  });
});

describe('launchReadinessChecks — adaptive scope', () => {
  it('adds no row while the version has not opted in', () => {
    // The overwhelming majority of questionnaires never turn Adaptive Scope on. A permanently-green
    // row for a feature nobody enabled is noise on every one of them.
    const checks = launchReadinessChecks({ ...READY, adaptiveScopeErrorCount: 3 });
    expect(checks.map((c) => c.key)).not.toContain('adaptiveScope');
  });

  it('blocks launch when an enabled version has error-severity findings', () => {
    const checks = launchReadinessChecks({
      ...READY,
      adaptiveScopeEnabled: true,
      adaptiveScopeErrorCount: 1,
    });
    expect(checks.find((c) => c.key === 'adaptiveScope')?.ok).toBe(false);
    expect(
      isLaunchReady({ ...READY, adaptiveScopeEnabled: true, adaptiveScopeErrorCount: 1 })
    ).toBe(false);
  });

  it('passes when an enabled version has only warnings', () => {
    // Warnings mean "it will run, just not as you probably intend" — advisory, never a gate.
    const checks = launchReadinessChecks({
      ...READY,
      adaptiveScopeEnabled: true,
      adaptiveScopeErrorCount: 0,
    });
    expect(checks.find((c) => c.key === 'adaptiveScope')?.ok).toBe(true);
  });
});

describe('launchReadinessChecks — adaptive scope is off but conditional topics exist', () => {
  const OFF_WITH_CONDITIONALS: LaunchReadinessInput = {
    ...READY,
    adaptiveScopeEnabled: false,
    adaptiveScopeConditionalCount: 4,
  };

  it('raises a warning row naming how many topics everybody is being asked', () => {
    const row = launchReadinessChecks(OFF_WITH_CONDITIONALS).find(
      (c) => c.key === 'adaptiveScopeOff'
    );
    expect(row?.ok).toBe(false);
    expect(row?.severity).toBe('warning');
    expect(row?.label).toContain('all 4 conditional topics are asked to everyone');
  });

  it('says "its 1 conditional topic is" for a single topic', () => {
    const row = launchReadinessChecks({
      ...OFF_WITH_CONDITIONALS,
      adaptiveScopeConditionalCount: 1,
    }).find((c) => c.key === 'adaptiveScopeOff');
    expect(row?.label).toContain('its 1 conditional topic is asked to everyone');
  });

  it('never blocks a launch', () => {
    // The whole point of the row: it reports a state the product used to keep silent about, and a
    // version whose author meant to ask everyone everything must still be launchable.
    const row = launchReadinessChecks(OFF_WITH_CONDITIONALS).find(
      (c) => c.key === 'adaptiveScopeOff'
    );
    expect(row).toBeDefined();
    expect(blocksLaunch(row!)).toBe(false);
    expect(isLaunchReady(OFF_WITH_CONDITIONALS)).toBe(true);
  });

  it('is silent when the feature is on — the coherence row covers that version instead', () => {
    const checks = launchReadinessChecks({
      ...OFF_WITH_CONDITIONALS,
      adaptiveScopeEnabled: true,
    });
    expect(checks.map((c) => c.key)).not.toContain('adaptiveScopeOff');
    expect(checks.map((c) => c.key)).toContain('adaptiveScope');
  });

  it('is silent when the version has no conditional topics', () => {
    // Every topic `core`/`opening`/`closing` means the plan is the whole instrument either way, so
    // the feature being off changes nothing and the row would be noise.
    const checks = launchReadinessChecks({ ...READY, adaptiveScopeConditionalCount: 0 });
    expect(checks.map((c) => c.key)).not.toContain('adaptiveScopeOff');
  });
});

describe('blocksLaunch', () => {
  it('is true only for a failed blocker', () => {
    const checks = launchReadinessChecks({
      ...READY,
      goal: null,
      adaptiveScopeConditionalCount: 2,
    });
    const failedBlocker = checks.find((c) => c.key === 'goal')!;
    const warning = checks.find((c) => c.key === 'adaptiveScopeOff')!;
    const passing = checks.find((c) => c.key === 'sections')!;

    expect(blocksLaunch(failedBlocker)).toBe(true);
    expect(blocksLaunch(warning)).toBe(false);
    expect(blocksLaunch(passing)).toBe(false);
  });

  it('marks every pre-existing check as a blocker', () => {
    // The severity is explicit on every check rather than defaulted, so a new one cannot become
    // non-blocking by omission. This pins that none of the old ones drifted.
    const checks = launchReadinessChecks({
      ...READY,
      likertCount: 1,
      dataSlotsRequired: true,
      embeddingsRequired: true,
      dataSlotEmbeddingsRequired: true,
      adaptiveScopeEnabled: true,
    });
    expect(checks.filter((c) => c.severity !== 'blocker')).toEqual([]);
  });
});

describe('launchReadinessChecks', () => {
  it('passes all five base checks for a ready version (no data-slots row when not required)', () => {
    const checks = launchReadinessChecks(READY);
    expect(checks.map((c) => c.key)).toEqual([
      'goal',
      'audience',
      'sections',
      'questions',
      'config',
    ]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('treats a blank/whitespace goal as not set', () => {
    expect(launchReadinessChecks({ ...READY, goal: '   ' }).find((c) => c.key === 'goal')?.ok).toBe(
      false
    );
    expect(launchReadinessChecks({ ...READY, goal: null }).find((c) => c.key === 'goal')?.ok).toBe(
      false
    );
  });

  it('requires ≥1 section and ≥1 question', () => {
    const noSections = launchReadinessChecks({ ...READY, sectionCount: 0 });
    expect(noSections.find((c) => c.key === 'sections')?.ok).toBe(false);
    const noQuestions = launchReadinessChecks({ ...READY, questionCount: 0 });
    expect(noQuestions.find((c) => c.key === 'questions')?.ok).toBe(false);
  });

  it('requires a saved config row', () => {
    expect(
      launchReadinessChecks({ ...READY, configSaved: false }).find((c) => c.key === 'config')?.ok
    ).toBe(false);
  });

  it('adds the data-slots check only when required, reflecting readiness', () => {
    expect(launchReadinessChecks(READY).some((c) => c.key === 'dataSlots')).toBe(false);

    const notReady = launchReadinessChecks({
      ...READY,
      dataSlotsRequired: true,
      dataSlotsReady: false,
    });
    expect(notReady.find((c) => c.key === 'dataSlots')?.ok).toBe(false);

    const ready = launchReadinessChecks({
      ...READY,
      dataSlotsRequired: true,
      dataSlotsReady: true,
    });
    expect(ready.find((c) => c.key === 'dataSlots')?.ok).toBe(true);
  });

  it('adds the scale-labels check only when the version has likert questions', () => {
    // No likert questions → no row (it would be a confusing always-green check).
    expect(launchReadinessChecks(READY).some((c) => c.key === 'scaleLabels')).toBe(false);

    // Has likert questions, all labelled → present and passing.
    const allLabelled = launchReadinessChecks({
      ...READY,
      likertCount: 3,
      unlabelledLikertCount: 0,
    });
    expect(allLabelled.find((c) => c.key === 'scaleLabels')?.ok).toBe(true);

    // One scale missing labels → present and failing (blocks launch).
    const someUnlabelled = launchReadinessChecks({
      ...READY,
      likertCount: 3,
      unlabelledLikertCount: 1,
    });
    expect(someUnlabelled.find((c) => c.key === 'scaleLabels')?.ok).toBe(false);
    expect(isLaunchReady({ ...READY, likertCount: 3, unlabelledLikertCount: 1 })).toBe(false);

    // unlabelledLikertCount omitted → defaults to 0 (treat as all labelled), so the check passes.
    expect(
      launchReadinessChecks({ ...READY, likertCount: 3 }).find((c) => c.key === 'scaleLabels')?.ok
    ).toBe(true);
  });

  it('adds the embeddings check only when required, reflecting readiness', () => {
    // Absent by default (a non-adaptive version never needs embeddings).
    expect(launchReadinessChecks(READY).some((c) => c.key === 'embeddings')).toBe(false);

    const notReady = launchReadinessChecks({
      ...READY,
      embeddingsRequired: true,
      embeddingsReady: false,
    });
    expect(notReady.find((c) => c.key === 'embeddings')?.ok).toBe(false);

    const ready = launchReadinessChecks({
      ...READY,
      embeddingsRequired: true,
      embeddingsReady: true,
    });
    expect(ready.find((c) => c.key === 'embeddings')?.ok).toBe(true);
  });

  it('adds the data-slot embeddings check only when required, reflecting readiness', () => {
    expect(launchReadinessChecks(READY).some((c) => c.key === 'dataSlotEmbeddings')).toBe(false);

    const notReady = launchReadinessChecks({
      ...READY,
      dataSlotEmbeddingsRequired: true,
      dataSlotEmbeddingsReady: false,
    });
    expect(notReady.find((c) => c.key === 'dataSlotEmbeddings')?.ok).toBe(false);

    const ready = launchReadinessChecks({
      ...READY,
      dataSlotEmbeddingsRequired: true,
      dataSlotEmbeddingsReady: true,
    });
    expect(ready.find((c) => c.key === 'dataSlotEmbeddings')?.ok).toBe(true);
  });

  it('orders the checks: config, embeddings, data slots, data-slot embeddings', () => {
    const checks = launchReadinessChecks({
      ...READY,
      embeddingsRequired: true,
      embeddingsReady: true,
      dataSlotsRequired: true,
      dataSlotsReady: true,
      dataSlotEmbeddingsRequired: true,
      dataSlotEmbeddingsReady: true,
    });
    expect(checks.map((c) => c.key)).toEqual([
      'goal',
      'audience',
      'sections',
      'questions',
      'config',
      'embeddings',
      'dataSlots',
      'dataSlotEmbeddings',
    ]);
  });
});

describe('isLaunchReady', () => {
  it('is true only when every applicable check passes', () => {
    expect(isLaunchReady(READY)).toBe(true);
    expect(isLaunchReady({ ...READY, audience: {} })).toBe(false);
    expect(isLaunchReady({ ...READY, dataSlotsRequired: true, dataSlotsReady: false })).toBe(false);
    expect(isLaunchReady({ ...READY, dataSlotsRequired: true, dataSlotsReady: true })).toBe(true);
    // Embeddings gate launch for an adaptive version, but only when required.
    expect(isLaunchReady({ ...READY, embeddingsRequired: true, embeddingsReady: false })).toBe(
      false
    );
    expect(isLaunchReady({ ...READY, embeddingsRequired: true, embeddingsReady: true })).toBe(true);
  });
});

describe('isPreviewAvailable', () => {
  it('requires live-sessions on and a resolved graph', () => {
    expect(
      isPreviewAvailable({ status: 'launched', liveSessions: false, graphPresent: true })
    ).toBe(false);
    expect(
      isPreviewAvailable({ status: 'launched', liveSessions: true, graphPresent: false })
    ).toBe(false);
  });

  it('always allows a launched version (no readiness needed)', () => {
    expect(isPreviewAvailable({ status: 'launched', liveSessions: true, graphPresent: true })).toBe(
      true
    );
  });

  it('allows a draft only when it passes the launch-readiness bar', () => {
    expect(
      isPreviewAvailable({
        status: 'draft',
        liveSessions: true,
        graphPresent: true,
        readiness: READY,
      })
    ).toBe(true);
    expect(
      isPreviewAvailable({
        status: 'draft',
        liveSessions: true,
        graphPresent: true,
        readiness: { ...READY, configSaved: false },
      })
    ).toBe(false);
    // A draft with no readiness supplied is never previewable.
    expect(isPreviewAvailable({ status: 'draft', liveSessions: true, graphPresent: true })).toBe(
      false
    );
  });

  it('never allows an archived version', () => {
    expect(
      isPreviewAvailable({
        status: 'archived',
        liveSessions: true,
        graphPresent: true,
        readiness: READY,
      })
    ).toBe(false);
  });
});
