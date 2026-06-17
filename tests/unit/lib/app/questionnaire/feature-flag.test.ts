import { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  APP_QUESTIONNAIRES_FLAG,
  APP_QUESTIONNAIRES_ADAPTIVE_FLAG,
  APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG,
  APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG,
  APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG,
  APP_QUESTIONNAIRES_COMPLETION_FLAG,
  APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG,
  APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
  APP_QUESTIONNAIRES_VOICE_INPUT_FLAG,
  APP_QUESTIONNAIRES_COST_CAP_FLAG,
  APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG,
  APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG,
  APP_QUESTIONNAIRES_DATA_SLOTS_FLAG,
  APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG,
  ensureQuestionnairesEnabled,
  ensureLiveSessionsEnabled,
  ensureVoiceInputEnabled,
  withQuestionnairesEnabled,
  withLiveSessionsEnabled,
  withVoiceInputEnabled,
  isQuestionnairesEnabled,
  isAdaptiveSelectionEnabled,
  isAnswerExtractionEnabled,
  isContradictionDetectionEnabled,
  isAnswerRefinementEnabled,
  isCompletionEnabled,
  isDesignEvaluationEnabled,
  isLiveSessionsEnabled,
  isVoiceInputEnabled,
  isAttachmentInputEnabled,
  isCostCapEnforcementEnabled,
  isQuestionPhrasingEnabled,
  isDataSlotsEnabled,
  isAdaptiveDataSlotSelectionEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { isFeatureEnabled } from '@/lib/feature-flags';

vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(),
}));

const mockedIsFeatureEnabled = vi.mocked(isFeatureEnabled);

/**
 * Drive {@link isFeatureEnabled} from a per-flag map: a flag is enabled iff its name maps
 * to `true`. The resolvers call `isFeatureEnabled(name)` (often in a `Promise.all`), so this
 * lets each test set exactly which flags are on and assert the resolver's AND logic.
 */
function setFlags(enabled: Record<string, boolean>): void {
  mockedIsFeatureEnabled.mockImplementation((name: string) =>
    Promise.resolve(enabled[name] === true)
  );
}

/** All questionnaire flag names, used to build "everything on" baselines. */
const ALL_FLAGS = [
  APP_QUESTIONNAIRES_FLAG,
  APP_QUESTIONNAIRES_ADAPTIVE_FLAG,
  APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG,
  APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG,
  APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG,
  APP_QUESTIONNAIRES_COMPLETION_FLAG,
  APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG,
  APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
  APP_QUESTIONNAIRES_VOICE_INPUT_FLAG,
  APP_QUESTIONNAIRES_COST_CAP_FLAG,
  APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG,
  APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG,
  APP_QUESTIONNAIRES_DATA_SLOTS_FLAG,
  APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG,
] as const;

/** A map with every flag on (the baseline each truth-table test perturbs from). */
function allOn(): Record<string, boolean> {
  return Object.fromEntries(ALL_FLAGS.map((f) => [f, true]));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('questionnaire feature flag — flag names are stable', () => {
  // The seed and any external toggling rely on the exact `feature_flag` row names; guard
  // them so a rename can't silently dark-launch (or un-gate) a surface.
  it('master + sub-flag names match their published constants', () => {
    expect(APP_QUESTIONNAIRES_FLAG).toBe('APP_QUESTIONNAIRES_ENABLED');
    expect(APP_QUESTIONNAIRES_ADAPTIVE_FLAG).toBe('APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED');
    expect(APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG).toBe(
      'APP_QUESTIONNAIRES_ANSWER_EXTRACTION_ENABLED'
    );
    expect(APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG).toBe(
      'APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_ENABLED'
    );
    expect(APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG).toBe(
      'APP_QUESTIONNAIRES_ANSWER_REFINEMENT_ENABLED'
    );
    expect(APP_QUESTIONNAIRES_COMPLETION_FLAG).toBe('APP_QUESTIONNAIRES_COMPLETION_ENABLED');
    expect(APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG).toBe(
      'APP_QUESTIONNAIRES_DESIGN_EVALUATION_ENABLED'
    );
    expect(APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG).toBe('APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED');
    expect(APP_QUESTIONNAIRES_VOICE_INPUT_FLAG).toBe('APP_QUESTIONNAIRES_VOICE_INPUT_ENABLED');
    expect(APP_QUESTIONNAIRES_COST_CAP_FLAG).toBe('APP_QUESTIONNAIRES_COST_CAP_ENABLED');
    expect(APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG).toBe(
      'APP_QUESTIONNAIRES_ATTACHMENT_INPUT_ENABLED'
    );
    expect(APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG).toBe(
      'APP_QUESTIONNAIRES_QUESTION_PHRASING_ENABLED'
    );
    expect(APP_QUESTIONNAIRES_DATA_SLOTS_FLAG).toBe('APP_QUESTIONNAIRES_DATA_SLOTS_ENABLED');
  });
});

describe('isQuestionnairesEnabled (master)', () => {
  it('delegates to isFeatureEnabled with the master flag', async () => {
    setFlags({ [APP_QUESTIONNAIRES_FLAG]: true });
    await expect(isQuestionnairesEnabled()).resolves.toBe(true);
    expect(mockedIsFeatureEnabled).toHaveBeenCalledWith(APP_QUESTIONNAIRES_FLAG);
  });

  it('returns false when the master flag is disabled', async () => {
    setFlags({ [APP_QUESTIONNAIRES_FLAG]: false });
    await expect(isQuestionnairesEnabled()).resolves.toBe(false);
  });
});

/**
 * The data-driven truth table for every sub-flag resolver: each is `true` only when ALL its
 * required flags are on, and `false` when ANY one of them is off. `requires` lists the flags
 * the resolver AND's together (master first, then any parents, then its own sub-flag).
 */
const SUB_FLAG_RESOLVERS: ReadonlyArray<{
  name: string;
  fn: () => Promise<boolean>;
  requires: readonly string[];
}> = [
  {
    name: 'isAdaptiveSelectionEnabled',
    fn: isAdaptiveSelectionEnabled,
    requires: [APP_QUESTIONNAIRES_FLAG, APP_QUESTIONNAIRES_ADAPTIVE_FLAG],
  },
  {
    name: 'isAnswerExtractionEnabled',
    fn: isAnswerExtractionEnabled,
    requires: [APP_QUESTIONNAIRES_FLAG, APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG],
  },
  {
    name: 'isContradictionDetectionEnabled',
    fn: isContradictionDetectionEnabled,
    requires: [APP_QUESTIONNAIRES_FLAG, APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG],
  },
  {
    name: 'isAnswerRefinementEnabled',
    fn: isAnswerRefinementEnabled,
    requires: [APP_QUESTIONNAIRES_FLAG, APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG],
  },
  {
    name: 'isCompletionEnabled',
    fn: isCompletionEnabled,
    requires: [APP_QUESTIONNAIRES_FLAG, APP_QUESTIONNAIRES_COMPLETION_FLAG],
  },
  {
    name: 'isDesignEvaluationEnabled',
    fn: isDesignEvaluationEnabled,
    requires: [APP_QUESTIONNAIRES_FLAG, APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG],
  },
  {
    name: 'isLiveSessionsEnabled',
    fn: isLiveSessionsEnabled,
    requires: [APP_QUESTIONNAIRES_FLAG, APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG],
  },
  {
    // Live-dependent: master + live-sessions + its own sub-flag.
    name: 'isVoiceInputEnabled',
    fn: isVoiceInputEnabled,
    requires: [
      APP_QUESTIONNAIRES_FLAG,
      APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
      APP_QUESTIONNAIRES_VOICE_INPUT_FLAG,
    ],
  },
  {
    name: 'isAttachmentInputEnabled',
    fn: isAttachmentInputEnabled,
    requires: [
      APP_QUESTIONNAIRES_FLAG,
      APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
      APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG,
    ],
  },
  {
    name: 'isCostCapEnforcementEnabled',
    fn: isCostCapEnforcementEnabled,
    requires: [
      APP_QUESTIONNAIRES_FLAG,
      APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
      APP_QUESTIONNAIRES_COST_CAP_FLAG,
    ],
  },
  {
    name: 'isQuestionPhrasingEnabled',
    fn: isQuestionPhrasingEnabled,
    requires: [
      APP_QUESTIONNAIRES_FLAG,
      APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
      APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG,
    ],
  },
  {
    // Master-only child (admin generation happens at authoring time, before any session) —
    // unlike the live-dependent trio, data slots don't require the live-sessions flag here.
    name: 'isDataSlotsEnabled',
    fn: isDataSlotsEnabled,
    requires: [APP_QUESTIONNAIRES_FLAG, APP_QUESTIONNAIRES_DATA_SLOTS_FLAG],
  },
  {
    // Depends on data-slots AND live-sessions (only runs in live data-slot mode), plus its own
    // paid sub-flag — the AND of four flags.
    name: 'isAdaptiveDataSlotSelectionEnabled',
    fn: isAdaptiveDataSlotSelectionEnabled,
    requires: [
      APP_QUESTIONNAIRES_FLAG,
      APP_QUESTIONNAIRES_DATA_SLOTS_FLAG,
      APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
      APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG,
    ],
  },
];

describe('sub-flag resolvers — truth tables', () => {
  for (const { name, fn, requires } of SUB_FLAG_RESOLVERS) {
    describe(name, () => {
      it('is true when all required flags are on', async () => {
        setFlags(Object.fromEntries(requires.map((f) => [f, true])));
        await expect(fn()).resolves.toBe(true);
      });

      // One test per required flag: that flag off, every other required flag on → false.
      for (const off of requires) {
        const label =
          off === APP_QUESTIONNAIRES_FLAG
            ? 'master'
            : off === APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG
              ? 'live-sessions'
              : 'its own sub-flag';
        it(`is false when ${label} (${off}) is off`, async () => {
          const flags = Object.fromEntries(requires.map((f) => [f, true]));
          flags[off] = false;
          setFlags(flags);
          await expect(fn()).resolves.toBe(false);
        });
      }
    });
  }
});

describe('sub-flag independence — one flag off suppresses only its own surface', () => {
  // Turning a single sub-flag off must NOT affect any sibling resolver. We flip each
  // sub-flag off (master + everything else on) and assert exactly that resolver goes false
  // while the others stay true — the "rest of the platform unaffected" guarantee.
  const INDEPENDENT_PAIRS: ReadonlyArray<{
    flag: string;
    resolver: () => Promise<boolean>;
  }> = [
    { flag: APP_QUESTIONNAIRES_ADAPTIVE_FLAG, resolver: isAdaptiveSelectionEnabled },
    { flag: APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG, resolver: isAnswerExtractionEnabled },
    {
      flag: APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG,
      resolver: isContradictionDetectionEnabled,
    },
    { flag: APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG, resolver: isAnswerRefinementEnabled },
    { flag: APP_QUESTIONNAIRES_COMPLETION_FLAG, resolver: isCompletionEnabled },
    { flag: APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG, resolver: isDesignEvaluationEnabled },
    { flag: APP_QUESTIONNAIRES_VOICE_INPUT_FLAG, resolver: isVoiceInputEnabled },
    { flag: APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG, resolver: isAttachmentInputEnabled },
    { flag: APP_QUESTIONNAIRES_COST_CAP_FLAG, resolver: isCostCapEnforcementEnabled },
    { flag: APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG, resolver: isQuestionPhrasingEnabled },
    { flag: APP_QUESTIONNAIRES_DATA_SLOTS_FLAG, resolver: isDataSlotsEnabled },
    {
      flag: APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG,
      resolver: isAdaptiveDataSlotSelectionEnabled,
    },
  ];

  for (const { flag, resolver } of INDEPENDENT_PAIRS) {
    it(`${flag} off → that resolver false, every sibling still true`, async () => {
      const flags = allOn();
      flags[flag] = false;
      setFlags(flags);

      await expect(resolver()).resolves.toBe(false);

      // Every OTHER sub-flag resolver whose required flags are all still on stays true.
      for (const sibling of SUB_FLAG_RESOLVERS) {
        if (sibling.requires.includes(flag)) continue;
        await expect(sibling.fn(), `${sibling.name} should be unaffected`).resolves.toBe(true);
      }
    });
  }

  it('adaptive degrades independently of extraction (both are master-only children)', async () => {
    // Concrete independence example: adaptive off, extraction on.
    setFlags({
      [APP_QUESTIONNAIRES_FLAG]: true,
      [APP_QUESTIONNAIRES_ADAPTIVE_FLAG]: false,
      [APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG]: true,
    });
    await expect(isAdaptiveSelectionEnabled()).resolves.toBe(false);
    await expect(isAnswerExtractionEnabled()).resolves.toBe(true);
  });
});

describe('live-sessions cascade — turning the parent off closes the live-dependent group', () => {
  it('live-sessions off ⇒ voice, attachment, cost-cap, and phrasing all false even with their sub-flags on', async () => {
    const flags = allOn();
    flags[APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG] = false;
    setFlags(flags);

    await expect(isLiveSessionsEnabled()).resolves.toBe(false);
    await expect(isVoiceInputEnabled()).resolves.toBe(false);
    await expect(isAttachmentInputEnabled()).resolves.toBe(false);
    await expect(isCostCapEnforcementEnabled()).resolves.toBe(false);
    await expect(isQuestionPhrasingEnabled()).resolves.toBe(false);
  });

  it('master off ⇒ every resolver false (transitive close)', async () => {
    const flags = allOn();
    flags[APP_QUESTIONNAIRES_FLAG] = false;
    setFlags(flags);

    await expect(isQuestionnairesEnabled()).resolves.toBe(false);
    for (const { name, fn } of SUB_FLAG_RESOLVERS) {
      // Label the assertion so a single regressing resolver is named rather than
      // hidden behind whichever one the sequential loop reaches first.
      await expect(fn(), `${name} should be false when master is off`).resolves.toBe(false);
    }
  });
});

/**
 * Route-level gates: the `ensure*` wrappers a route calls first (before auth) so a disabled
 * surface 404s rather than 401s. Per-route gating is additionally covered by each route's own
 * `route.test.ts`; these pin the shared gate helpers' contract.
 */
describe('route gates — ensure* return a 404 envelope when off, null when on', () => {
  async function expect404(res: Response | null): Promise<void> {
    expect(res).not.toBeNull();
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(404);
    const body = await res?.json();
    expect(body).toEqual({ success: false, error: { message: 'Not found', code: 'NOT_FOUND' } });
  }

  describe('ensureQuestionnairesEnabled', () => {
    it('returns null (no gate) when the master flag is on', async () => {
      setFlags({ [APP_QUESTIONNAIRES_FLAG]: true });
      await expect(ensureQuestionnairesEnabled()).resolves.toBeNull();
    });
    it('returns a 404 NOT_FOUND envelope when the master flag is off', async () => {
      setFlags({ [APP_QUESTIONNAIRES_FLAG]: false });
      await expect404(await ensureQuestionnairesEnabled());
    });
  });

  describe('ensureLiveSessionsEnabled', () => {
    it('returns null when master + live-sessions are on', async () => {
      setFlags({
        [APP_QUESTIONNAIRES_FLAG]: true,
        [APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG]: true,
      });
      await expect(ensureLiveSessionsEnabled()).resolves.toBeNull();
    });
    it('404s when live-sessions is off even though master is on', async () => {
      setFlags({
        [APP_QUESTIONNAIRES_FLAG]: true,
        [APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG]: false,
      });
      await expect404(await ensureLiveSessionsEnabled());
    });
  });

  describe('ensureVoiceInputEnabled', () => {
    it('returns null when master + live-sessions + voice are on', async () => {
      setFlags({
        [APP_QUESTIONNAIRES_FLAG]: true,
        [APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG]: true,
        [APP_QUESTIONNAIRES_VOICE_INPUT_FLAG]: true,
      });
      await expect(ensureVoiceInputEnabled()).resolves.toBeNull();
    });
    it('404s when the voice sub-flag is off even though master + live-sessions are on', async () => {
      setFlags({
        [APP_QUESTIONNAIRES_FLAG]: true,
        [APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG]: true,
        [APP_QUESTIONNAIRES_VOICE_INPUT_FLAG]: false,
      });
      await expect404(await ensureVoiceInputEnabled());
    });
    it('404s when live-sessions is off even though master + voice are on', async () => {
      // Voice is a three-way AND (master + live-sessions + voice); turning the live-sessions
      // parent off must close the gate too, not just the voice sub-flag.
      setFlags({
        [APP_QUESTIONNAIRES_FLAG]: true,
        [APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG]: false,
        [APP_QUESTIONNAIRES_VOICE_INPUT_FLAG]: true,
      });
      await expect404(await ensureVoiceInputEnabled());
    });
  });
});

/**
 * The `with*Enabled` HOC wrappers compose the flag gate with a route handler so the gate runs
 * **before** anything else (auth, handler work) — the ordering that makes a disabled surface
 * look like a missing route (404) rather than a 401. Each wrapper must (a) short-circuit to the
 * gate's 404 Response without ever calling the handler when the flag is off, and (b) call the
 * handler with the original `(request, context)` and forward its Response when the flag is on.
 * These pin both arms; per-route wiring is additionally covered by each route's own test.
 */
describe('with* gate wrappers — run the flag gate before the handler', () => {
  const request = new NextRequest('http://localhost:3000/api/v1/app/test');
  const context = { params: Promise.resolve({}) };

  type GateWrapper = <C>(
    handler: (request: NextRequest, context: C) => Promise<Response>
  ) => (request: NextRequest, context: C) => Promise<Response>;

  const WRAPPERS: ReadonlyArray<{
    name: string;
    wrap: GateWrapper;
    // Flags that must ALL be on for the gate to allow the handler through.
    enableFlags: readonly string[];
    // The flag to turn off (others on) to prove the gate blocks before the handler.
    blockFlag: string;
  }> = [
    {
      name: 'withQuestionnairesEnabled',
      wrap: withQuestionnairesEnabled,
      enableFlags: [APP_QUESTIONNAIRES_FLAG],
      blockFlag: APP_QUESTIONNAIRES_FLAG,
    },
    {
      name: 'withLiveSessionsEnabled',
      wrap: withLiveSessionsEnabled,
      enableFlags: [APP_QUESTIONNAIRES_FLAG, APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG],
      blockFlag: APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
    },
    {
      name: 'withVoiceInputEnabled',
      wrap: withVoiceInputEnabled,
      enableFlags: [
        APP_QUESTIONNAIRES_FLAG,
        APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
        APP_QUESTIONNAIRES_VOICE_INPUT_FLAG,
      ],
      blockFlag: APP_QUESTIONNAIRES_VOICE_INPUT_FLAG,
    },
  ];

  for (const { name, wrap, enableFlags, blockFlag } of WRAPPERS) {
    describe(name, () => {
      it('calls the handler with the original request + context and forwards its Response when enabled', async () => {
        setFlags(Object.fromEntries(enableFlags.map((f) => [f, true])));
        const handlerResponse = new Response('ok');
        const handler = vi.fn(
          async (_request: NextRequest, _context: { params: Promise<Record<string, string>> }) =>
            handlerResponse
        );

        const result = await wrap(handler)(request, context);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(request, context);
        expect(result).toBe(handlerResponse);
      });

      it('short-circuits to a 404 and never calls the handler when the gate flag is off', async () => {
        const flags = Object.fromEntries(enableFlags.map((f) => [f, true]));
        flags[blockFlag] = false;
        setFlags(flags);
        const handler = vi.fn(
          async (_request: NextRequest, _context: { params: Promise<Record<string, string>> }) =>
            new Response('ok')
        );

        const result = await wrap(handler)(request, context);

        expect(handler).not.toHaveBeenCalled();
        expect(result.status).toBe(404);
      });
    });
  }
});
