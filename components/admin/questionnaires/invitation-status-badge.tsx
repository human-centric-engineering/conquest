/**
 * Status pill for a questionnaire invitation (F3.2). Maps each lifecycle status to
 * a Badge variant + label. `started`/`completed` render too (P6/P7 will produce
 * them) so the component is complete now.
 */

import { Badge } from '@/components/ui/badge';
import type { AppInvitationStatus } from '@/lib/app/questionnaire/invitations';

type Variant = 'default' | 'secondary' | 'destructive' | 'outline';

const STATUS_META: Record<AppInvitationStatus, { label: string; variant: Variant }> = {
  pending: { label: 'Pending', variant: 'outline' },
  sent: { label: 'Sent', variant: 'secondary' },
  opened: { label: 'Opened', variant: 'secondary' },
  registered: { label: 'Registered', variant: 'default' },
  started: { label: 'Started', variant: 'default' },
  completed: { label: 'Completed', variant: 'default' },
  revoked: { label: 'Revoked', variant: 'destructive' },
};

export function InvitationStatusBadge({ status }: { status: AppInvitationStatus }) {
  const meta = STATUS_META[status];
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}
