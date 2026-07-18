'use client';

/**
 * Version switcher for the questionnaire workspace header.
 *
 * Switching version keeps the admin on the same tab: it preserves the top-level
 * path segment (Structure → Structure, Analytics → Analytics …) but drops any
 * deeper segment (e.g. a specific evaluation run id) that belongs to the old
 * version. Renders a compact Select so it scales past a handful of versions.
 */
import { useRouter, usePathname } from 'next/navigation';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';

export interface VersionOption {
  id: string;
  versionNumber: number;
  status: string;
  /** Per-version soft-archive marker (ISO) or null. Archived versions are hidden from the picker. */
  archivedAt: string | null;
}

interface VersionSelectorProps {
  questionnaireId: string;
  versionId: string;
  versions: readonly VersionOption[];
}

export function VersionSelector({ questionnaireId, versionId, versions }: VersionSelectorProps) {
  const router = useRouter();
  const pathname = usePathname();

  const onChange = (nextVersionId: string) => {
    if (nextVersionId === versionId) return;
    // Preserve the current top-level tab segment, drop any deeper sub-path.
    const currentBase = workspaceVersionBase(questionnaireId, versionId);
    const rest = pathname.startsWith(currentBase) ? pathname.slice(currentBase.length) : '';
    const topSegment = rest.split('/').filter(Boolean)[0] ?? '';
    const nextBase = workspaceVersionBase(questionnaireId, nextVersionId);
    router.push(topSegment ? `${nextBase}/${topSegment}` : nextBase);
  };

  // Hide archived versions from the picker to keep it tidy — but always keep the one currently being
  // viewed, so landing on an archived version directly (e.g. via history/Restore) never blanks it out.
  const shown = versions.filter((ver) => ver.archivedAt === null || ver.id === versionId);

  if (shown.length <= 1) {
    const only = shown[0];
    if (!only) return null;
    return (
      <span className="text-muted-foreground text-sm">
        v{only.versionNumber} · {only.status}
      </span>
    );
  }

  return (
    <Select value={versionId} onValueChange={onChange}>
      <SelectTrigger aria-label="Select version" className="h-8 w-auto gap-1.5 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {shown.map((ver) => (
          <SelectItem key={ver.id} value={ver.id}>
            v{ver.versionNumber} · {ver.status}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
