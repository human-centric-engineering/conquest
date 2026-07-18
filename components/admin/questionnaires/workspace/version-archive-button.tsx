'use client';

/**
 * Archive / Restore control for a single row in the Overview version timeline.
 *
 * A compact ghost button that soft-archives (or restores) one version via
 * {@link useArchiveVersion}, then `router.refresh()`es so the timeline + version picker
 * re-render with the new state. Archiving is reversible and orthogonal to the version's
 * `status` (it never interrupts respondents), so there's no confirm modal — just the button
 * with an inline error on failure. Mirrors the questionnaire list-row Archive/Restore action.
 */

import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { useArchiveVersion } from '@/components/admin/questionnaires/use-archive-version';

interface VersionArchiveButtonProps {
  questionnaireId: string;
  versionId: string;
  /** True when the version currently carries an `archivedAt` marker (renders Restore). */
  archived: boolean;
}

export function VersionArchiveButton({
  questionnaireId,
  versionId,
  archived,
}: VersionArchiveButtonProps) {
  const router = useRouter();
  const { archive, restore, isPending, error } = useArchiveVersion();

  const onClick = async () => {
    const ok = await (archived
      ? restore(questionnaireId, versionId)
      : archive(questionnaireId, versionId));
    if (ok) router.refresh();
  };

  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-destructive text-xs">{error}</span>}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => void onClick()}
        disabled={isPending}
      >
        {archived ? 'Restore' : 'Archive'}
      </Button>
    </span>
  );
}
