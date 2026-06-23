'use client';

/**
 * CohortReportSettingsForm — per-version Cohort Report generation settings (F14.5).
 *
 * Edits `config.cohortReport`: the master enable, the generation knobs (length / detail / formality
 * / instructions / structure template / background) and the context + scoring toggles. Saves via the
 * version config PATCH (the same lazy-config + fork-on-launch path everything else uses). Sits beside
 * the scoring builder on the Scoring tab — both are per-version cohort-report configuration.
 */

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import {
  COHORT_REPORT_LENGTHS,
  COHORT_REPORT_DETAIL_LEVELS,
  COHORT_REPORT_FORMALITIES,
  type CohortReportSettings,
} from '@/lib/app/questionnaire/types';

export interface CohortReportSettingsFormProps {
  questionnaireId: string;
  versionId: string;
  initial: CohortReportSettings;
}

export function CohortReportSettingsForm({
  questionnaireId,
  versionId,
  initial,
}: CohortReportSettingsFormProps) {
  const [s, setS] = React.useState<CohortReportSettings>(initial);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  function setGen<K extends keyof CohortReportSettings['generation']>(
    key: K,
    value: CohortReportSettings['generation'][K]
  ) {
    setS((prev) => ({ ...prev, generation: { ...prev.generation, [key]: value } }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await apiClient.patch(API.APP.QUESTIONNAIRES.versionConfig(questionnaireId, versionId), {
        body: { cohortReport: s },
      });
      setMessage('Cohort report settings saved.');
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  }

  const select = 'border-input bg-background rounded-md border px-2 py-1 text-sm';

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={(e) => setS((prev) => ({ ...prev, enabled: e.target.checked }))}
        />
        Enable the cohort report for this questionnaire
      </label>

      <div className="flex flex-wrap gap-4">
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          Length
          <select
            className={select}
            value={s.generation.length}
            onChange={(e) =>
              setGen('length', e.target.value as CohortReportSettings['generation']['length'])
            }
          >
            {COHORT_REPORT_LENGTHS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          Detail
          <select
            className={select}
            value={s.generation.detailLevel}
            onChange={(e) =>
              setGen(
                'detailLevel',
                e.target.value as CohortReportSettings['generation']['detailLevel']
              )
            }
          >
            {COHORT_REPORT_DETAIL_LEVELS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          Formality
          <select
            className={select}
            value={s.generation.formality}
            onChange={(e) =>
              setGen('formality', e.target.value as CohortReportSettings['generation']['formality'])
            }
          >
            {COHORT_REPORT_FORMALITIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-1">
        <Label htmlFor="cr-structure" className="text-sm font-medium">
          Structure template (optional)
        </Label>
        <Textarea
          id="cr-structure"
          rows={4}
          placeholder="Desired report outline — leave blank to let the AI choose."
          value={s.generation.structure}
          onChange={(e) => setGen('structure', e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="cr-instructions" className="text-sm font-medium">
          Style &amp; voice instructions (optional)
        </Label>
        <Textarea
          id="cr-instructions"
          rows={3}
          value={s.generation.instructions}
          onChange={(e) => setGen('instructions', e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="cr-background" className="text-sm font-medium">
          Background context (optional)
        </Label>
        <Textarea
          id="cr-background"
          rows={3}
          value={s.generation.backgroundContext}
          onChange={(e) => setGen('backgroundContext', e.target.value)}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Draw on</legend>
        {(
          [
            ['useClientKnowledge', 'Client knowledge base'],
            ['useRoundContext', 'Round briefing / context'],
            ['useCohortContext', 'Cohort background'],
            ['scoringEnabled', 'Deterministic scores (Scoring schema below)'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.generation[key]}
              onChange={(e) => setGen(key, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </fieldset>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {message && <p className="text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}

      <Button onClick={() => void save()} disabled={saving} size="sm">
        {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save settings
      </Button>
    </div>
  );
}
