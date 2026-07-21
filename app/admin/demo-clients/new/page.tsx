/**
 * Admin — Create demo client (DEMO-ONLY, F2.5.1).
 *
 * Flag-gated server shell around the shared `<DemoClientForm>` in create mode.
 * A real client engagement strips demo tenancy — see forking.md.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import { DemoClientForm } from '@/components/admin/demo-clients/demo-client-form';
import { isStorageEnabled } from '@/lib/storage/client';

export const metadata: Metadata = {
  title: 'New demo client',
  description: 'Create a demo client to attribute questionnaires to a prospect.',
};

export default function NewDemoClientPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href="/admin/demo-clients"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" /> Demo clients
        </Link>
        <h1 className="text-2xl font-semibold">New demo client</h1>
      </header>

      <DemoClientForm uploadEnabled={isStorageEnabled()} />
    </div>
  );
}
