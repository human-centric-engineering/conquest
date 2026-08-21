/**
 * settings-registry — unit tests for the questionnaire settings registry.
 *
 * The load-bearing test here is exhaustiveness: EVERY field of `QuestionnaireConfigShape` has a
 * descriptor, so a setting added tomorrow appears in the Questionnaire Pack without anyone editing
 * a curated list. `satisfies Record<keyof QuestionnaireConfigShape, …>` already makes that a compile
 * error — this is the belt-and-braces runtime check, and the one that reports WHICH key is missing.
 *
 * Also pins: group/tier validity, the default config producing rows for every group, tier filtering
 * being purely additive, and the formatting helpers behaving on the edge values (`null` budgets,
 * `0`-means-off thresholds, over-long admin free text).
 *
 * @see lib/app/questionnaire/settings-registry.ts
 */

import { describe, it, expect } from 'vitest';

import {
  SETTING_DESCRIPTORS,
  SETTING_GROUPS,
  SETTING_KEYS,
  buildSettingRows,
  type SettingDescriptor,
} from '@/lib/app/questionnaire/settings-registry';
import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  type QuestionnaireConfigShape,
} from '@/lib/app/questionnaire/types';
import type { ConfigView } from '@/lib/app/questionnaire/views';
import { DEFAULT_ADAPTIVE_SCOPE_SETTINGS } from '@/lib/app/questionnaire/scope/types';

function configOf(overrides: Partial<QuestionnaireConfigShape> = {}): ConfigView {
  return { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...overrides, saved: true };
}

/** Every row the registry emits for a config, at the given tier. */
function rowsOf(config: ConfigView, includeTechnical = false) {
  const rows = buildSettingRows(config, includeTechnical);
  return { rows, byLabel: new Map(rows.map((row) => [row.label, row.value])) };
}

/**
 * Distinctive prompt bodies planted in every free-text setting {@link FULLY_ENABLED} switches on.
 * A descriptor that renders one verbatim instead of "Set" puts admin instructions into the branded,
 * externally-shareable pack — so these double as the leak canary.
 */
const SECRETS = {
  reportInstructions: 'CANARY-report-instructions-never-mention-pricing',
  reportStructure: 'CANARY-report-structure',
  reportBackground: 'CANARY-report-background',
  researchBefore: 'CANARY-research-before',
  researchAfter: 'CANARY-research-after',
  cohortInstructions: 'CANARY-cohort-instructions',
  cohortStructure: 'CANARY-cohort-structure',
  cohortBackground: 'CANARY-cohort-background',
} as const;

/**
 * A config with every optional block switched ON — the arm the default config never reaches.
 *
 * Deliberately built by spreading each block's own default rather than by hand, so a field added to
 * one of these shapes tomorrow arrives here already populated and this fixture cannot rot into a
 * partial object that type-checks but under-exercises the descriptor.
 */
const FULLY_ENABLED: ConfigView = configOf({
  anonymousMode: false,
  profileFields: [
    { key: 'role', label: 'Your role', type: 'text', required: true, validation: 'deterministic' },
    { key: 'team', label: 'Team', type: 'text', required: false, validation: 'deterministic' },
  ],
  contradictionMode: 'probe',
  contradictionWindowN: 3,
  contradictionEveryNTurns: 1,
  sensitivityAwareness: true,
  supportMessage: 'Talk to someone if this raised anything difficult.',
  supportResourceUrl: 'https://example.test/support',
  allowEarlyFinish: true,
  earlyFinishMinCoverage: 0,
  reasoningStreamEnabled: true,
  intro: {
    ...DEFAULT_QUESTIONNAIRE_CONFIG.intro,
    enabled: true,
    background: 'About this questionnaire.',
    buttonLabel: 'Begin',
    videoUrl: 'https://example.test/video',
  },
  personaSelection: {
    ...DEFAULT_QUESTIONNAIRE_CONFIG.personaSelection,
    enabled: true,
    allowRespondentSwitch: true,
  },
  interviewerStrategy: { ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy, enabled: true },
  // One of each kind, so the descriptor's counting branch runs rather than its "None" branch.
  houseRules: {
    enabled: true,
    rules: [
      { id: 'a', kind: 'always', enabled: true, text: 'Ask for a concrete example.' },
      { id: 'b', kind: 'always', enabled: true, text: 'Acknowledge what they shared.' },
      { id: 'c', kind: 'never', enabled: true, text: 'Give advice.' },
      {
        id: 'd',
        kind: 'if_asked',
        enabled: true,
        text: 'Only the research team.',
        trigger: 'who sees this',
      },
      // Individually off — must not be counted.
      { id: 'e', kind: 'never', enabled: false, text: 'Promise an outcome.' },
    ],
  },
  respondentReport: {
    ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport,
    enabled: true,
    mode: 'narrative',
    generation: {
      ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport.generation,
      instructions: SECRETS.reportInstructions,
      structure: SECRETS.reportStructure,
      backgroundContext: SECRETS.reportBackground,
    },
    research: {
      ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport.research,
      enabled: true,
      timing: 'after',
      rounds: 2,
      before: { instructions: SECRETS.researchBefore },
      after: { instructions: SECRETS.researchAfter },
      appendix: true,
    },
  },
  cohortReport: {
    ...DEFAULT_QUESTIONNAIRE_CONFIG.cohortReport,
    enabled: true,
    generation: {
      ...DEFAULT_QUESTIONNAIRE_CONFIG.cohortReport.generation,
      instructions: SECRETS.cohortInstructions,
      structure: SECRETS.cohortStructure,
      backgroundContext: SECRETS.cohortBackground,
      scoringEnabled: true,
      useClientKnowledge: true,
    },
  },
});

/**
 * The mirror image of {@link FULLY_ENABLED}: every gate explicitly OFF.
 *
 * Needed because the default config is not "everything off" — `reasoningStream*`,
 * `personaSelection`, `interviewerStrategy`, `allowEarlyFinish` and `milestoneBanner*` all ship ON,
 * so their disabled arm is unreachable from either of the other two fixtures. Together the three
 * configs take both sides of every gate in the registry.
 */
const FULLY_OFF: ConfigView = configOf({
  anonymousMode: true,
  contradictionMode: 'off',
  sensitivityAwareness: false,
  allowEarlyFinish: false,
  reasoningStreamEnabled: false,
  milestoneBannerEnabled: false,
  glossaryPromptInjection: false,
  glossaryRespondentHints: false,
  intro: { ...DEFAULT_QUESTIONNAIRE_CONFIG.intro, enabled: true, buttonLabel: '' },
  personaSelection: { ...DEFAULT_QUESTIONNAIRE_CONFIG.personaSelection, enabled: false },
  interviewerStrategy: { ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy, enabled: false },
  respondentReport: { ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport, enabled: false },
  cohortReport: { ...DEFAULT_QUESTIONNAIRE_CONFIG.cohortReport, enabled: false },
});

describe('settings registry — exhaustiveness', () => {
  it('has a descriptor for every config field', () => {
    const configKeys = Object.keys(DEFAULT_QUESTIONNAIRE_CONFIG).sort();
    const registered: string[] = [...SETTING_KEYS].sort();
    // Reported as a set difference so a failure names the forgotten key, not just "not equal".
    expect(configKeys.filter((key) => !registered.includes(key))).toEqual([]);
    expect(registered.filter((key) => !configKeys.includes(key))).toEqual([]);
  });

  it('gives every descriptor a known group and tier', () => {
    for (const key of SETTING_KEYS) {
      // Annotated so the `satisfies`-narrowed literal type widens back to the declared shape.
      const descriptor: SettingDescriptor = SETTING_DESCRIPTORS[key];
      expect(SETTING_GROUPS, `${key} group`).toContain(descriptor.group);
      expect(['standard', 'technical'], `${key} tier`).toContain(descriptor.tier);
    }
  });

  it('emits well-formed rows for every field on the default config', () => {
    for (const key of SETTING_KEYS) {
      const descriptor: SettingDescriptor = SETTING_DESCRIPTORS[key];
      for (const row of descriptor.rows(configOf())) {
        expect(row.label, `${key} label`).toBeTruthy();
        expect(row.value, `${key} value`).toBeTruthy();
        if (row.tier) expect(['standard', 'technical'], `${key} row tier`).toContain(row.tier);
      }
    }
  });

  it('never emits the same label twice for one config', () => {
    const { rows } = rowsOf(configOf(), true);
    const labels = rows.map((row) => row.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('emits well-formed rows for every field on a FULLY ENABLED config too', () => {
    // The sibling test above runs the default config, where roughly a dozen descriptors are gated
    // off (`cohortReport`, the report's web-research block, `intro`, `interviewerStrategy`, the
    // contradiction pair, …) and return no rows at all. Exercising only that arm means the branch
    // that actually renders content in the branded pack is never run — a descriptor that throws or
    // emits an empty label would ship straight into a client-facing PDF. Pairing the two arms is
    // what makes the registry's "a new setting shows up automatically" guarantee real rather than
    // nominal: it has to show up CORRECTLY, not merely be classified.
    for (const key of SETTING_KEYS) {
      const descriptor: SettingDescriptor = SETTING_DESCRIPTORS[key];
      for (const row of descriptor.rows(FULLY_ENABLED)) {
        expect(row.label, `${key} label`).toBeTruthy();
        expect(row.value, `${key} value`).toBeTruthy();
        if (row.tier) expect(['standard', 'technical'], `${key} row tier`).toContain(row.tier);
      }
    }
  });

  it('emits well-formed rows for every field with every gate OFF', () => {
    // The third arm. A descriptor's disabled branch usually returns `[]`, but several return a
    // summary row instead ("Off", "Default", "Custom tone") — and those still have to be legible in
    // the pack, which is exactly what an empty-string value would quietly break.
    for (const key of SETTING_KEYS) {
      const descriptor: SettingDescriptor = SETTING_DESCRIPTORS[key];
      for (const row of descriptor.rows(FULLY_OFF)) {
        expect(row.label, `${key} label`).toBeTruthy();
        expect(row.value, `${key} value`).toBeTruthy();
        if (row.tier) expect(['standard', 'technical'], `${key} row tier`).toContain(row.tier);
      }
    }
  });

  it('anonymous mode drops the respondent-details rows rather than listing empty fields', () => {
    // The one gate with a privacy consequence: an anonymous version collects no profile fields, so
    // the pack must not advertise a "Respondent details collected" row for it.
    expect(rowsOf(FULLY_ENABLED, true).byLabel.has('Respondent details collected')).toBe(true);
    expect(rowsOf(FULLY_OFF, true).byLabel.has('Respondent details collected')).toBe(false);
  });

  it('renders strictly more rows once the optional blocks are switched on', () => {
    // The point of the enabled arm: it ADDS rows. If a block were silently dropped from the
    // registry, this count would stop moving while the exhaustiveness test above stayed green.
    const off = rowsOf(configOf(), true).rows.length;
    const on = rowsOf(FULLY_ENABLED, true).rows.length;
    expect(on).toBeGreaterThan(off);
  });

  it('never leaks an admin prompt body, even with every optional block enabled', () => {
    // The pack is the external artifact. Every prompt-shaped setting must degrade to "Set", and the
    // enabled arm is precisely where those fields become reachable — so this is the arm that
    // matters. The default-config run can't catch a leak in a block it never renders.
    const { rows } = rowsOf(FULLY_ENABLED, true);
    const rendered = rows.map((row) => row.value).join(' | ');
    for (const secret of Object.values(SECRETS)) expect(rendered).not.toContain(secret);
  });
});

describe('buildSettingRows', () => {
  it('orders rows by SETTING_GROUPS, with each group contiguous', () => {
    const { rows } = rowsOf(configOf(), true);
    const order = rows.map((row) => SETTING_GROUPS.indexOf(row.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('is purely additive: the technical tier adds rows and changes none', () => {
    const standard = rowsOf(configOf());
    const technical = rowsOf(configOf(), true);

    expect(technical.rows.length).toBeGreaterThan(standard.rows.length);
    for (const [label, value] of standard.byLabel) {
      expect(technical.byLabel.get(label)).toBe(value);
    }
  });

  it('keeps a per-row technical override out of the standard tier', () => {
    const config = configOf({
      respondentReport: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport,
        enabled: true,
        mode: 'narrative',
      },
    });
    // `respondentReport` is a standard descriptor, but its prompt/tuning rows are marked technical.
    expect(rowsOf(config).byLabel.has('Report style')).toBe(true);
    expect(rowsOf(config).byLabel.has('Report instructions')).toBe(false);
    expect(rowsOf(config, true).byLabel.get('Report instructions')).toBe('Not set');
  });
});

describe('value formatting', () => {
  it('renders an absent numeric limit as "No limit", not "null"', () => {
    const { byLabel } = rowsOf(
      configOf({ costBudgetUsd: null, maxQuestionsPerSession: null }),
      true
    );
    expect(byLabel.get('Cost budget per session')).toBe('No limit');
    expect(byLabel.get('Maximum questions per session')).toBe('No limit');
  });

  it('formats a set cost budget as currency and fractions as percentages', () => {
    const { byLabel } = rowsOf(
      configOf({ costBudgetUsd: 2.5, coverageThreshold: 0.75, answerConfidenceFloor: 0.5 }),
      true
    );
    expect(byLabel.get('Cost budget per session')).toBe('$2.50');
    expect(byLabel.get('Completion coverage target')).toBe('75%');
    expect(byLabel.get('Answer confirmation floor')).toBe('50%');
  });

  it('says "Off" rather than "0 strikes" when the abuse gate is disabled', () => {
    expect(
      rowsOf(configOf({ abuseThreshold: 0 }), true).byLabel.get('Non-genuine answer tolerance')
    ).toBe('Off');
    expect(
      rowsOf(configOf({ abuseThreshold: 3 }), true).byLabel.get('Non-genuine answer tolerance')
    ).toBe('3 strikes');
  });

  it('clips and flattens long admin free text so a row stays a table cell', () => {
    const config = configOf({
      sensitivityAwareness: true,
      supportMessage: `${'word '.repeat(80)}\n\nsecond paragraph`,
    });
    const value = rowsOf(config).byLabel.get('Support message') ?? '';
    expect(value.length).toBeLessThanOrEqual(160);
    expect(value).not.toContain('\n');
    expect(value.endsWith('…')).toBe(true);
  });

  it('reports prompt-shaped settings as Set / Not set rather than dumping the prompt', () => {
    const instructions = 'Write in the voice of a friendly consultant, and never mention pricing.';
    const config = configOf({
      respondentReport: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport,
        enabled: true,
        generation: { ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport.generation, instructions },
      },
    });
    const { byLabel } = rowsOf(config, true);
    expect(byLabel.get('Report instructions')).toBe('Set');
    expect([...byLabel.values()].join(' ')).not.toContain('never mention pricing');
  });

  it('states the opening follow-up allowance only in terms an operator can act on (G03)', () => {
    // The switch and the number only mean anything together: a bare "1" beside a switch nobody set
    // reads as a limit that is in force, and an operator reading this pack is trying to work out
    // which limit actually stopped an interview.
    const scoped = (over: Record<string, unknown>) =>
      configOf({
        adaptiveScope: { ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS, enabled: true, ...over },
      });

    expect(rowsOf(scoped({})).byLabel.get('Opening follow-ups')).toBe('Not limited');
    expect(
      rowsOf(scoped({ limitOpeningProbes: true, maxOpeningProbes: 1 })).byLabel.get(
        'Opening follow-ups'
      )
    ).toBe('Up to 1 across the opening');
    // Zero is a setting someone means, and it must not read as "not limited".
    expect(
      rowsOf(scoped({ limitOpeningProbes: true, maxOpeningProbes: 0 })).byLabel.get(
        'Opening follow-ups'
      )
    ).toBe('None — never probe');
  });

  it('lists the shown invitee fields, marking the required ones', () => {
    const { byLabel } = rowsOf(configOf({ accessMode: 'invitation_only' }));
    expect(byLabel.get('Invitee details collected')).toBe('First name, Surname, Email (required)');
  });

  it('renders enabled tone dials on the admin-facing signed scale', () => {
    const config = configOf({
      personaSelection: { ...DEFAULT_QUESTIONNAIRE_CONFIG.personaSelection, enabled: false },
      tone: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG.tone,
        empathy: { enabled: true, level: 5 },
        formality: { enabled: true, level: 1 },
      },
    });
    expect(rowsOf(config).byLabel.get('Interviewer tone')).toBe('Empathy +2, Formality -2');
  });

  it("reports question fidelity as off by default, in the admin's language", () => {
    // The pack is read by someone deciding how the interview will behave, so "Off" alone would
    // leave them guessing what the default actually is.
    expect(rowsOf(configOf()).byLabel.get('Question fidelity')).toBe(
      'Off — every question asked openly'
    );
  });

  it('names the starting level once question fidelity is on', () => {
    const config = configOf({ questionFidelity: { enabled: true, defaultFidelity: 0.75 } });
    expect(rowsOf(config).byLabel.get('Question fidelity')).toBe('On · new questions start Close');
  });

  describe('interviewer strategy', () => {
    const strategy = (over: Partial<QuestionnaireConfigShape['interviewerStrategy']>) =>
      rowsOf(
        configOf({
          interviewerStrategy: {
            ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy,
            enabled: true,
            ...over,
          },
        })
      ).byLabel;

    it('names the funnel pace alongside the approach', () => {
      const rows = strategy({ approach: 'funnel', pace: 'brisk' });
      expect(rows.get('Questioning approach')).toBe('Funnel (open → targeted)');
      expect(rows.get('Funnel pace')).toBe('Narrow quickly');
    });

    /**
     * `paceProfile()` ignores a stored pace outside the funnel, so printing one here would describe
     * an arc that isn't running — the pack would be documenting a setting with no effect.
     */
    it('omits the pace row for approaches that have no arc', () => {
      expect(strategy({ approach: 'open', pace: 'brisk' }).has('Funnel pace')).toBe(false);
      expect(strategy({ approach: 'targeted', pace: 'brisk' }).has('Funnel pace')).toBe(false);
    });

    it('counts the opening examples rather than reprinting them', () => {
      const rows = strategy({
        openingMode: 'examples',
        openingExamples: ['Tell me about your week.', 'What stands out?'],
      });
      expect(rows.get('Opening questions')).toBe('Guided by 2 examples');
      expect(
        strategy({ openingMode: 'examples', openingExamples: ['One.'] }).get('Opening questions')
      ).toBe('Guided by 1 example');
    });

    /** Mirrors `usesGuidedOpening()`: an unusable list is not guiding anything. */
    it("reports the interviewer's own framings when no example is usable", () => {
      expect(strategy({ openingMode: 'auto' }).get('Opening questions')).toBe(
        "Interviewer's own framings"
      );
      expect(
        strategy({ openingMode: 'examples', openingExamples: ['  '] }).get('Opening questions')
      ).toBe("Interviewer's own framings");
    });

    it('omits the opening row for the targeted approach, which has no open opening', () => {
      expect(strategy({ approach: 'targeted' }).has('Opening questions')).toBe(false);
    });

    it('collapses to a single Default row when the whole block is off', () => {
      const rows = rowsOf(
        configOf({
          interviewerStrategy: {
            ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy,
            enabled: false,
            pace: 'brisk',
            openingMode: 'examples',
            openingExamples: ['Tell me about your week.'],
          },
        })
      ).byLabel;
      expect(rows.get('Questioning approach')).toBe('Default');
      expect(rows.has('Funnel pace')).toBe(false);
      expect(rows.has('Opening questions')).toBe(false);
    });
  });

  it('summarises house rules by kind, counting only the ones actually in use', () => {
    // The pack summarises setup, so it counts rather than reprinting up to twenty rules verbatim.
    expect(rowsOf(FULLY_ENABLED).byLabel.get('House rules')).toBe(
      '2 × always, 1 × never, 1 × if asked'
    );
  });

  it('says "None" when house rules are configured but switched off', () => {
    const config = configOf({
      houseRules: {
        enabled: false,
        rules: [{ id: 'a', kind: 'never', enabled: true, text: 'Give advice.' }],
      },
    });
    expect(rowsOf(config).byLabel.get('House rules')).toBe('None');
  });
});
