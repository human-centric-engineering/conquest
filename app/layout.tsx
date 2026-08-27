import type { Metadata } from 'next';
import { Suspense } from 'react';
import { headers } from 'next/headers';
import '@/app/globals.css';
import '@/app/brand-theme.css'; // fork-owned per-surface palette; must cascade after globals
import { Fraunces, Hanken_Grotesk } from 'next/font/google';
import { ThemeProvider } from '@/hooks/use-theme';
import { ErrorHandlingProvider } from '@/app/error-handling-provider';
import { ConsentProvider } from '@/lib/consent';
import { CookieBanner } from '@/components/cookie-consent';
import { AnalyticsProvider } from '@/lib/analytics';
import { AnalyticsScripts, UserIdentifier, PageTracker } from '@/components/analytics';
import { SurfaceSync } from '@/components/surface-sync';
import { DEFAULT_SURFACE } from '@/lib/app/surface';
import { BRAND } from '@/lib/brand';

// ConQuest brand fonts, loaded once and exposed app-wide as CSS variables. They
// are APPLIED only on consumer surfaces (see app/brand-theme.css); admin keeps
// its default sans, and the respondent surface stays neutral so per-questionnaire
// branding isn't overridden by the editorial serif. Variable names match the
// wordmark + marketing pages, so the ConQuest lockup renders in Fraunces
// everywhere now, not just where a page happened to load the font inline.
const displayFont = Fraunces({
  subsets: ['latin'],
  variable: '--font-display-cq',
  display: 'swap',
});
const bodyFont = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--font-sans-cq',
  display: 'swap',
});

// Root metadata, driven entirely by the BRAND seam (#519). The `template`
// gives every page that sets only a plain string title consistent branding;
// a route group declaring its own `title.template` still wins, so there is no
// double-branding. Previously this hardcoded "- Next.js Starter" and the
// starter blurb, which every fork inherited on any un-templated page.
//
// The `icons` / `manifest` entries below are ConQuest's own favicon set and
// have no upstream equivalent — keep them on sync.
export const metadata: Metadata = {
  title: {
    default: BRAND.name,
    template: `%s - ${BRAND.name}`,
  },
  description: BRAND.description,
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
      { url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
    ],
    apple: '/apple-touch-icon.png',
  },
  manifest: '/site.webmanifest',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const headersList = await headers();
  const nonce = headersList.get('x-nonce') ?? undefined;
  // Rendering surface, classified per-request in proxy.ts. Drives the fork-owned
  // app/brand-theme.css: `consumer` gets the ConQuest palette, `admin` stays on
  // the Sunrise defaults. On <html> so body-portaled overlays inherit it; kept
  // current across client nav by <SurfaceSync> below.
  const surface = headersList.get('x-surface') ?? DEFAULT_SURFACE;

  return (
    <html
      lang="en"
      data-surface={surface}
      className={`${displayFont.variable} ${bodyFont.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  const stored = localStorage.getItem('theme');
                  if (stored === 'light' || stored === 'dark') {
                    document.documentElement.classList.add(stored);
                  } else {
                    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                    const theme = prefersDark ? 'dark' : 'light';
                    document.documentElement.classList.add(theme);
                    localStorage.setItem('theme', theme);
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body suppressHydrationWarning>
        <SurfaceSync />
        <ErrorHandlingProvider>
          <ConsentProvider>
            <AnalyticsProvider>
              <ThemeProvider>
                {children}
                <CookieBanner />
              </ThemeProvider>
              <Suspense fallback={null}>
                <UserIdentifier />
                <PageTracker skipInitial />
              </Suspense>
              <AnalyticsScripts nonce={nonce} />
            </AnalyticsProvider>
          </ConsentProvider>
        </ErrorHandlingProvider>
      </body>
    </html>
  );
}
