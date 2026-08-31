/**
 * Unit tests: the optimiser's outcomes.
 *
 * For this feature "something is missing" is the ordinary case, not the exception, so the outcomes
 * carry most of the design and all of the risk:
 *
 *  - **`clean` has to say so out loud.** An admin who presses the button and gets an empty panel
 *    reads a broken feature, not a passing check — and a carefully set-up brand is the common case.
 *  - **an unfixable failure must survive into the answer.** Dropping it lets the admin apply the
 *    other proposals and believe the theme is now readable.
 *  - **no model must not mean no answer.** The arithmetic was never the model's job, so losing it
 *    costs judgement, not correctness — and the admin has to be told which they got.
 *
 * `advise` is mocked because it is the only impure thing here; the audit runs for real, so these
 * assert against genuine colour maths rather than a fixture of it.
 *
 * @see lib/app/questionnaire/brand-contrast/optimise.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAdvise } = vi.hoisted(() => ({ mockAdvise: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-contrast/advise', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/app/questionnaire/brand-contrast/advise')>();
  return { ...actual, advise: mockAdvise };
});

// `auditTheme` runs for real by default (set in beforeEach below) — most tests want genuine colour
// maths. A handful override it to synthesise a finding with NO repairs, because the real ramp
// cannot produce one: at the 3:1 UI threshold the satisfying band is always wide enough to cross
// (see audit.ts's own note). Those tests exist to prove the "unfixable" WIRING is correct for the
// day a stricter pair makes the branch reachable for real — not to claim it happens today.
// `importOriginal`'s result is captured in a hoisted box rather than re-imported afterwards:
// re-importing the module path after mocking it returns the MOCK's live binding (the whole point
// of the mock), so `mockAuditTheme.mockImplementation(auditTheme)` would point the mock at itself
// and recurse forever. `actualAuditThemeBox.current` is the one reference to the real function.
// Boxed as `unknown` rather than typed at declaration: `vi.hoisted`'s factory runs before the
// `import type` below is in scope, so the box cannot reference `auditTheme`'s real type at the
// point it is created. `realAuditTheme` (below) is the one place that casts it back.
const { mockAuditTheme, actualAuditThemeBox } = vi.hoisted(() => {
  const box: { current: unknown } = { current: null };
  return { mockAuditTheme: vi.fn(), actualAuditThemeBox: box };
});
vi.mock('@/lib/app/questionnaire/brand-contrast/audit', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/app/questionnaire/brand-contrast/audit')>();
  actualAuditThemeBox.current = actual.auditTheme;
  return { ...actual, auditTheme: mockAuditTheme };
});

import { optimiseContrast } from '@/lib/app/questionnaire/brand-contrast/optimise';
import { recommendDefault } from '@/lib/app/questionnaire/brand-contrast/advise';
import type {
  AuditedPair,
  auditTheme as AuditThemeFn,
} from '@/lib/app/questionnaire/brand-contrast/audit';
import type { DemoClientTheme } from '@/lib/app/questionnaire/theming';
import type { ContrastPairId } from '@/lib/app/questionnaire/brand-contrast/result';

const realAuditTheme: typeof AuditThemeFn = (theme) =>
  (actualAuditThemeBox.current as typeof AuditThemeFn)(theme);

function theme(over: Partial<DemoClientTheme> = {}): DemoClientTheme {
  return { ctaColor: null, accentColor: null, logoUrl: null, welcomeCopy: null, ...over };
}

/** A finding with no repairs — what `auditTheme` returns for a pair no shade can fix. */
function unfixablePair(pair: ContrastPairId = 'accent-dark'): AuditedPair {
  return {
    finding: {
      pair,
      label: 'Links and highlights in dark mode',
      ground: '#0a0a0a',
      ink: '#0a1a3a',
      ratio: 1.15,
      target: 3,
      onDerivedValue: true,
    },
    repairs: [],
  };
}

/** A cream page with mid-grey ink: two ways to fix it, and both are real. */
const UNREADABLE = theme({ canvasColor: '#fffcf5', inkColor: '#9a9a8f' });

beforeEach(() => {
  mockAdvise.mockReset();
  mockAuditTheme.mockReset();
  mockAuditTheme.mockImplementation(realAuditTheme);
  // The honest default for most tests: the adviser answers, choosing what we recommend anyway.
  mockAdvise.mockImplementation(async ({ audited }) => ({
    proposals: audited.map(recommendDefault),
    degraded: false,
  }));
});

describe('optimiseContrast — a theme that reads', () => {
  it('reports clean, with a sentence rather than an empty panel', async () => {
    const result = await optimiseContrast({ theme: theme() });
    expect(result.outcome).toBe('clean');
    expect(result.proposals).toEqual([]);
    expect(result.summary).toMatch(/clears WCAG AA/i);
  });

  it('does not spend a model call when there is nothing to advise on', async () => {
    await optimiseContrast({ theme: theme() });
    expect(mockAdvise).not.toHaveBeenCalled();
  });
});

describe('optimiseContrast — a theme that does not', () => {
  it('proposes a fix per failing pair', async () => {
    const result = await optimiseContrast({ theme: UNREADABLE });
    expect(result.outcome).toBe('proposed');
    expect(result.proposals.length).toBe(realAuditTheme(UNREADABLE).length);
    expect(result.degraded).toBe(false);
  });

  it('every proposal points at a repair that exists in its own list', async () => {
    const result = await optimiseContrast({ theme: UNREADABLE });
    for (const proposal of result.proposals) {
      expect(proposal.repairs[proposal.chosen]).toBeDefined();
      expect(proposal.repairs[proposal.chosen].ratio).toBeGreaterThanOrEqual(
        proposal.finding.target
      );
    }
  });

  it('says how many, and that the suggestions are shades of the brand’s own colours', async () => {
    const result = await optimiseContrast({ theme: UNREADABLE });
    expect(result.summary).toMatch(/shade of a colour already in the brand/i);
  });

  it('passes the client id through for cost attribution but never loads the row', async () => {
    await optimiseContrast({ theme: UNREADABLE, demoClientId: 'dc-1' });
    expect(mockAdvise).toHaveBeenCalledWith(expect.objectContaining({ demoClientId: 'dc-1' }));
  });
});

describe('optimiseContrast — a wiring the current colour maths cannot reach for real', () => {
  // `auditTheme` is synthesised here rather than driven by a real theme: at the 3:1 UI threshold
  // (and 4.5:1 for text, given the ramp's full black-to-white range) nothing in the shipped pair
  // set is actually unfixable. These tests exist so the day a stricter pair IS added, the
  // `unfixable` outcome, the phrasing, and the mixed proposed+stuck summary are already proven
  // correct rather than discovered wrong in production.

  it('reports outcome unfixable, with no proposals, when nothing can be fixed', async () => {
    mockAuditTheme.mockReturnValue([unfixablePair()]);
    const result = await optimiseContrast({ theme: theme() });

    expect(result.outcome).toBe('unfixable');
    expect(result.proposals).toEqual([]);
    expect(result.unfixable).toHaveLength(1);
    expect(mockAdvise).not.toHaveBeenCalled();
  });

  it('uses the singular phrasing for exactly one unfixable pair', async () => {
    mockAuditTheme.mockReturnValue([unfixablePair()]);
    const result = await optimiseContrast({ theme: theme() });
    expect(result.summary).toBe(
      'One more cannot be fixed by shading alone — it needs a different colour, not a lighter or darker one.'
    );
  });

  it('uses the plural phrasing for more than one', async () => {
    mockAuditTheme.mockReturnValue([unfixablePair('accent-dark'), unfixablePair('accent-light')]);
    const result = await optimiseContrast({ theme: theme() });
    expect(result.summary).toBe(
      '2 more cannot be fixed by shading alone — they need different colours, not lighter or darker ones.'
    );
  });

  it('appends the unfixable tail to a summary that also has real proposals', async () => {
    // The mixed case: some findings are fixed, one is not, and both facts belong in one sentence
    // rather than the stuck one silently vanishing behind the proposed count.
    mockAuditTheme.mockReturnValue([...realAuditTheme(UNREADABLE), unfixablePair()]);
    const result = await optimiseContrast({ theme: UNREADABLE });

    expect(result.outcome).toBe('proposed');
    expect(result.unfixable).toHaveLength(1);
    expect(result.summary).toMatch(/cannot be fixed by shading alone/);
    expect(result.summary).toMatch(/shade of a colour already in the brand/);
  });
});

describe('optimiseContrast — totality', () => {
  // The guarantee that matters, and the one an "unfixable" fixture cannot express: no finding may
  // vanish. A pair that is measured, fails, and then appears in neither bucket would let an admin
  // apply every proposal and believe the theme is now readable.
  //
  // Worth knowing while reading this: the `unfixable` bucket is currently unreachable for real
  // palettes. A tint/shade ramp runs continuously from black to white, and at the 3:1 UI threshold
  // the band of lightnesses that clears both grounds is always wide enough for it to cross. (At
  // 4.5:1 that band is about 0.008 wide, which is why holding the accent to the text threshold made
  // every brand unfixable.) The branch stays because it is the honest answer if a stricter pair is
  // ever added — but it is not asserted through a fixture that pretends to trigger it.
  it.each([
    ['a cream page with grey ink', { canvasColor: '#fffcf5', inkColor: '#9a9a8f' }],
    ['a mid-tone button', { ctaColor: '#7a7a7a' }],
    ['a mid-tone band', { surfaceColor: '#767676' }],
    ['an accent that fails in dark mode', { accentColor: '#0a1a3a' }],
    ['white ink and no canvas', { inkColor: '#ffffff' }],
    ['two mid-greys', { canvasColor: '#808080', inkColor: '#7f7f7f' }],
  ])('accounts for every finding it raised — %s', async (_label, over) => {
    const subject = theme(over);
    const result = await optimiseContrast({ theme: subject });

    const raised = realAuditTheme(subject)
      .map((a) => a.finding.pair)
      .sort();
    const answered = [
      ...result.proposals.map((p) => p.finding.pair),
      ...result.unfixable.map((f) => f.pair),
    ].sort();
    expect(answered).toEqual(raised);
  });

  it('never asks the adviser about a problem with no answers', async () => {
    // It would be handed a numbered list with nothing in it, and any index it returned would be
    // out of range — a guaranteed fallback dressed up as a model call.
    await optimiseContrast({ theme: UNREADABLE });
    for (const pair of mockAdvise.mock.calls[0][0].audited) {
      expect(pair.repairs.length).toBeGreaterThan(0);
    }
  });
});

describe('optimiseContrast — no adviser', () => {
  it('still answers, ranked by how little the brand moves', async () => {
    mockAdvise.mockRejectedValue(new Error('Brand contrast adviser is not seeded'));
    const result = await optimiseContrast({ theme: UNREADABLE });

    expect(result.outcome).toBe('proposed');
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.proposals.every((p) => p.chosen === 0)).toBe(true);
  });

  it('marks itself degraded and says so in words the admin will read', async () => {
    // An admin accepting a suggestion is entitled to know whether it was considered or merely the
    // arithmetically smallest option. A badge alone would not carry that.
    mockAdvise.mockRejectedValue(new Error('no provider configured'));
    const result = await optimiseContrast({ theme: UNREADABLE });

    expect(result.degraded).toBe(true);
    expect(result.summary).toMatch(/no ai adviser was available/i);
  });

  it('every proposal is still a real, proved repair', async () => {
    mockAdvise.mockRejectedValue(new Error('boom'));
    const result = await optimiseContrast({ theme: UNREADABLE });
    for (const proposal of result.proposals) {
      const repair = proposal.repairs[proposal.chosen];
      expect(repair.ratio).toBeGreaterThanOrEqual(proposal.finding.target);
      expect(proposal.rationale.length).toBeGreaterThan(20);
    }
  });
});
