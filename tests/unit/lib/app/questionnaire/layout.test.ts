/**
 * Pins the documented layout invariants for the shared respondent-surface geometry.
 *
 * `RESPONDENT_SHELL` and `RESPONDENT_SPLIT` are plain Tailwind class strings, so they report
 * 100% coverage the moment any host page imports them — a typo inside either literal would
 * otherwise slip past every test in the suite. These tests parse the strings and assert the
 * specific invariants the design doc calls out, so a regression in any one of them fails here
 * instead of silently misaligning the conversation against the page chrome.
 *
 * @see lib/app/questionnaire/layout.ts
 * @see .context/app/questionnaire/respondent-layout.md
 */
import { describe, expect, it } from 'vitest';

import { RESPONDENT_SHELL, RESPONDENT_SPLIT } from '@/lib/app/questionnaire/layout';

describe('RESPONDENT_SHELL', () => {
  it('is exactly the hook class plus the header/footer container geometry', () => {
    // One frozen literal assertion, alongside the more targeted ones below — this alone would
    // catch a typo, but by itself would not explain *why* the string must look this way.
    expect(RESPONDENT_SHELL).toBe('cq-respondent-shell container mx-auto');
  });

  it('reuses the site header/footer container geometry (container mx-auto)', () => {
    const utilities = RESPONDENT_SHELL.split(/\s+/);

    // The shell IS the header's container — components/layouts/app-header.tsx uses
    // `container mx-auto px-4`. Losing either utility reintroduces the header/footer
    // misalignment the design doc describes.
    expect(utilities).toContain('container');
    expect(utilities).toContain('mx-auto');
  });

  it('carries the cq-respondent-shell hook the viewport text-scale media queries key off', () => {
    const utilities = RESPONDENT_SHELL.split(/\s+/);

    // app/globals.css scopes --cq-chat-viewport-scale to `.cq-respondent-shell`; without this
    // class riding on the shell, a host page would silently lose the large-display text scale.
    expect(utilities).toContain('cq-respondent-shell');
  });

  it('does not reintroduce a shell-specific width ladder', () => {
    // The doc is explicit: "Do not reintroduce a shell-specific width." Any `max-w-*` utility
    // here would desync the conversation from the header/footer container it must track.
    const hasMaxWidthUtility = RESPONDENT_SHELL.split(/\s+/).some((utility) =>
      utility.startsWith('max-w-')
    );

    expect(hasMaxWidthUtility).toBe(false);
  });
});

/**
 * A single `bp:grid-cols-[track1_track2]` utility parsed out of RESPONDENT_SPLIT, e.g.
 * `lg:grid-cols-[minmax(0,1fr)_22rem]` becomes
 * `{ breakpoint: 'lg', conversationTrack: 'minmax(0,1fr)', panelTrack: '22rem' }`.
 */
interface ParsedGridColsStep {
  breakpoint: string;
  conversationTrack: string;
  panelTrack: string;
}

/** Extracts every `bp:grid-cols-[...]` step from RESPONDENT_SPLIT, in source order. */
function parseGridColsSteps(classString: string): ParsedGridColsStep[] {
  const pattern = /(\S+):grid-cols-\[([^\]]+)\]/g;
  const steps: ParsedGridColsStep[] = [];

  for (const match of classString.matchAll(pattern)) {
    const [, breakpoint, tracks] = match;
    const [conversationTrack, panelTrack] = tracks.split('_');
    steps.push({ breakpoint, conversationTrack, panelTrack });
  }

  return steps;
}

describe('RESPONDENT_SPLIT', () => {
  it('is exactly the documented gap + three-step grid-cols ladder', () => {
    // One frozen literal assertion alongside the derived ones below.
    expect(RESPONDENT_SPLIT).toBe(
      'gap-4 2xl:gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_26rem] 2xl:grid-cols-[minmax(0,1fr)_30rem]'
    );
  });

  it('gives the conversation column minmax(0,1fr) at every breakpoint step', () => {
    const steps = parseGridColsSteps(RESPONDENT_SPLIT);

    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      // The `0` floor (not `auto`) is what stops a long unbroken token in a reply from forcing
      // the conversation track past its fair share of the row.
      expect(step.conversationTrack).toBe('minmax(0,1fr)');
    }
  });

  it('ladders the panel track monotonically: 22rem (lg) -> 26rem (xl) -> 30rem (2xl)', () => {
    const steps = parseGridColsSteps(RESPONDENT_SPLIT);
    const byBreakpoint = new Map(steps.map((step) => [step.breakpoint, step.panelTrack]));

    expect(byBreakpoint.get('lg')).toBe('22rem');
    expect(byBreakpoint.get('xl')).toBe('26rem');
    expect(byBreakpoint.get('2xl')).toBe('30rem');

    const remValues = ['lg', 'xl', '2xl'].map((bp) => {
      const track = byBreakpoint.get(bp);
      expect(track).toBeDefined();
      return Number((track as string).replace('rem', ''));
    });

    // Assert the ordering is derived, not just the frozen literal above: each step must be
    // strictly larger than the last, or a captured paraphrase stops being the thing that gets
    // the extra width as the viewport grows.
    expect(remValues[0]).toBeLessThan(remValues[1]);
    expect(remValues[1]).toBeLessThan(remValues[2]);
  });

  it('starts the ladder at lg and never introduces a step below it', () => {
    const steps = parseGridColsSteps(RESPONDENT_SPLIT);
    const breakpoints = steps.map((step) => step.breakpoint);

    // Below `lg` the panel is hidden entirely (reviewed via the bottom sheet instead), so no
    // `sm:`/`md:`/unprefixed grid-cols step should exist, and the smallest step present is `lg`.
    expect(breakpoints).not.toContain('sm');
    expect(breakpoints).not.toContain('md');
    expect(breakpoints).toContain('lg');
    // An unprefixed `grid-cols-[` (no breakpoint at all) would apply below every breakpoint,
    // which is exactly the "starts at lg" invariant being violated.
    expect(RESPONDENT_SPLIT).not.toMatch(/(?:^|\s)grid-cols-\[/);
  });

  it('stops the ladder at 2xl — no breakpoint beyond it', () => {
    const steps = parseGridColsSteps(RESPONDENT_SPLIT);
    const breakpoints = new Set(steps.map((step) => step.breakpoint));

    // The container caps at 96rem, so a step past 2xl would only take width off the
    // conversation rather than spend width the shell had actually gained.
    expect(breakpoints).toEqual(new Set(['lg', 'xl', '2xl']));
    expect(RESPONDENT_SPLIT).not.toMatch(/3xl:/);
  });
});
