'use client';

/**
 * Lists the agents that can search a given knowledge document.
 *
 * Opens from the "Uses" column on the documents table. Mirrors the
 * resolver in `lib/orchestration/knowledge/resolveAgentDocumentAccess.ts`:
 * each agent row carries one or more access paths (full mode, direct
 * grant, tag grant, or system scope) so the operator can see exactly why
 * the agent has access — useful when culling redundant grants.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Users } from 'lucide-react';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { API } from '@/lib/api/endpoints';

const accessPathSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('full') }),
  z.object({ kind: z.literal('direct') }),
  z.object({
    kind: z.literal('tag'),
    tagId: z.string(),
    tagName: z.string(),
    tagSlug: z.string(),
  }),
  z.object({ kind: z.literal('system') }),
]);

const responseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      agents: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          kind: z.string(),
          knowledgeAccessMode: z.string(),
          paths: z.array(accessPathSchema),
        })
      ),
      documentScope: z.string(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

type AgentRow = NonNullable<z.infer<typeof responseSchema>['data']>['agents'][number];

export interface DocumentAgentsModalProps {
  documentId: string | null;
  documentName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function pathLabel(path: AgentRow['paths'][number]): { label: string; tooltip: string } {
  switch (path.kind) {
    case 'full':
      return {
        label: 'Full access',
        tooltip: 'Agent has unrestricted knowledge-base access — can search every document.',
      };
    case 'direct':
      return {
        label: 'Direct grant',
        tooltip: 'Agent was explicitly granted this document on its knowledge tab.',
      };
    case 'tag':
      return {
        label: `Tag: ${path.tagName}`,
        tooltip: `Agent was granted the "${path.tagName}" tag, which is applied to this document.`,
      };
    case 'system':
      return {
        label: 'System document',
        tooltip:
          'Document scope is "system" — restricted agents always get access to platform-seed content.',
      };
  }
}

export function DocumentAgentsModal({
  documentId,
  documentName,
  open,
  onOpenChange,
}: DocumentAgentsModalProps): React.ReactElement {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [scope, setScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentAgents(documentId));
      if (!res.ok) throw new Error(`Failed to load agents (${res.status})`);
      const body = responseSchema.parse(await res.json());
      if (!body.success || !body.data) {
        throw new Error(body.error?.message ?? 'Failed to load agents');
      }
      setAgents(body.data.agents);
      setScope(body.data.documentScope);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    if (open && documentId) {
      void fetchAgents();
    }
    if (!open) {
      setAgents([]);
      setScope(null);
      setError(null);
    }
  }, [open, documentId, fetchAgents]);

  const total = agents.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Agents using — {documentName ?? 'Document'}
          </DialogTitle>
          <DialogDescription>
            Active agents that can search this document. The badge on each row shows the path that
            grants access — full-access agents see every document, restricted agents need a direct
            grant, a shared tag, or a system-scope document.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {error ? <p className="text-destructive text-sm">{error}</p> : null}

          {loading ? (
            <p className="text-muted-foreground text-xs">Loading…</p>
          ) : total === 0 ? (
            <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center">
              <p className="text-sm">No active agents can access this document.</p>
              <p className="mt-1 text-xs">
                Grant access from an agent&apos;s <strong>Knowledge</strong> tab — either pick this
                document directly or assign a tag it carries.
              </p>
            </div>
          ) : (
            <div className="rounded-md border">
              <div className="text-muted-foreground bg-muted/40 flex items-center justify-between border-b px-3 py-1.5 text-xs">
                <span>
                  {total} agent{total === 1 ? '' : 's'}
                </span>
                {scope === 'system' ? (
                  <span>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      System scope
                    </Badge>
                  </span>
                ) : null}
              </div>
              <ul className="max-h-96 divide-y overflow-y-auto">
                {agents.map((agent) => (
                  <li key={agent.id} className="px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={`/admin/orchestration/agents/${agent.id}`}
                        className="hover:bg-muted/40 group -mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-0.5 transition-colors"
                      >
                        <span className="truncate text-sm font-medium group-hover:underline">
                          {agent.name}
                        </span>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs">
                          {agent.slug}
                        </span>
                        {agent.kind !== 'chat' ? (
                          <Badge variant="outline" className="text-[10px] uppercase">
                            {agent.kind}
                          </Badge>
                        ) : null}
                        <ExternalLink className="text-muted-foreground h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                      </Link>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {agent.paths.map((path, idx) => {
                        const { label, tooltip } = pathLabel(path);
                        const variant =
                          path.kind === 'full'
                            ? 'secondary'
                            : path.kind === 'direct'
                              ? 'default'
                              : 'outline';
                        const key =
                          path.kind === 'tag' ? `tag:${path.tagId}` : `${path.kind}:${idx}`;
                        return (
                          <Badge
                            key={key}
                            variant={variant}
                            title={tooltip}
                            className="text-[10px]"
                          >
                            {label}
                          </Badge>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
