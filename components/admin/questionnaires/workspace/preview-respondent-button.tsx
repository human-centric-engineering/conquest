/**
 * PreviewRespondentButton — the compact "Preview" CTA in the workspace header, beside the version
 * selector, so an admin can launch a respondent walkthrough from ANY tab (not just the Overview).
 *
 * Opens `/q/[vid]?preview=1` in a new tab — the admin-gated `/preview` boot marks the run
 * `isPreview` (kept out of analytics) and shows an exit link. The caller decides whether to render
 * it (see {@link isPreviewAvailable}); this component is purely the button. A plain `<Link>`, so it
 * needs no client JS.
 */

import Link from 'next/link';
import { Eye } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function PreviewRespondentButton({
  versionId,
  className,
}: {
  versionId: string;
  className?: string;
}) {
  return (
    <Button asChild variant="outline" size="sm" className={cn('shrink-0', className)}>
      <Link
        href={`/q/${versionId}?preview=1`}
        target="_blank"
        rel="noopener noreferrer"
        title="Walk through the questionnaire as a respondent (opens in a new tab; not recorded in analytics)"
      >
        <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Preview
      </Link>
    </Button>
  );
}
