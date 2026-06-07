'use client';

/**
 * DEMO-ONLY (F2.5.1): admin list of demo clients.
 *
 * Lean read surface — demo clients are a small set, so no pagination or server
 * re-fetch (contrast `QuestionnairesTable`). Renders the SSR-provided rows and
 * navigates to the detail/edit page on row click. A fork strips demo tenancy.
 */

import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DemoClientThemePreview } from '@/components/admin/demo-clients/demo-client-theme-preview';
import type { DemoClientView } from '@/lib/app/questionnaire/demo-clients';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export interface DemoClientsTableProps {
  clients: DemoClientView[];
}

export function DemoClientsTable({ clients }: DemoClientsTableProps) {
  const router = useRouter();

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Branding</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Questionnaires</TableHead>
            <TableHead className="text-right">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clients.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                No demo clients yet. Create one to attribute questionnaires to a prospect.
              </TableCell>
            </TableRow>
          ) : (
            clients.map((client) => (
              <TableRow
                key={client.id}
                className="cursor-pointer"
                onClick={() => router.push(`/admin/demo-clients/${client.id}`)}
              >
                <TableCell className="font-medium">{client.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  <code className="text-xs">{client.slug}</code>
                </TableCell>
                <TableCell>
                  <DemoClientThemePreview theme={client} compact />
                </TableCell>
                <TableCell>
                  <Badge variant={client.isActive ? 'default' : 'secondary'}>
                    {client.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {client.questionnaireCount}
                </TableCell>
                <TableCell className="text-muted-foreground text-right">
                  {formatDate(client.createdAt)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
