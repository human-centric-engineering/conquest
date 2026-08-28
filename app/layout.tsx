import type { Metadata } from 'next';
import { Suspense } from 'react';
import { headers } from 'next/headers';
import '@/app/globals.css';
import '@/app/brand-theme.css'; // fork-owned per-surface palette; must cascade after globals
import {
  Bricolage_Grotesque,
  Fraunces,
  Hanken_Grotesk,
  IBM_Plex_Mono,
  Instrument_Serif,
  JetBrains_Mono,
  Lora,
  Newsreader,
  Outfit,
  Playfair_Display,
  Source_Sans_3,
  Space_Grotesk,
} from 'next/font/google';
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

// Demo-client BRAND fonts: the two non-default pairings a questionnaire can be set in
// (lib/app/questionnaire/theming/fonts.ts). Loaded here because `next/font` must be called
// at module scope, and the root layout is the one module every respondent surface passes
// through — but APPLIED only where a client has chosen a pairing, via the `--app-font-*`
// variables the theming module emits onto that questionnaire's surface.
//
// `preload: false` on every one of them, deliberately: preloading would have every page in
// the product fetch ten typefaces it almost certainly does not use, to serve the minority of
// questionnaires that pick one. They load on demand instead, and `display: 'swap'` means
// the surface renders immediately in the fallback while they do. That opt-out is what makes
// the pairing list cheap to GROW — a seventh pairing costs two declarations here and nothing
// at all to a page that never uses it — so the parity test asserts it, and an added pairing
// cannot quietly put its faces on the critical path of every marketing page.
//
// The `variable` names here are the contract FONT_PAIRING_STACKS references by name; a
// rename on either side degrades silently to the fallback stack, so a parity test asserts
// the two agree.
const editorialDisplayFont = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-brand-editorial-display',
  display: 'swap',
  preload: false,
});
const editorialBodyFont = Newsreader({
  subsets: ['latin'],
  variable: '--font-brand-editorial-body',
  display: 'swap',
  preload: false,
});
const contemporaryDisplayFont = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-brand-contemporary-display',
  display: 'swap',
  preload: false,
});
const contemporaryBodyFont = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-brand-contemporary-body',
  display: 'swap',
  preload: false,
});
const humanistDisplayFont = Outfit({
  subsets: ['latin'],
  variable: '--font-brand-humanist-display',
  display: 'swap',
  preload: false,
});
const humanistBodyFont = Source_Sans_3({
  subsets: ['latin'],
  variable: '--font-brand-humanist-body',
  display: 'swap',
  preload: false,
});
const classicalDisplayFont = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-brand-classical-display',
  display: 'swap',
  preload: false,
});
const classicalBodyFont = Lora({
  subsets: ['latin'],
  variable: '--font-brand-classical-body',
  display: 'swap',
  preload: false,
});
const monospaceDisplayFont = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-brand-monospace-display',
  display: 'swap',
  preload: false,
});
// IBM Plex Mono is the one brand face with no variable axis on Google Fonts, so the weights it
// serves have to be named. Three: body copy, the emphasis Markdown produces inside an answer,
// and the semibold the strip and buttons reach for.
const monospaceBodyFont = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-brand-monospace-body',
  display: 'swap',
  preload: false,
});

/** Every font variable this layout declares, in one place for the <html> className. */
const FONT_VARIABLES = [
  displayFont.variable,
  bodyFont.variable,
  editorialDisplayFont.variable,
  editorialBodyFont.variable,
  contemporaryDisplayFont.variable,
  contemporaryBodyFont.variable,
  humanistDisplayFont.variable,
  humanistBodyFont.variable,
  classicalDisplayFont.variable,
  classicalBodyFont.variable,
  monospaceDisplayFont.variable,
  monospaceBodyFont.variable,
].join(' ');

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
    <html lang="en" data-surface={surface} className={FONT_VARIABLES} suppressHydrationWarning>
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
