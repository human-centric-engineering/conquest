// @vitest-environment happy-dom

/**
 * What surrounds a respondent surface, per chrome mode — and the height that surrounds it.
 *
 * Two separate promises live in this one small component, and neither is visible to a test that
 * only looks for rendered text:
 *
 *   1. `white_label` means NO ConQuest branding. Not "less" — none. A client presenting the
 *      instrument as their own is the entire reason the setting exists, and a header that survived
 *      the switch would be a broken promise made to a paying customer rather than a layout bug.
 *   2. The surface is sized by the shell rather than by arithmetic. jsdom computes no layout, so
 *      the assertion is on the classes that do it — the same lesson the answer-drawer's `lg:hidden`
 *      taught: assert the declaration, because the rendering is invisible here.
 *
 * @see components/app/questionnaire/chrome/respondent-chrome.tsx
 * @see .context/app/questionnaire/respondent-chrome.md
 */

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Stubbed so the test does not drag the session/auth tree in behind the header, and so "is the
// ConQuest chrome present" is a single unambiguous query rather than a hunt for marketing copy.
import { vi } from 'vitest';

vi.mock('@/components/layouts/app-header', () => ({
  AppHeader: () => <header data-testid="conquest-header" />,
}));
vi.mock('@/components/layouts/public-nav', () => ({
  PublicNav: () => <nav data-testid="conquest-nav" />,
  PublicNavMenu: () => <div data-testid="conquest-nav-menu" />,
}));
vi.mock('@/components/layouts/public-footer', () => ({
  PublicFooter: () => <footer data-testid="conquest-footer" />,
}));

import { RespondentChrome } from '@/components/app/questionnaire/chrome/respondent-chrome';
import { ThemeProvider } from '@/hooks/use-theme';

// The real provider, not a stub: the theme switch these modes now carry reads `useTheme`, which
// throws outside one. In the product it comes from the root layout, so wrapping here reproduces
// the tree rather than papering over it — and it lets the switch actually flip below.
function renderChrome(mode: 'full' | 'co_branded' | 'white_label', shell?: boolean) {
  return render(
    <ThemeProvider>
      <RespondentChrome mode={mode} shell={shell}>
        <div data-testid="surface" />
      </RespondentChrome>
    </ThemeProvider>
  );
}

describe('what each mode shows', () => {
  it('full keeps the site header and footer, as every respondent page always had', () => {
    renderChrome('full');
    expect(screen.getByTestId('conquest-header')).toBeInTheDocument();
    expect(screen.getByTestId('conquest-footer')).toBeInTheDocument();
  });

  it('co_branded says who built it and offers nothing to click', () => {
    // The point of the mode: a respondent half-way through answering must not be handed a route to
    // our pricing page. So the wordmark is there, and the nav and footer are not.
    const { container } = renderChrome('co_branded');
    // Asserted on the rendered text rather than a query for "ConQuest": the wordmark splits the
    // name across two spans ("Con" + "Quest") so it can colour them differently, and the release
    // stage may add a pill beside it. The name reaching the page is the claim; its markup is not.
    expect(container.textContent).toContain('ConQuest');
    expect(screen.queryByTestId('conquest-header')).toBeNull();
    expect(screen.queryByTestId('conquest-nav')).toBeNull();
    expect(screen.queryByTestId('conquest-footer')).toBeNull();
  });

  it('white_label shows no ConQuest branding at all', () => {
    // The commercial promise, as one assertion.
    const { container } = renderChrome('white_label');
    expect(screen.queryByTestId('conquest-header')).toBeNull();
    expect(screen.queryByTestId('conquest-footer')).toBeNull();
    expect(container.textContent).not.toContain('ConQuest');
  });

  it('renders the questionnaire itself in every mode', () => {
    // Whatever the chrome, the thing the respondent came for is on screen. A mode that dropped it
    // would be a very quiet outage.
    for (const mode of ['full', 'co_branded', 'white_label'] as const) {
      const { unmount } = renderChrome(mode);
      expect(screen.getByTestId('surface'), mode).toBeInTheDocument();
      unmount();
    }
  });
});

describe('the shell that replaced the arithmetic', () => {
  it('sizes the surface from the viewport, not from a guess at the chrome', () => {
    // `h-dvh` on the column and `flex-1 min-h-0` on the surface is the whole mechanism: the chrome
    // sizes to its content and the conversation takes the rest, whatever chrome that turns out to
    // be. Each page used to hard-code its own `calc()` against a header it could not see — and the
    // four pages disagreed with each other by up to 4rem.
    const { container } = renderChrome('full');
    const column = container.firstElementChild;
    expect(column?.className).toContain('h-dvh');

    const main = screen.getByRole('main');
    expect(main.className).toContain('flex-1');
    // Without `min-h-0` a flex child refuses to shrink below its content, so the surface grows past
    // the viewport and the conversation's internal scroll never engages — the composer ends up
    // below the fold with the page itself scrolling.
    expect(main.className).toContain('min-h-0');
  });

  it('puts the surface in the shared reading width by default', () => {
    // `cq-respondent-shell` is also the hook the viewport text-scale media queries key off, so a
    // surface that misses it silently loses the text-size ladder — which is exactly what had
    // happened to the meeting participant surface.
    const main = renderChrome('full').container.querySelector('main');
    expect(main?.className).toContain('cq-respondent-shell');
  });

  it('lets a page that sets its own width opt out', () => {
    // The `/x` "we can't open this conversation here" card is not a conversation, so the reading
    // measure is meaningless there.
    const main = renderChrome('full', false).container.querySelector('main');
    expect(main?.className).not.toContain('cq-respondent-shell');
  });
});

describe('the theme switch', () => {
  // These three pages left the `(public)` group to shed the marketing header, and lost the
  // light/dark switch with it — in the one place in the product where somebody reads continuous
  // prose for twenty minutes, possibly at night. It lives in the chrome rather than in a layout
  // so that all four layouts get it and none of them has to remember.

  it('is offered in co_branded and white_label', () => {
    for (const mode of ['co_branded', 'white_label'] as const) {
      const { unmount } = renderChrome(mode);
      expect(
        screen.getByRole('button', { name: /switch to (light|dark) mode/i }),
        mode
      ).toBeInTheDocument();
      unmount();
    }
  });

  it('is NOT duplicated in full, where the site header already carries one', () => {
    // Two toggles in one viewport is worse than none: they would disagree about which is current.
    renderChrome('full');
    expect(screen.queryByRole('button', { name: /switch to (light|dark) mode/i })).toBeNull();
  });

  it('names the mode it switches TO, not the one in force', () => {
    // "Dark mode" alone leaves a screen-reader user guessing whether it describes the button or
    // the page. The document starts light in this environment, so the button offers dark.
    renderChrome('white_label');
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument();
  });

  it('actually flips the document, which is what the CSS keys off', () => {
    // Every canvas, ink and lockup variable is chosen by a `.dark` rule on <html>. If the switch
    // does not move that class, a client's dark canvas is unreachable however well it resolves.
    renderChrome('white_label');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not put ConQuest branding back on a white-label page', () => {
    // The switch is a sun and a moon; it is not our identity. This is the assertion that keeps it
    // that way if anyone ever reaches for the platform's bordered, wordmarked header control.
    const { container } = renderChrome('white_label');
    expect(container.textContent).not.toContain('ConQuest');
  });
});
