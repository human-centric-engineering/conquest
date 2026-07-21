/**
 * Branding tab — the everyday edit surface for a demo client.
 *
 * Renders the shared `<DemoClientForm>` in edit mode: identity fields (name,
 * slug, description, active) plus the full brand theming with its own live
 * preview. No form refactor — the whole form moves here intact from the old
 * single-page detail view.
 *
 * DEMO-ONLY (F2.5.1).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DemoClientForm } from '@/components/admin/demo-clients/demo-client-form';
import { isStorageEnabled } from '@/lib/storage/client';
import { getDemoClientDetailCached } from '@/lib/app/questionnaire/demo-clients/detail-data';

export const metadata: Metadata = {
  title: 'Branding · Demo client',
  description: 'Edit a demo client’s identity and brand theming.',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DemoClientBrandingTab({ params }: PageProps) {
  const { id } = await params;
  const client = await getDemoClientDetailCached(id);
  if (!client) notFound();

  // Resolved here, not in the form: isStorageEnabled() reads server-only env, and the
  // form is a client component. False → the brand image fields offer URL entry only.
  return <DemoClientForm client={client} uploadEnabled={isStorageEnabled()} />;
}
