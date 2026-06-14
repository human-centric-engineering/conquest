'use client';

/**
 * VersionSettingsPanel — the version-scoped settings surface on the **Settings** tab.
 *
 * Goal/audience metadata and run-time config (selection, thresholds, budget/caps, modes,
 * presentation mode, answer-panel scope, profile fields) are version-scoped settings, not
 * structure — so they live here, discoverable without entering the Structure editor. Structure
 * stays purely structural.
 *
 * Owns ONE mutation runner with the fork-on-launch discipline (same as `version-editor.tsx`):
 * editing a launched version forks a new draft, surfaces the notice, and redirects to that
 * draft's Settings tab. The fields live in the shared {@link GoalAudienceEditor} and
 * {@link ConfigEditor}; this panel composes them under one runner + fork notice.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { GoalAudienceEditor } from '@/components/admin/questionnaires/goal-audience-editor';
import { ConfigEditor } from '@/components/admin/questionnaires/config-editor';
import { FieldHelp } from '@/components/ui/field-help';
import { authoringMutate } from '@/components/admin/questionnaires/authoring-mutate';
import type {
  MutationSpec,
  RunMutation,
} from '@/components/admin/questionnaires/version-editor-types';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';

export interface VersionSettingsPanelProps {
  questionnaireId: string;
  graph: VersionGraphView;
  /** Adaptive selection sub-flag state, threaded to the strategy picker. */
  adaptiveEnabled: boolean;
  /**
   * Design-time evaluation sub-flag state. When on, the structure review (Evaluations tab)
   * is active for this questionnaire — so the goal/audience copy explains that the review
   * scores against these fields and lists which reviewers read them. When off, the copy
   * omits the review so it doesn't dangle a feature whose tab 404s.
   */
  designEvalEnabled: boolean;
}

export function VersionSettingsPanel({
  questionnaireId,
  graph,
  adaptiveEnabled,
  designEvalEnabled,
}: VersionSettingsPanelProps) {
  const router = useRouter();
  const versionId = graph.id;
  const questionCount = graph.sections.reduce((n, s) => n + s.questions.length, 0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkNotice, setForkNotice] = useState<number | null>(null);

  // Release the busy lock once the refreshed graph arrives (mirrors version-editor) — this
  // closes the window where a second save could fire against the pre-fork version id.
  useEffect(() => {
    setBusy(false);
  }, [graph]);

  const run: RunMutation = (spec) => {
    const [method, path, body]: MutationSpec = spec();
    setBusy(true);
    setError(null);
    return authoringMutate(method, path, body)
      .then(({ meta }) => {
        if (meta?.forked) {
          setForkNotice(meta.versionNumber);
          // Subsequent edits must target the new draft's Settings tab.
          router.replace(`/admin/questionnaires/${questionnaireId}/v/${meta.versionId}/settings`);
        }
        router.refresh();
        return true;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Something went wrong');
        router.refresh();
        setBusy(false);
        return false;
      });
  };

  return (
    <div className="space-y-6">
      {forkNotice !== null && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          You edited a launched version — your changes were saved to a new draft (v{forkNotice}).
          You are now editing that draft.
        </div>
      )}
      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <h2 className="text-lg font-semibold">Goal &amp; audience</h2>
            {designEvalEnabled && (
              <FieldHelp
                title="How the structure review uses this"
                ariaLabel="How goal and audience are used by the structure review"
                contentClassName="w-80"
              >
                <p>
                  When you run a <strong>structure review</strong> on the{' '}
                  <strong>Evaluations</strong> tab, these AI reviewers read the goal and audience to
                  score your questions before launch:
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  <li>
                    <strong>Coverage</strong> — do the questions cover the whole goal? Flags gaps.
                  </li>
                  <li>
                    <strong>Goal match</strong> — does every question serve the goal? Flags
                    off-mission questions.
                  </li>
                  <li>
                    <strong>Audience match</strong> — is the wording, reading level, and length
                    right for this audience?
                  </li>
                </ul>
                <p className="mt-1">
                  The other reviewers (clarity, duplicates, type fit, ordering) don’t rely on these
                  fields.
                </p>
              </FieldHelp>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            {designEvalEnabled
              ? 'What this questionnaire is trying to learn and who answers it. The conversation tunes its tone to the audience, and the structure review on the Evaluations tab scores your questions against this goal and audience.'
              : 'What this questionnaire is trying to learn and who answers it. The conversation tunes its tone to the audience.'}
          </p>
        </div>
        <GoalAudienceEditor
          questionnaireId={questionnaireId}
          versionId={versionId}
          goal={graph.goal}
          audience={graph.audience}
          run={run}
          busy={busy}
        />
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Configuration</h2>
          <p className="text-muted-foreground text-sm">
            How a session runs for this version — question selection, completion thresholds, budget
            caps, modes, and how the respondent completes it (chat, form, or both). Editing a
            launched version saves the changes to a new draft.
          </p>
        </div>
        <ConfigEditor
          questionnaireId={questionnaireId}
          versionId={versionId}
          config={graph.config}
          questionCount={questionCount}
          adaptiveEnabled={adaptiveEnabled}
          run={run}
          busy={busy}
        />
      </section>
    </div>
  );
}
