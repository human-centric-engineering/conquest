'use client';

/**
 * GoalAudienceEditor — the version's goal + audience metadata, edited on the Settings tab.
 *
 * Goal/audience describe what the questionnaire is trying to learn and who answers it (judges
 * score the structure against them). They're version-scoped settings, not structure, so they
 * live on Settings alongside the run-time config. Presentational: controlled state seeded from
 * props, saved through the parent's `run` mutation runner (which applies the fork-on-launch
 * discipline) — same pattern as {@link ConfigEditor}.
 */

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import type { AudienceShape } from '@/lib/app/questionnaire/types';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

export interface GoalAudienceEditorProps {
  questionnaireId: string;
  versionId: string;
  goal: string | null;
  audience: AudienceShape | null;
  run: RunMutation;
  busy: boolean;
}

export function GoalAudienceEditor({
  questionnaireId,
  versionId,
  goal: goalProp,
  audience: audienceProp,
  run,
  busy,
}: GoalAudienceEditorProps) {
  const [goal, setGoal] = useState(goalProp ?? '');
  const [audience, setAudience] = useState<AudienceShape>(audienceProp ?? {});

  // Resync from the server graph after each refetch (mirrors the config/version editors).
  useEffect(() => {
    setGoal(goalProp ?? '');
    setAudience(audienceProp ?? {});
  }, [goalProp, audienceProp]);

  const save = () =>
    run(() => [
      'PATCH',
      API.APP.QUESTIONNAIRES.versionGraph(questionnaireId, versionId),
      {
        goal: goal.trim() === '' ? null : goal,
        audience: Object.keys(audience).length ? audience : null,
      },
    ]);

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">
          Goal{' '}
          <FieldHelp title="Questionnaire goal">
            What this questionnaire is trying to learn. Judges (P5) score the structure against
            this. Leave blank to clear it.
          </FieldHelp>
        </Label>
        <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} disabled={busy} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">
            Audience role{' '}
            <FieldHelp title="Audience role">
              Who completes this questionnaire (e.g. “patient”, “new hire”). Used to tune tone and
              judge audience-fit.
            </FieldHelp>
          </Label>
          <Input
            value={audience.role ?? ''}
            onChange={(e) => setAudience({ ...audience, role: e.target.value || undefined })}
            disabled={busy}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Audience description</Label>
          <Input
            value={audience.description ?? ''}
            onChange={(e) => setAudience({ ...audience, description: e.target.value || undefined })}
            disabled={busy}
          />
        </div>
      </div>
      <Button size="sm" disabled={busy} onClick={save}>
        Save goal &amp; audience
      </Button>
    </section>
  );
}
