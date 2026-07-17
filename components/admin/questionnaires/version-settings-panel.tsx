'use client';

/**
 * VersionSettingsPanel — the version-scoped run-time config surface on the **Settings** tab.
 *
 * Run-time config (selection, thresholds, budget/caps, modes, presentation mode, answer-panel
 * scope, profile fields) is a version-scoped setting, not structure — so it lives here. (Goal &
 * audience used to live here too, but are now edited inline on the Structure tab where they're
 * shown.)
 *
 * Owns ONE mutation runner with the fork-on-launch discipline (same as `version-editor.tsx`):
 * editing a launched version forks a new draft, surfaces the notice, and redirects to that
 * draft's Settings tab. The fork is confirmed with the admin first — centrally, via `authoringMutate`
 * + the workspace `ForkConfirmProvider` — so a declined save (`ForkCancelledError`) writes nothing
 * and shows no error. The fields live in the shared {@link ConfigEditor}.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ConfigEditor } from '@/components/admin/questionnaires/config-editor';
import {
  authoringMutate,
  ForkCancelledError,
} from '@/components/admin/questionnaires/authoring-mutate';
import type {
  MutationSpec,
  RunMutation,
} from '@/components/admin/questionnaires/version-editor-types';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';

export interface VersionSettingsPanelProps {
  questionnaireId: string;
  graph: VersionGraphView;
}

export function VersionSettingsPanel({ questionnaireId, graph }: VersionSettingsPanelProps) {
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
        // The admin declined the fork confirmation → nothing was written; resync, no error banner.
        if (err instanceof ForkCancelledError) {
          router.refresh();
          setBusy(false);
          return false;
        }
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
          isVersionLaunched={graph.status === 'launched'}
          run={run}
          busy={busy}
        />
      </section>
    </div>
  );
}
