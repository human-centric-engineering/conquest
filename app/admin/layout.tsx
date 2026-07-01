import type { Metadata } from 'next';
import { Fraunces } from 'next/font/google';
import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/auth/utils';
import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { AdminHeader } from '@/components/admin/admin-header';
import { BreadcrumbProvider } from '@/components/admin/breadcrumb-context';
import { InFlightExecutionBanner } from '@/components/admin/orchestration/in-flight-execution-banner';
import { ConfigHealthGlobalBanner } from '@/components/admin/config-health-global-banner';
import { BRAND } from '@/lib/brand';

// Display serif for the ConQuest wordmark (Questionnaires surface). Exposed as
// a CSS variable only — nothing else reads it, so the admin body font is
// unchanged. Matches the marketing Pricing / About-ConQuest pages.
const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display-cq',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    template: `%s - Admin - ${BRAND.name}`,
    default: `Admin - ${BRAND.name}`,
  },
  description: `Admin dashboard for ${BRAND.name}`,
};

/**
 * Admin Layout (Phase 4.4)
 *
 * Layout for all admin routes.
 * Requires ADMIN role - non-admins are redirected to dashboard.
 * Unauthenticated users are redirected to login.
 */
export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession();

  // Redirect to login if not authenticated
  if (!session) {
    redirect('/login');
  }

  // Redirect to dashboard if not an admin
  if (session.user.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  return (
    <BreadcrumbProvider>
      <div className={`${display.variable} bg-background flex h-screen overflow-hidden`}>
        <AdminSidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <AdminHeader />
          <ConfigHealthGlobalBanner />
          <InFlightExecutionBanner />
          <main className="flex-1 overflow-y-auto overscroll-contain">
            <div className="p-6">{children}</div>
          </main>
        </div>
      </div>
    </BreadcrumbProvider>
  );
}
