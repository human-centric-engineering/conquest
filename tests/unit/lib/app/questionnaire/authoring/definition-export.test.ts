/**
 * definition-export — unit tests for the questionnaire DEFINITION import / export envelope.
 *
 * Pins what the helpers DO:
 *  - buildDefinitionExport stamps kind/version, carries the title, flattens tags → labels, reuses
 *    extractConfig (drops `saved`), and carries data slots + scoring
 *  - parseDefinitionImport round-trips an export, rejects junk / wrong kind / wrong schema version /
 *    malformed shape, and strips unknown config keys
 *  - cross-references survive: question.tagLabels, data-slot questionKeys, scoring refs
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
import type { VersionGraphView } from '@/lib/app/questionnaire/views';
import type { DataSlotView } from '@/lib/app/questionnaire/data-slots/views';
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
      SCORING,
      '2026-06-28T00:00:00.000Z'
    );
    expect(env.kind).toBe(DEFINITION_EXPORT_KIND);
    expect(env.schemaVersion).toBe(DEFINITION_EXPORT_SCHEMA_VERSION);
    expect(env.exportedAt).toBe('2026-06-28T00:00:00.000Z');
    expect(env.questionnaire.title).toBe('Staff Morale');
  });

  it('reuses extractConfig — full config, no `saved` flag', () => {
    const env = buildDefinitionExport('T', GRAPH, DATA_SLOTS, SCORING, 'now');
    expect(env.version.config).toEqual(DEFAULT_QUESTIONNAIRE_CONFIG);
    expect('saved' in env.version.config).toBe(false);
  });

  it('flattens tags to labels and carries structure / data slots / scoring', () => {
    const env = buildDefinitionExport('T', GRAPH, DATA_SLOTS, SCORING, 'now');
    expect(env.version.tags).toEqual([{ label: 'Wellbeing', color: 'green' }]);
    expect(env.version.sections[0].questions[0].tagLabels).toEqual(['Wellbeing']);
    expect(env.version.sections[0].questions[0].weight).toBe(0.7);
    expect(env.version.dataSlots[0].questionKeys).toEqual(['describe_morale']);
    expect(env.version.scoringSchema?.name).toBe('Morale score');
  });

  it('does not carry embedding vectors or captured respondent data', () => {
    const env = buildDefinitionExport('T', GRAPH, DATA_SLOTS, SCORING, 'now');
    const json = JSON.stringify(env);
    // Design-time only — no vectors, no captured answers/fills, no respondent identity.
    expect(json).not.toContain('embedding');
    expect(json).not.toContain('paraphrase');
    expect(json).not.toContain('respondentName');
    expect(json).not.toContain('provenanceLabel');
  });
});

describe('parseDefinitionImport', () => {
  const exported = () =>
    JSON.stringify(buildDefinitionExport('Staff Morale', GRAPH, DATA_SLOTS, SCORING, 'now'));

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
    const text = JSON.stringify(buildDefinitionExport('T', graph, DATA_SLOTS, SCORING, 'now'));
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

  it('defaults absent optional collections (tags / dataSlots)', () => {
    const env = {
      kind: DEFINITION_EXPORT_KIND,
      schemaVersion: DEFINITION_EXPORT_SCHEMA_VERSION,
      questionnaire: { title: 'Minimal' },
      version: { sections: [] },
    };
    const parsed = parseDefinitionImport(JSON.stringify(env));
    expect(parsed.version.tags).toEqual([]);
    expect(parsed.version.dataSlots).toEqual([]);
  });
});
