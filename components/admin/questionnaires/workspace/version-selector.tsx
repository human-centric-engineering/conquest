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

  if (versions.length <= 1) {
    const only = versions[0];
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
        {versions.map((ver) => (
          <SelectItem key={ver.id} value={ver.id}>
            v{ver.versionNumber} · {ver.status}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
