/**
 * config-export — unit tests for the Settings tab import / export envelope helpers.
 *
 * Pins what the helpers DO:
 *  - CONFIG_KEYS mirrors the config shape exactly (no drift from DEFAULT_QUESTIONNAIRE_CONFIG)
 *  - extractConfig picks every config key and drops the read-only `saved` flag
 *  - buildSettingsExport stamps the kind/version + carries the extracted config
 *  - parseSettingsImport: round-trips an export, accepts a bare config, rejects junk,
 *    strips unknown + metadata keys, and reports counts
 *
 * @see lib/app/questionnaire/authoring/config-export.ts
 */

import { describe, it, expect } from 'vitest';

import {
  CONFIG_EXPORT_KIND,
  CONFIG_EXPORT_SCHEMA_VERSION,
  CONFIG_KEYS,
  extractConfig,
  buildSettingsExport,
  parseSettingsImport,
} from '@/lib/app/questionnaire/authoring/config-export';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type { ConfigView } from '@/lib/app/questionnaire/views';

const SAVED_VIEW: ConfigView = { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: true };

describe('CONFIG_KEYS', () => {
  it('mirrors the config shape exactly (no drift)', () => {
    expect([...CONFIG_KEYS].sort()).toEqual(Object.keys(DEFAULT_QUESTIONNAIRE_CONFIG).sort());
  });

  it('does not include the read-only `saved` flag', () => {
    expect(CONFIG_KEYS as string[]).not.toContain('saved');
  });
});

describe('extractConfig', () => {
  it('picks every config key and drops `saved`', () => {
    const config = extractConfig(SAVED_VIEW);
    expect(config).toEqual(DEFAULT_QUESTIONNAIRE_CONFIG);
    expect('saved' in config).toBe(false);
  });

  it('preserves overridden values', () => {
    const config = extractConfig({
      ...SAVED_VIEW,
      selectionStrategy: 'sequential',
      minQuestionsAnswered: 5,
      costBudgetUsd: 1.5,
    });
    expect(config.selectionStrategy).toBe('sequential');
    expect(config.minQuestionsAnswered).toBe(5);
    expect(config.costBudgetUsd).toBe(1.5);
  });
});

describe('buildSettingsExport', () => {
  it('stamps the discriminator + schema version and carries the config', () => {
    const envelope = buildSettingsExport(SAVED_VIEW, '2026-06-28T00:00:00.000Z');
    expect(envelope.kind).toBe(CONFIG_EXPORT_KIND);
    expect(envelope.schemaVersion).toBe(CONFIG_EXPORT_SCHEMA_VERSION);
    expect(envelope.exportedAt).toBe('2026-06-28T00:00:00.000Z');
    expect(envelope.config).toEqual(DEFAULT_QUESTIONNAIRE_CONFIG);
    expect('saved' in envelope.config).toBe(false);
  });
});

describe('parseSettingsImport', () => {
  it('round-trips an exported envelope', () => {
    const text = JSON.stringify(buildSettingsExport(SAVED_VIEW, '2026-06-28T00:00:00.000Z'));
    const result = parseSettingsImport(text);
    expect(result.config).toEqual(DEFAULT_QUESTIONNAIRE_CONFIG);
    expect(result.keyCount).toBe(CONFIG_KEYS.length);
    expect(result.unknownKeys).toEqual([]);
  });

  it('accepts a bare config object (no envelope)', () => {
    const result = parseSettingsImport(JSON.stringify({ selectionStrategy: 'random' }));
    expect(result.config).toEqual({ selectionStrategy: 'random' });
    expect(result.keyCount).toBe(1);
  });

  it('strips the read-only `saved` flag and envelope metadata from a bare object', () => {
    const result = parseSettingsImport(
      JSON.stringify({ saved: true, schemaVersion: 9, voiceEnabled: true })
    );
    expect(result.config).toEqual({ voiceEnabled: true });
    expect('saved' in result.config).toBe(false);
  });

  it('reports unrecognised keys but still picks the known ones', () => {
    const result = parseSettingsImport(
      JSON.stringify({ config: { voiceEnabled: true, madeUpField: 1, anotherJunk: 'x' } })
    );
    expect(result.config).toEqual({ voiceEnabled: true });
    expect(result.keyCount).toBe(1);
    expect(result.unknownKeys.sort()).toEqual(['anotherJunk', 'madeUpField']);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseSettingsImport('{ not json')).toThrow(/not valid JSON/i);
  });

  it('rejects a non-object document', () => {
    expect(() => parseSettingsImport('[1, 2, 3]')).toThrow(/settings export/i);
  });

  it('rejects an envelope with the wrong kind', () => {
    expect(() =>
      parseSettingsImport(
        JSON.stringify({ kind: 'something.else', config: { voiceEnabled: true } })
      )
    ).toThrow(/settings export/i);
  });

  it('rejects a file with no recognisable settings', () => {
    expect(() => parseSettingsImport(JSON.stringify({ config: { totallyUnknown: 1 } }))).toThrow(
      /no recognisable settings/i
    );
  });
});
