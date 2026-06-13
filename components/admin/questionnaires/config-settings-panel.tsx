'use client';

/**
 * ConfigSettingsPanel — the run-time configuration surface on the **Settings** tab.
 *
 * Run-time config (selection, completion thresholds, budget/caps, voice / contradiction /
 * anonymous / sensitivity modes, presentation mode, answer-panel scope, profile fields) is
 * version-scoped config, not structure — so it lives here on Settings, discoverable without
 * entering the Structure editor. Structure stays purely structural.
 *
 * Owns its own mutation runner (the same fork-on-launch discipline as `version-editor.tsx`):
 * editing a launched version's config forks a new draft, surfaces the notice, and redirects to
 * that draft's Settings tab. The actual fields live in the shared {@link ConfigEditor}.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ConfigEditor } from '@/components/admin/questionnaires/config-editor';
import { authoringMutate } from '@/components/admin/questionnaires/authoring-mutate';
import type {
  MutationSpec,
  RunMutation,
} from '@/components/admin/questionnaires/version-editor-types';
import type { ConfigView } from '@/lib/app/questionnaire/views';

export interface ConfigSettingsPanelProps {
  questionnaireId: string;
  versionId: string;
  config: ConfigView;
  /** Live question count on the version — folded into the cost-estimate reload key. */
  questionCount: number;
  /** Adaptive selection sub-flag state, threaded to the strategy picker. */
  adaptiveEnabled: boolean;
}

export function ConfigSettingsPanel({
  questionnaireId,
  versionId,
  config,
  questionCount,
  adaptiveEnabled,
}: ConfigSettingsPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkNotice, setForkNotice] = useState<number | null>(null);

  // Release the busy lock once the refreshed config arrives (mirrors version-editor) — this
  // closes the window where a second save could fire against the pre-fork version id.
  useEffect(() => {
    setBusy(false);
  }, [config]);

  const run: RunMutation = (spec) => {
    const [method, path, body]: MutationSpec = spec();
    setBusy(true);
    setError(null);
    authoringMutate(method, path, body)
      .then(({ meta }) => {
        if (meta?.forked) {
          setForkNotice(meta.versionNumber);
          // Subsequent edits must target the new draft's Settings tab.
          router.replace(`/admin/questionnaires/${questionnaireId}/v/${meta.versionId}/settings`);
        }
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Something went wrong');
        router.refresh();
        setBusy(false);
      });
  };

  return (
    <div className="space-y-4">
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
      <ConfigEditor
        questionnaireId={questionnaireId}
        versionId={versionId}
        config={config}
        questionCount={questionCount}
        adaptiveEnabled={adaptiveEnabled}
        run={run}
        busy={busy}
      />
    </div>
  );
}
