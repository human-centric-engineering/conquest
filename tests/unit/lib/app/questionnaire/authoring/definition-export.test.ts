/**
 * definition-export — unit tests for the questionnaire DEFINITION import / export envelope.
 *
 * Pins what the helpers DO:
 *  - buildDefinitionExport stamps kind/version, carries the title, flattens tags → labels, reuses
 *    extractConfig (drops `saved`), and carries data slots + Conditional Topics topics/settings + scoring
 *  - parseDefinitionImport round-trips an export, rejects junk / wrong kind / wrong schema version /
 *    malformed shape, and strips unknown config keys
 *  - cross-references survive: question.tagLabels, data-slot questionKeys, topic member keys,
 *    scoring refs
 *  - Conditional Topics (`topics` + `conditionalTopics`) travels as a top-level field, not inside `config`
 *
 * @see lib/app/questionnaire/authoring/definition-export.ts
 */

import { describe, it, expect } from 'vitest';

import {
  DEFINITION_EXPORT_KIND,
  DEFINITION_EXPORT_SCHEMA_VERSION,
  buildDefinitionExport,
  parseDefinitionImport,
} from '@/lib/app/questionnaire/authoring/definition-export';
import { CONFIG_EXPORT_KIND } from '@/lib/app/questionnaire/authoring/config-export';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import { DEFAULT_CONDITIONAL_TOPICS_SETTINGS } from '@/lib/app/questionnaire/scope/types';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots/views';
import type { Topic } from '@/lib/app/questionnaire/scope/types';
import type { ScoringSchemaContent } from '@/lib/app/questionnaire/scoring/types';

const GRAPH: VersionGraphView = {
  id: 'v1',
  questionnaireId: 'q1',
  versionNumber: 2,
  status: 'draft',
  goal: 'Understand morale',
  audience: { role: 'employee', description: 'Staff members' },
  goalProvenance: 'admin-supplied',
  audienceProvenance: null,
  tags: [{ id: 't1', label: 'Wellbeing', color: 'green' }],
  sections: [
    {
      id: 's1',
      ordinal: 0,
      title: 'Morale',
      description: 'How you feel',
      questions: [
        {
          id: 'qa',
          ordinal: 0,
          key: 'describe_morale',
          prompt: 'Describe your morale',
          guidelines: 'Be honest',
          rationale: null,
          type: 'likert',
          typeConfig: { min: 1, max: 5, labels: ['VL', 'L', 'M', 'H', 'VH'] },
          required: true,
          weight: 0.7,
          fidelity: 1,
          extractionConfidence: null,
          tags: [{ id: 't1', label: 'Wellbeing', color: 'green' }],
        },
      ],
    },
  ],
  config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: true },
};

const DATA_SLOTS: DataSlotView[] = [
  {
    id: 'd1',
    key: 'morale_overall',
    name: 'Overall morale',
    description: 'How the respondent feels overall',
    theme: 'wellbeing',
    ordinal: 0,
    weight: 1,
    questionKeys: ['describe_morale'],
  },
];

const TOPICS: Topic[] = [
  {
    id: 'top1',
    key: 'morale_deep_dive',
    label: 'Morale deep dive',
    description: 'Asked when the opening suggests low morale',
    phase: 'conditional',
    criteria: 'Respondent describes morale as poor or declining',
    depth: 'full',
    members: { dataSlotKeys: ['morale_overall'], questionKeys: ['describe_morale'] },
    ordinal: 0,
    source: 'manual',
    trigger: null,
  },
];

const SCORING: { name: string; content: ScoringSchemaContent } = {
  name: 'Morale score',
  content: {
    scales: [{ key: 'm', name: 'Morale' }],
    items: [
      { source: 'question', ref: 'describe_morale', scaleKey: 'm', weight: 1, reverse: false },
    ],
    bands: [],
    method: 'mean',
  },
};

describe('buildDefinitionExport', () => {
  it('stamps the discriminator + schema version and carries the title', () => {
    const env = buildDefinitionExport(
      'Staff Morale',
      GRAPH,
      DATA_SLOTS,
      TOPICS,
      SCORING,
      '2026-06-28T00:00:00.000Z'
    );
    expect(env.kind).toBe(DEFINITION_EXPORT_KIND);
    expect(env.schemaVersion).toBe(DEFINITION_EXPORT_SCHEMA_VERSION);
    expect(env.exportedAt).toBe('2026-06-28T00:00:00.000Z');
    expect(env.questionnaire.title).toBe('Staff Morale');
  });

  it('reuses extractConfig — full config, no `saved` flag', () => {
    const env = buildDefinitionExport('T', GRAPH, DATA_SLOTS, TOPICS, SCORING, 'now');
    expect(env.version.config).toEqual(DEFAULT_QUESTIONNAIRE_CONFIG);
    expect('saved' in env.version.config).toBe(false);
  });

  it('flattens tags to labels and carries structure / data slots / scoring', () => {
    const env = buildDefinitionExport('T', GRAPH, DATA_SLOTS, TOPICS, SCORING, 'now');
    expect(env.version.tags).toEqual([{ label: 'Wellbeing', color: 'green' }]);
    expect(env.version.sections[0].questions[0].tagLabels).toEqual(['Wellbeing']);
    expect(env.version.sections[0].questions[0].weight).toBe(0.7);
    expect(env.version.dataSlots[0].questionKeys).toEqual(['describe_morale']);
    expect(env.version.scoringSchema?.name).toBe('Morale score');
  });

  it('carries Conditional Topics topics (by key) and settings as a sibling of `config`', () => {
    const env = buildDefinitionExport('T', GRAPH, DATA_SLOTS, TOPICS, SCORING, 'now');
    expect(env.version.topics).toEqual([
      {
        key: 'morale_deep_dive',
        label: 'Morale deep dive',
        description: 'Asked when the opening suggests low morale',
        phase: 'conditional',
        criteria: 'Respondent describes morale as poor or declining',
        depth: 'full',
        ordinal: 0,
        source: 'manual',
        questionKeys: ['describe_morale'],
        dataSlotKeys: ['morale_overall'],
        trigger: null,
      },
    ]);
    expect(env.version.conditionalTopics).toEqual(DEFAULT_CONDITIONAL_TOPICS_SETTINGS);
  });

  it('does not carry embedding vectors or captured respondent data', () => {
    const env = buildDefinitionExport('T', GRAPH, DATA_SLOTS, TOPICS, SCORING, 'now');
    const json = JSON.stringify(env);
    // Design-time only — no vectors, no captured answers/fills, no respondent identity.
    expect(json).not.toContain('embedding');
    expect(json).not.toContain('paraphrase');
    expect(json).not.toContain('respondentName');
    expect(json).not.toContain('provenanceLabel');
  });
});

describe('question fidelity round-trip', () => {
  const exportGraph = () =>
    buildDefinitionExport(
      'Staff Morale',
      GRAPH,
      DATA_SLOTS,
      TOPICS,
      SCORING,
      '2026-06-28T00:00:00.000Z'
    );

  it("carries each question's fidelity through export and back", () => {
    // Fidelity is per-question admin work, and a missed line in any one of the export projection,
    // the Zod schema, or the persister loses it SILENTLY on every fork / export / re-import.
    // `must_ask` — deliberately NOT the 0.5 default, so a hardcoded midpoint fails this.
    const expected = 1;
    expect(GRAPH.sections[0].questions[0].fidelity).toBe(expected);
    const env = exportGraph();
    expect(env.version.sections[0].questions[0].fidelity).toBe(expected);

    const parsed = parseDefinitionImport(JSON.stringify(env));
    expect(parsed.version.sections[0].questions[0].fidelity).toBe(expected);
  });

  it('defaults fidelity to the neutral midpoint for an envelope exported before the feature', () => {
    // Real files predate this field. They must import as `balanced` — behaving exactly as they did
    // when they were exported — rather than failing validation.
    const raw = JSON.parse(JSON.stringify(exportGraph()));
    for (const section of raw.version.sections) {
      for (const question of section.questions) delete question.fidelity;
    }

    const parsed = parseDefinitionImport(JSON.stringify(raw));
    for (const section of parsed.version.sections) {
      for (const question of section.questions) expect(question.fidelity).toBe(0.5);
    }
  });
});

describe('parseDefinitionImport', () => {
  const exported = () =>
    JSON.stringify(
      buildDefinitionExport('Staff Morale', GRAPH, DATA_SLOTS, TOPICS, SCORING, 'now')
    );

  it('round-trips a built export', () => {
    const parsed = parseDefinitionImport(exported());
    expect(parsed.questionnaire.title).toBe('Staff Morale');
    expect(parsed.version.sections[0].questions[0].key).toBe('describe_morale');
    expect(parsed.version.sections[0].questions[0].tagLabels).toEqual(['Wellbeing']);
    expect(parsed.version.dataSlots).toHaveLength(1);
    expect(parsed.version.dataSlots[0].questionKeys).toEqual(['describe_morale']);
    expect(parsed.version.scoringSchema?.content.items[0].ref).toBe('describe_morale');
    expect(parsed.version.config?.selectionStrategy).toBe(
      DEFAULT_QUESTIONNAIRE_CONFIG.selectionStrategy
    );
  });

  it('round-trips Conditional Topics topics + settings — the bug this test pins', () => {
    // Regression: `topics` used to be entirely absent from the envelope, and `conditionalTopics` was
    // silently stripped on import because it rode inside `config` (validated by `updateConfigSchema`,
    // which has no such field). Both must survive export → parse unchanged.
    const graph: VersionGraphView = {
      ...GRAPH,
      config: {
        ...GRAPH.config,
        conditionalTopics: {
          ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
          enabled: true,
          maxConditionalTopics: 2,
          plannerInstructions: 'Prefer depth over breadth.',
        },
      },
    };
    const text = JSON.stringify(
      buildDefinitionExport('Staff Morale', graph, DATA_SLOTS, TOPICS, SCORING, 'now')
    );
    const parsed = parseDefinitionImport(text);
    expect(parsed.version.topics).toEqual([
      expect.objectContaining({
        key: 'morale_deep_dive',
        phase: 'conditional',
        questionKeys: ['describe_morale'],
        dataSlotKeys: ['morale_overall'],
        ordinal: 0,
        source: 'manual',
      }),
    ]);
    expect(parsed.version.conditionalTopics?.enabled).toBe(true);
    expect(parsed.version.conditionalTopics?.maxConditionalTopics).toBe(2);
    expect(parsed.version.conditionalTopics?.plannerInstructions).toBe(
      'Prefer depth over breadth.'
    );
  });

  it('imports a file exported under the old feature name', () => {
    // Files exported while the feature was called "Adaptive Scope" carry `adaptiveScope`. Dropping
    // it would import a version with its routing design silently unconfigured — every topic
    // conditional on paper and the switch off — which is exactly the state F17.22 Phase 4 exists to
    // warn about. The legacy key is folded into the current one and does not survive parsing.
    const env = JSON.parse(exported()) as Record<string, unknown> & {
      version: Record<string, unknown>;
    };
    delete env.version.conditionalTopics;
    env.version.adaptiveScope = {
      ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
      enabled: true,
      maxConditionalTopics: 4,
    };

    const parsed = parseDefinitionImport(JSON.stringify(env));

    expect(parsed.version.conditionalTopics?.enabled).toBe(true);
    expect(parsed.version.conditionalTopics?.maxConditionalTopics).toBe(4);
    expect(parsed.version).not.toHaveProperty('adaptiveScope');
  });

  it('prefers the current key when a hand-edited file carries both names', () => {
    const env = JSON.parse(exported()) as Record<string, unknown> & {
      version: Record<string, unknown>;
    };
    env.version.conditionalTopics = { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: true };
    env.version.adaptiveScope = { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: false };

    const parsed = parseDefinitionImport(JSON.stringify(env));

    // The name this build writes is the one the author most recently meant.
    expect(parsed.version.conditionalTopics?.enabled).toBe(true);
  });

  it('rejects two topics sharing a key', () => {
    const env = JSON.parse(exported());
    env.version.topics.push({ ...env.version.topics[0] });
    expect(() => parseDefinitionImport(JSON.stringify(env))).toThrow(/share a key/i);
  });

  it('round-trips the built-in-persona config, allowRespondentSwitch included', () => {
    // The interviewer voice (personaSelection, incl. the switching opt-in) is part of the instrument
    // and must survive definition export → import through the config validator unchanged.
    const personaSelection = {
      enabled: true,
      defaultPersonaKey: 'philosopher',
      allowRespondentSwitch: true,
      switcher: 'both' as const,
    };
    const graph: VersionGraphView = {
      ...GRAPH,
      config: { ...GRAPH.config, personaSelection },
    };
    const text = JSON.stringify(
      buildDefinitionExport('T', graph, DATA_SLOTS, TOPICS, SCORING, 'now')
    );
    const parsed = parseDefinitionImport(text);
    expect(parsed.version.config?.personaSelection).toEqual(personaSelection);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseDefinitionImport('{not json')).toThrow(/not valid JSON/i);
  });

  it('rejects a non-object', () => {
    expect(() => parseDefinitionImport('[]')).toThrow(/doesn't look like/i);
  });

  it('rejects a settings export (wrong kind)', () => {
    const settings = JSON.stringify({ kind: CONFIG_EXPORT_KIND, schemaVersion: 1, config: {} });
    expect(() => parseDefinitionImport(settings)).toThrow(/isn't a questionnaire definition/i);
  });

  it('rejects an unsupported schema version', () => {
    const env = JSON.parse(exported());
    env.schemaVersion = 99;
    expect(() => parseDefinitionImport(JSON.stringify(env))).toThrow(/can't import/i);
  });

  it('rejects a malformed shape (missing question prompt)', () => {
    const env = JSON.parse(exported());
    delete env.version.sections[0].questions[0].prompt;
    expect(() => parseDefinitionImport(JSON.stringify(env))).toThrow(/malformed/i);
  });

  it('strips unknown config keys', () => {
    const env = JSON.parse(exported());
    env.version.config.bogusKey = 'nope';
    const parsed = parseDefinitionImport(JSON.stringify(env));
    expect('bogusKey' in (parsed.version.config ?? {})).toBe(false);
  });

  it('defaults absent optional collections (tags / dataSlots / topics / conditionalTopics)', () => {
    const env = {
      kind: DEFINITION_EXPORT_KIND,
      schemaVersion: DEFINITION_EXPORT_SCHEMA_VERSION,
      questionnaire: { title: 'Minimal' },
      version: { sections: [] },
    };
    const parsed = parseDefinitionImport(JSON.stringify(env));
    expect(parsed.version.tags).toEqual([]);
    expect(parsed.version.dataSlots).toEqual([]);
    expect(parsed.version.topics).toEqual([]);
    expect(parsed.version.conditionalTopics).toBeUndefined();
  });
});

// ── Mid-interview triggers (F17.31a) ─────────────────────────────────────────

describe('a recorded trigger travels with the definition', () => {
  const trigger = {
    condition: 'The applicant discloses that they are fleeing abuse',
    cues: ['abuse', 'fleeing'],
    sourceQuote: 'If the applicant discloses, at any stage, that they are fleeing abuse',
  };

  it('exports it, and imports it back unchanged', () => {
    // An export is how a questionnaire moves between environments. A trigger dropped here would
    // leave the imported copy silently missing the record of what the document asked for.
    const topics = [{ ...TOPICS[0], trigger }];
    const text = JSON.stringify(
      buildDefinitionExport('T', GRAPH, DATA_SLOTS, topics, SCORING, 'now')
    );

    const parsed = parseDefinitionImport(text);

    expect(parsed.version.topics[0]?.trigger).toEqual(trigger);
  });

  it('imports a file written before the field existed', () => {
    // Backward compatibility, not a schemaVersion bump: an older export has no `trigger` key at
    // all, and must still import rather than being rejected as a foreign file.
    const env = buildDefinitionExport('T', GRAPH, DATA_SLOTS, TOPICS, SCORING, 'now');
    const asJson: { version: { topics: Record<string, unknown>[] } } = JSON.parse(
      JSON.stringify(env)
    );
    delete asJson.version.topics[0].trigger;

    const parsed = parseDefinitionImport(JSON.stringify(asJson));

    expect(parsed.version.topics[0]?.trigger).toBeNull();
  });
});
