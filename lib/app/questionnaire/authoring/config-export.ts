/**
 * Settings import / export envelope for a version's run-time configuration (Settings tab).
 *
 * "Export all settings" serialises the resolved {@link ConfigView} into a small, portable
 * JSON envelope; "Import" parses such a file back into a {@link QuestionnaireConfigShape}
 * that the editor PATCHes through the existing config endpoint (`updateConfigSchema` is the
 * real validator — this layer only shapes + sanity-checks the file). Round-trips cleanly:
 * what export writes, import accepts.
 *
 * Pure: no Prisma / Next / DOM. The key list is derived from {@link DEFAULT_QUESTIONNAIRE_CONFIG}
 * so it can never drift from the config shape — a new config field is exported the moment it
 * gains a default. The `saved` flag carried by {@link ConfigView} is deliberately dropped (it's
 * read-only server state, not a setting).
 */

import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  type QuestionnaireConfigShape,
} from '@/lib/app/questionnaire/types';
import type { ConfigView } from '@/lib/app/questionnaire/views';

/** Discriminator stamped on an export so import can reject unrelated JSON files. */
export const CONFIG_EXPORT_KIND = 'conquest.questionnaire.settings';

/** Envelope schema version — bump if the on-disk shape ever changes incompatibly. */
export const CONFIG_EXPORT_SCHEMA_VERSION = 1;

/**
 * The settings keys — every field of {@link QuestionnaireConfigShape}, derived from the
 * default-config object so the set is always exhaustive and never drifts.
 */
export const CONFIG_KEYS = Object.keys(
  DEFAULT_QUESTIONNAIRE_CONFIG
) as (keyof QuestionnaireConfigShape)[];

/** The on-disk envelope written by {@link buildSettingsExport}. */
export interface SettingsExport {
  kind: typeof CONFIG_EXPORT_KIND;
  schemaVersion: number;
  exportedAt: string;
  config: QuestionnaireConfigShape;
}

/** The outcome of parsing an import file — the picked config plus what was found. */
export interface SettingsImport {
  /** Only the recognised config keys, ready to PATCH (drops `saved` and any unknowns). */
  config: Partial<QuestionnaireConfigShape>;
  /** How many recognised settings keys the file carried. */
  keyCount: number;
  /** Keys present in the file's config that aren't part of the config shape (ignored). */
  unknownKeys: string[];
}

/** Pick just the config keys off a {@link ConfigView}, dropping the read-only `saved` flag. */
export function extractConfig(config: ConfigView): QuestionnaireConfigShape {
  const out: Record<string, unknown> = {};
  const source = config as unknown as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    out[key] = source[key];
  }
  return out as QuestionnaireConfigShape;
}

/** Build the export envelope for a version's resolved config. */
export function buildSettingsExport(config: ConfigView, exportedAt: string): SettingsExport {
  return {
    kind: CONFIG_EXPORT_KIND,
    schemaVersion: CONFIG_EXPORT_SCHEMA_VERSION,
    exportedAt,
    config: extractConfig(config),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse an import file. Accepts either a full {@link SettingsExport} envelope or a bare config
 * object (so a hand-authored file still works). Validates the JSON, the `kind` discriminator when
 * present, and that at least one recognised setting is carried; picks only the known keys so junk
 * (including `saved`) never reaches the server. Throws a user-facing `Error` on any failure —
 * value-level validation is left to the server's `updateConfigSchema`.
 */
export function parseSettingsImport(text: string): SettingsImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }

  if (!isPlainObject(parsed)) {
    throw new Error("This file doesn't look like a settings export.");
  }

  // An export envelope carries `kind` + `config`; a bare object is treated as the config itself.
  if ('kind' in parsed && parsed.kind !== CONFIG_EXPORT_KIND) {
    throw new Error("This file isn't a questionnaire settings export.");
  }

  const rawConfig = isPlainObject(parsed.config) ? parsed.config : parsed;

  const config: Record<string, unknown> = {};
  const known = new Set<string>(CONFIG_KEYS);
  const unknownKeys: string[] = [];
  for (const [key, value] of Object.entries(rawConfig)) {
    if (key === 'kind' || key === 'schemaVersion' || key === 'exportedAt' || key === 'saved') {
      continue; // envelope metadata / read-only state — never a setting
    }
    if (known.has(key)) {
      config[key] = value;
    } else {
      unknownKeys.push(key);
    }
  }

  const keyCount = Object.keys(config).length;
  if (keyCount === 0) {
    throw new Error('No recognisable settings found in this file.');
  }

  return { config, keyCount, unknownKeys };
}
