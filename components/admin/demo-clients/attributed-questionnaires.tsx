'use client';

/**
 * DEMO-ONLY (F2.5.1): the attributed-questionnaire list with inline attribution actions.
 *
 * A demo client can't be deleted while any questionnaire is branded as it (the server
 * refuses with 409 `DEMO_CLIENT_IN_USE`). Rather than tell the admin to go open each
 * questionnaire's editor, the unblock happens in place: every row carries a menu that
 * detaches it ("Make generic") or reassigns it to another active client, via
 * `PATCH /api/v1/app/questionnaires/:id { demoClientId }`. On success it refreshes so
 * the attributed count and the delete guard below re-read. A fork strips demo tenancy.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRightLeft, ExternalLink, Loader2, MoreHorizontal, Unlink } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { QUESTIONNAIRE_STATUS_BADGE } from '@/components/admin/questionnaires/status-badge';
import type {
  AttributedDemoClient,
  AttributedQuestionnaireRow,
} from '@/lib/app/questionnaire/demo-clients';

export interface AttributedQuestionnairesProps {
  /** The questionnaires branded as this client. */
  questionnaires: AttributedQuestionnaireRow[];
  /** Other active demo clients available as reassignment targets (excludes this one). */
  reassignTargets: AttributedDemoClient[];
}

export function AttributedQuestionnaires({
  questionnaires,
  reassignTargets,
}: AttributedQuestionnairesProps) {
  const router = useRouter();
  // Id of the row whose attribution is currently being changed (drives the spinner).
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateAttribution = async (questionnaireId: string, demoClientId: string | null) => {
    setPendingId(questionnaireId);
    setError(null);
    try {
      await apiClient.patch(API.APP.QUESTIONNAIRES.byId(questionnaireId), {
        body: { demoClientId },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not update the attribution.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-md border">
        {questionnaires.map((q) => {
          const badge = QUESTIONNAIRE_STATUS_BADGE[q.status];
          const isPending = pendingId === q.id;
          return (
            <li key={q.id} className="flex items-center gap-3 px-3 py-2">
              <Link
                href={`/admin/questionnaires/${q.id}`}
                className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
              >
                {q.title}
              </Link>
              <Badge variant={badge.variant}>{badge.label}</Badge>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    disabled={isPending}
                    aria-label={`Attribution actions for ${q.title}`}
                  >
                    {isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MoreHorizontal className="h-4 w-4" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem asChild>
                    <Link href={`/admin/questionnaires/${q.id}`}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Open editor
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void updateAttribution(q.id, null)}>
                    <Unlink className="mr-2 h-4 w-4" />
                    Make generic (detach)
                  </DropdownMenuItem>
                  {reassignTargets.length > 0 && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <ArrowRightLeft className="mr-2 h-4 w-4" />
                        Reassign to
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                          Other active clients
                        </DropdownMenuLabel>
                        {reassignTargets.map((target) => (
                          <DropdownMenuItem
                            key={target.id}
                            onSelect={() => void updateAttribution(q.id, target.id)}
                          >
                            {target.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
