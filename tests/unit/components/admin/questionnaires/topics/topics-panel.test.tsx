/**
 * Unit tests: `TopicsPanel` — the Conditional topics tab's client shell.
 *
 * The panel renders no controls of its own; every card below it has its own test file. What it *owns*
 * is the wiring between them, and each strand of that wiring is a decision the module header defends:
 *
 * - **Two saves, two endpoints.** The topic set is a `PUT` that replaces the set; the settings are a
 *   `PATCH` of one blob. Merging them would mean an admin fixing one topic typo also rewrites their
 *   rules, and a partial failure would leave them unable to tell which half landed.
 * - **The settings body is enumerated, never spread.** `rules` reaches the server through the same
 *   PATCH but is edited as its own list, and a spread would push through any field the settings card
 *   does not own. The cost of that choice is that a new field is a two-place change — which is exactly
 *   the kind of omission a test catches and a type does not.
 * - **Fork-on-launch discipline.** A forked save shows the notice and redirects to the new draft; a
 *   *declined* fork (`ForkCancelledError`) writes nothing, shows no error, and resyncs.
 * - **The focus nonce.** "Edit this topic" on the routing map must move the list even when the same
 *   topic is asked for twice — a bare key would be unchanged state and the editor's effect would
 *   never re-fire.
 * - **The seed nonce (F17.20).** "Turn into topic" on a Routing Analyst gap carries the same nonce
 *   shape, for the same reason: turning a second gap into a topic must add a second row even if the
 *   panel has nothing else to distinguish the two requests by.
 *
 * The children are stubbed down to the callbacks the panel hands them, so what is asserted here is the
 * panel's own behaviour rather than a second rendering of six cards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { routerMock, authoringMutateMock } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() },
  authoringMutateMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  // `useScopeTabs` reads the initial tab through this rather than `window.location`, so that the
  // server render and the first client render agree — the panel IS server-rendered, and a
  // `window`-based read would hydrate a different tab than it shipped. Backed by the live URL so
  // the deep-link tests can drive it with `history.replaceState` exactly as a real link would.
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock('@/components/admin/questionnaires/authoring-mutate', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/admin/questionnaires/authoring-mutate')
  >('@/components/admin/questionnaires/authoring-mutate');
  return { ...actual, authoringMutate: authoringMutateMock };
});

// The cards are stubbed to the callbacks the panel hands them. Each has its own test file.
vi.mock('@/components/admin/questionnaires/topics/routing-analyst-card', () => ({
  RoutingAnalystCard: ({
    candidacy,
    autoTriggerPending,
    runRequest,
    onRunHandled,
    onTurnGapIntoTopic,
  }: {
    candidacy: { isCandidate: boolean } | null;
    autoTriggerPending: boolean;
    runRequest?: { nonce: number } | null;
    onRunHandled?: () => void;
    onTurnGapIntoTopic?: (gap: { sourceQuote: string; explanation: string }) => void;
  }) => (
    <div
      data-testid="analyst-card"
      data-is-candidate={candidacy?.isCandidate ?? ''}
      data-auto-trigger-pending={autoTriggerPending}
      data-run-nonce={runRequest?.nonce ?? ''}
    >
      <button
        type="button"
        data-testid="turn-gap-into-topic"
        onClick={() => onTurnGapIntoTopic?.(GAP_FIXTURE)}
      >
        Turn into topic
      </button>
      <button type="button" data-testid="ack-run" onClick={() => onRunHandled?.()}>
        ack
      </button>
    </div>
  ),
}));
vi.mock('@/components/admin/questionnaires/topics/plan-preview-card', () => ({
  PlanPreviewCard: () => <div data-testid="preview-card" />,
}));
vi.mock('@/components/admin/questionnaires/topics/routing-quality-card', () => ({
  RoutingQualityCard: ({ conditionalCount }: { conditionalCount: number }) => (
    <div data-testid="quality-card" data-conditional-count={conditionalCount} />
  ),
}));
vi.mock('@/components/admin/questionnaires/topics/scope-issues', () => ({
  ScopeIssues: () => <div data-testid="scope-issues" />,
}));
vi.mock('@/components/admin/questionnaires/topics/routing-map-dialog', () => ({
  RoutingMapDialog: ({
    onEditTopic,
    disabled,
  }: {
    onEditTopic: (key: string) => void;
    disabled: boolean;
  }) => (
    <button
      type="button"
      data-testid="routing-map"
      disabled={disabled}
      onClick={() => onEditTopic('pricing')}
    >
      Decision flow
    </button>
  ),
}));
vi.mock('@/components/admin/questionnaires/topics/scope-settings-card', () => ({
  ScopeSettingsCard: ({
    onSave,
    busy,
  }: {
    onSave: (s: unknown) => Promise<boolean>;
    busy: boolean;
  }) => (
    <button
      type="button"
      data-testid="save-settings"
      disabled={busy}
      onClick={() => void onSave(SETTINGS_FIXTURE)}
    >
      Save settings
    </button>
  ),
}));
vi.mock('@/components/admin/questionnaires/topics/topic-list-editor', () => ({
  TopicListEditor: ({
    onSave,
    busy,
    focusTopic,
    onFocusHandled,
    seedTopic,
    onSeedHandled,
    active,
  }: {
    onSave: (t: unknown[]) => Promise<boolean>;
    busy: boolean;
    focusTopic: { key: string; nonce: number } | null;
    onFocusHandled?: () => void;
    seedTopic?: { description: string; criteria: string; nonce: number } | null;
    onSeedHandled?: () => void;
    active?: boolean;
  }) => (
    <div data-testid="topic-list" data-active={String(active ?? true)}>
      <div
        data-testid="focus"
        data-key={focusTopic?.key ?? ''}
        data-nonce={focusTopic?.nonce ?? ''}
      />
      {/* Stands in for the real editor's effect, which reports once it has acted on a request. */}
      <button type="button" data-testid="focus-handled" onClick={() => onFocusHandled?.()}>
        handled
      </button>
      <div
        data-testid="seed"
        data-description={seedTopic?.description ?? ''}
        data-criteria={seedTopic?.criteria ?? ''}
        data-nonce={seedTopic?.nonce ?? ''}
      />
      <button type="button" data-testid="seed-handled" onClick={() => onSeedHandled?.()}>
        seed handled
      </button>
      <button
        type="button"
        data-testid="save-topics"
        disabled={busy}
        onClick={() => void onSave(DRAFTS_FIXTURE)}
      >
        Save topics
      </button>
    </div>
  ),
}));

// Imported after the mocks, which vitest hoists above them.
import { TopicsPanel } from '@/components/admin/questionnaires/topics/topics-panel';
import { ForkCancelledError } from '@/components/admin/questionnaires/authoring-mutate';
import {
  DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  type ConditionalTopicsSettings,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import { EMPTY_TOPICS_PAYLOAD, type TopicsPayload } from '@/lib/app/questionnaire/scope/views';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ENDPOINT = '/api/v1/app/questionnaires/q1/versions/v1/topics';

/** The gap the stubbed analyst card's "Turn into topic" button acts on. */
const GAP_FIXTURE = {
  sourceQuote: 'Use judgement for respondents outside these categories.',
  explanation: 'Too vague to test mechanically — no data slot captures "judgement".',
};

/**
 * A settings blob with every field set to something other than its default, so a field the panel
 * forgets to enumerate shows up as a missing key rather than as a coincidentally-equal value.
 */
const SETTINGS_FIXTURE: ConditionalTopicsSettings = {
  ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  enabled: true,
  maxConditionalTopics: 5,
  sessionBudgetSeconds: 900,
  secondsPerQuestionType: { text: 30 },
  secondsPerDataSlot: 20,
  includeCheckTopic: false,
  checkTopicPreference: ['pricing'],
  minConfidence: 0.8,
  fallbackTopicKeys: ['management'],
  announce: false,
  allowRespondentAmendment: false,
  plannerInstructions: 'prefer breadth',
  limitOpeningProbes: true,
  maxOpeningProbes: 2,
  rules: [
    {
      id: 'r1',
      dataSlotKey: 'licence',
      operator: 'not_exists',
      value: '',
      action: 'exclude',
      topicKey: 'audit',
      ordinal: 0,
    },
  ],
};

/** Drafts carrying the whitespace and blanks the panel is responsible for normalising. */
const DRAFTS_FIXTURE = [
  {
    clientId: 'c1',
    key: '  pricing  ',
    label: '  Pricing  ',
    description: '   ',
    phase: 'conditional' as const,
    criteria: '  when it applies  ',
    depth: 'full' as const,
    questionKeys: ['q_a'],
    dataSlotKeys: ['s_a'],
    source: 'manual' as const,
  },
];

function topic(key: string, phase: Topic['phase']): Topic {
  return {
    id: `t-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it applies' : null,
    depth: 'full',
    members: { questionKeys: [], dataSlotKeys: [] },
    ordinal: 0,
    source: 'manual',
  };
}

function payload(overrides: Partial<TopicsPayload> = {}): TopicsPayload {
  return {
    ...EMPTY_TOPICS_PAYLOAD,
    topics: [topic('open', 'opening'), topic('pricing', 'conditional')],
    settings: { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: true },
    ...overrides,
  };
}

function renderPanel(p: TopicsPayload = payload()) {
  return render(<TopicsPanel questionnaireId="q1" versionId="v1" payload={p} />);
}

/** The `(method, path, body)` triple of the last mutation. */
function lastMutation() {
  const call = authoringMutateMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return { method: call![0], path: call![1], body: call![2] };
}

beforeEach(() => {
  vi.clearAllMocks();
  authoringMutateMock.mockResolvedValue({ data: {}, meta: null });
  // The sub-tabs write `?tab=` with `history.replaceState`, which is GLOBAL — jsdom keeps one URL
  // for the whole file, so without this a test that switched tabs leaks its query into every test
  // after it. Found the hard way: the fork-redirect assertion started seeing a `?tab=` it never
  // set, from a click three describes earlier.
  window.history.replaceState(null, '', '/admin/questionnaires/q1/v/v1/topics');
});

/* -------------------------------------------------------------------------- */
/* Saving topics                                                              */
/* -------------------------------------------------------------------------- */

describe('TopicsPanel — saving the topic set', () => {
  it('PUTs the topic set to the topics endpoint', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    await waitFor(() => expect(authoringMutateMock).toHaveBeenCalled());
    expect(lastMutation().method).toBe('PUT');
    expect(lastMutation().path).toBe(ENDPOINT);
  });

  it('trims every text field and sends blanks as null, not as empty strings', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    await waitFor(() => expect(authoringMutateMock).toHaveBeenCalled());
    expect(lastMutation().body).toEqual({
      topics: [
        {
          key: 'pricing',
          label: 'Pricing',
          description: null,
          phase: 'conditional',
          criteria: 'when it applies',
          depth: 'full',
          questionKeys: ['q_a'],
          dataSlotKeys: ['s_a'],
        },
      ],
    });
  });

  it('does not send the client-only fields the editor uses to track rows', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    await waitFor(() => expect(authoringMutateMock).toHaveBeenCalled());
    const [sent] = (lastMutation().body as { topics: Record<string, unknown>[] }).topics;
    expect(sent).not.toHaveProperty('clientId');
    expect(sent).not.toHaveProperty('source');
  });
});

/* -------------------------------------------------------------------------- */
/* Saving settings                                                            */
/* -------------------------------------------------------------------------- */

describe('TopicsPanel — the status header owns the master switch', () => {
  const headerSwitch = () => document.getElementById('scope-status-enabled') as HTMLElement;

  it('PATCHes `enabled` ALONE, so the merge cannot touch a sibling', async () => {
    const user = userEvent.setup();
    renderPanel(payload({ settings: { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: false } }));

    await user.click(headerSwitch());

    await waitFor(() => expect(authoringMutateMock).toHaveBeenCalled());
    expect(lastMutation().method).toBe('PATCH');
    // The server side is a read-merge-write over a schema whose every field is optional, so a
    // lone-field body is the shape most likely to expose a regression there. It is pinned in
    // `topic-routes.test.ts`; this pins that the header actually sends one.
    expect(lastMutation().body).toEqual({ enabled: true });
  });

  it('renders the server value, so a declined fork leaves the switch where it was', async () => {
    const user = userEvent.setup();
    authoringMutateMock.mockRejectedValue(new ForkCancelledError());
    renderPanel(payload({ settings: { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: false } }));

    await user.click(headerSwitch());

    // Nothing was written, so nothing should look written. A locally-drafted switch would sit in
    // the clicked position describing a version that never existed.
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
    expect(headerSwitch()).not.toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("reports the version's coverage, not a count it derived itself", () => {
    renderPanel(
      payload({
        coverage: {
          totalQuestions: 10,
          uncoveredQuestions: 3,
          totalDataSlots: 0,
          uncoveredDataSlots: 0,
        },
      })
    );

    expect(screen.getByText(/questions in no topic/i)).toBeInTheDocument();
  });
});

describe('TopicsPanel — the routing map reaches the editor from any tab', () => {
  it('switches to Topics as part of opening a topic', async () => {
    // The map trigger sits above the tabs and is reachable from all three. Between the sub-tabs
    // landing and this being fixed, "Edit this topic" from the Rules tab did nothing visible —
    // and left a request that fired later, as an unexplained jump.
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Rules & limits' }));
    await user.click(screen.getByTestId('routing-map'));

    expect(screen.getByRole('tab', { name: 'Topics' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('focus')).toHaveAttribute('data-key', 'pricing');
    // And the editor is live, so the request is acted on rather than parked.
    expect(screen.getByTestId('topic-list')).toHaveAttribute('data-active', 'true');
  });
});

describe('TopicsPanel — the three sub-tabs', () => {
  it('opens on Topics', () => {
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Topics' })).toHaveAttribute('data-state', 'active');
  });

  it('opens on the tab named by `?tab=`', () => {
    window.history.replaceState(null, '', '/admin/questionnaires/q1/v/v1/topics?tab=check');
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Check' })).toHaveAttribute('data-state', 'active');
  });

  it('falls back to Topics on a `?tab=` nobody recognises', () => {
    // The query survives being pasted, bookmarked and hand-edited, so it can be anything.
    window.history.replaceState(null, '', '/admin/questionnaires/q1/v/v1/topics?tab=nonsense');
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Topics' })).toHaveAttribute('data-state', 'active');
  });

  it('writes the tab to the URL without a router navigation', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Rules & limits' }));

    expect(new URL(window.location.href).searchParams.get('tab')).toBe('rules');
    // The whole reason this hook exists rather than `useUrlTabs`: `router.replace` here would be
    // a full RSC round-trip re-running the loaders to render markup that did not change, and
    // could drop the subtree into the parent segment's Suspense fallback — unmounting the
    // in-flight analyst run and every unsaved draft the split exists to preserve.
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it('keeps every panel mounted so a switch cannot discard work in progress', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Check' }));

    // The topic editor is on the Topics tab and is now hidden — but still in the DOM. Radix would
    // unmount it without `forceMount`, taking the admin's unsaved topic drafts with it.
    expect(screen.getByTestId('topic-list')).toBeInTheDocument();
    expect(screen.getByTestId('analyst-card')).toBeInTheDocument();
  });

  it('tells the topic editor when its own tab is not the one showing', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByTestId('topic-list')).toHaveAttribute('data-active', 'true');

    await user.click(screen.getByRole('tab', { name: 'Rules & limits' }));

    // A mounted-but-hidden editor still commits effects. Without this the focus and seed handoffs
    // would be spent against a node with no layout — see F17.24.
    expect(screen.getByTestId('topic-list')).toHaveAttribute('data-active', 'false');
  });
});

describe('TopicsPanel — the issue strip', () => {
  it("drives the topic-list focus handoff, reusing the map's mechanism", async () => {
    const user = userEvent.setup();
    renderPanel(
      payload({
        issues: [
          {
            severity: 'error',
            code: 'conditional_without_criteria',
            topicKey: 'pricing',
            message: 'Pricing is conditional but has no criteria.',
          },
        ],
      })
    );

    await user.click(screen.getByRole('button', { name: /Pricing is conditional/i }));

    // Same nonce shape the routing map produces: a finding about a topic and a map node about a
    // topic want the identical thing to happen, so they ask for it the identical way.
    expect(screen.getByTestId('focus')).toHaveAttribute('data-key', 'pricing');
    expect(screen.getByTestId('focus')).toHaveAttribute('data-nonce', '1');
    // And it lands on the tab that owns the fix, not just anywhere.
    expect(screen.getByRole('tab', { name: 'Topics' })).toHaveAttribute('data-state', 'active');
  });

  it('sends a rule-shaped finding to Rules & limits', async () => {
    const user = userEvent.setup();
    renderPanel(
      payload({
        issues: [
          {
            severity: 'error',
            code: 'rule_unknown_topic',
            topicKey: 'gone',
            message: 'A rule points at a topic that no longer exists.',
          },
        ],
      })
    );

    await user.click(screen.getByRole('button', { name: /A rule points at a topic/i }));

    expect(screen.getByRole('tab', { name: 'Rules & limits' })).toHaveAttribute(
      'data-state',
      'active'
    );
  });

  it('does NOT queue a topic focus for a finding fixed on the Rules tab', async () => {
    // `always_topic_named_as_choice` and `rule_names_always_topic` both carry a `topicKey`, but
    // what is wrong is the rule or the list pointing AT that topic, not the topic. Focusing it
    // would park a request the hidden editor cannot act on, which then fires unprompted the next
    // time the admin opens Topics for an unrelated reason.
    const user = userEvent.setup();
    renderPanel(
      payload({
        issues: [
          {
            severity: 'warning',
            code: 'rule_names_always_topic',
            topicKey: 'spine',
            message: 'A rule includes "spine", but that topic is asked in every interview.',
          },
        ],
      })
    );

    await user.click(screen.getByRole('button', { name: /A rule includes/i }));

    expect(screen.getByRole('tab', { name: 'Rules & limits' })).toHaveAttribute(
      'data-state',
      'active'
    );
    expect(screen.getByTestId('focus')).toHaveAttribute('data-key', '');
  });

  it('renders nothing when the setup is coherent', () => {
    renderPanel(payload({ issues: [] }));
    expect(screen.queryByText(/block launch/i)).not.toBeInTheDocument();
  });
});

describe('TopicsPanel — saving the settings', () => {
  it('PATCHes the settings to the same endpoint', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('save-settings'));

    await waitFor(() => expect(authoringMutateMock).toHaveBeenCalled());
    expect(lastMutation().method).toBe('PATCH');
    expect(lastMutation().path).toBe(ENDPOINT);
  });

  it('enumerates every settings field the card owns — a forgotten one is a silent data loss', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('save-settings'));

    await waitFor(() => expect(authoringMutateMock).toHaveBeenCalled());
    const body = lastMutation().body as Record<string, unknown>;

    expect(body).toMatchObject({
      maxConditionalTopics: 5,
      sessionBudgetSeconds: 900,
      secondsPerQuestionType: { text: 30 },
      secondsPerDataSlot: 20,
      includeCheckTopic: false,
      checkTopicPreference: ['pricing'],
      minConfidence: 0.8,
      fallbackTopicKeys: ['management'],
      announce: false,
      allowRespondentAmendment: false,
      plannerInstructions: 'prefer breadth',
      limitOpeningProbes: true,
      maxOpeningProbes: 2,
    });
    // `enabled` is the ONE settings field this body must not carry. The status header owns it, and
    // including it here would let the card's draft — captured whenever it last remounted — undo a
    // toggle the admin made in the header seconds earlier.
    expect(body).not.toHaveProperty('enabled');
  });

  it('maps rules field by field rather than passing the objects through', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('save-settings'));

    await waitFor(() => expect(authoringMutateMock).toHaveBeenCalled());
    const body = lastMutation().body as { rules: Record<string, unknown>[] };

    expect(body.rules).toEqual([
      {
        id: 'r1',
        dataSlotKey: 'licence',
        operator: 'not_exists',
        value: '',
        action: 'exclude',
        topicKey: 'audit',
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Fork-on-launch                                                             */
/* -------------------------------------------------------------------------- */

describe('TopicsPanel — fork on launch', () => {
  it('announces the new draft and redirects to its Topics tab when a save forks', async () => {
    const user = userEvent.setup();
    authoringMutateMock.mockResolvedValue({
      data: {},
      meta: { forked: true, versionId: 'v2', versionNumber: 4 },
    });
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    expect(await screen.findByText(/saved to a new draft \(v4\)/)).toBeInTheDocument();
    expect(routerMock.replace).toHaveBeenCalledWith('/admin/questionnaires/q1/v/v2/topics');
  });

  it('carries the active sub-tab across the fork redirect', async () => {
    // Dropping the query would return the admin to the first sub-tab after every fork — on the
    // version they have just been moved to, which is the worst moment to lose their place. Driven
    // through the real tab control rather than by stubbing `window.location`, so it exercises the
    // same `history.replaceState` path production uses.
    const user = userEvent.setup();
    authoringMutateMock.mockResolvedValue({
      data: {},
      meta: { forked: true, versionId: 'v2', versionNumber: 4 },
    });
    renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Rules & limits' }));
    await user.click(screen.getByTestId('save-topics'));

    expect(routerMock.replace).toHaveBeenCalledWith(
      '/admin/questionnaires/q1/v/v2/topics?tab=rules'
    );
  });

  it('does not redirect or announce when the save did not fork', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/saved to a new draft/)).not.toBeInTheDocument();
  });

  it('writes nothing and shows no error when the admin declines the fork', async () => {
    const user = userEvent.setup();
    authoringMutateMock.mockRejectedValue(new ForkCancelledError());
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
    // The lock is released, so the admin can try again.
    await waitFor(() => expect(screen.getByTestId('save-topics')).not.toBeDisabled());
  });
});

/* -------------------------------------------------------------------------- */
/* Errors and the busy lock                                                   */
/* -------------------------------------------------------------------------- */

describe('TopicsPanel — errors and the busy lock', () => {
  it('surfaces the failure message and resyncs, leaving the controls usable', async () => {
    const user = userEvent.setup();
    authoringMutateMock.mockRejectedValue(new Error('Topic key already exists'));
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Topic key already exists');
    expect(routerMock.refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('save-topics')).not.toBeDisabled());
  });

  it('falls back to a generic message when the rejection is not an Error', async () => {
    const user = userEvent.setup();
    authoringMutateMock.mockRejectedValue('boom');
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('clears a previous error when the next save starts', async () => {
    const user = userEvent.setup();
    authoringMutateMock.mockRejectedValueOnce(new Error('first failure'));
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    authoringMutateMock.mockResolvedValue({ data: {}, meta: null });
    await user.click(screen.getByTestId('save-topics'));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('holds the busy lock while a save is in flight, and releases it when the save lands', async () => {
    const user = userEvent.setup();
    let release: (v: { data: unknown; meta: null }) => void = () => {};
    authoringMutateMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    // In flight: every child is locked, including the routing map.
    await waitFor(() => expect(screen.getByTestId('save-topics')).toBeDisabled());
    expect(screen.getByTestId('routing-map')).toBeDisabled();

    release({ data: {}, meta: null });
    // No fork, so `endpoint` still names a version the admin is on — nothing is gained by making
    // them wait for the refresh to land.
    await waitFor(() => expect(screen.getByTestId('save-topics')).not.toBeDisabled());
  });

  it('does NOT release the lock just because a new payload object arrived', async () => {
    // The lock used to be keyed on the payload object, which is fresh on every RSC render — a
    // `router.refresh()` from any card on the page produced one, and so does any soft navigation
    // within this route. That released the lock at moments with nothing to do with the save
    // completing, which is the exact window the lock exists to close.
    const user = userEvent.setup();
    authoringMutateMock.mockReturnValue(new Promise(() => {}));
    const { rerender } = renderPanel();

    await user.click(screen.getByTestId('save-topics'));
    await waitFor(() => expect(screen.getByTestId('save-topics')).toBeDisabled());

    // A brand-new payload object with identical content — what a refresh mid-save looks like.
    rerender(<TopicsPanel questionnaireId="q1" versionId="v1" payload={payload()} />);

    expect(screen.getByTestId('save-topics')).toBeDisabled();
  });

  it('stays locked after a fork until the redirect lands on the new version', async () => {
    const user = userEvent.setup();
    authoringMutateMock.mockResolvedValue({
      data: {},
      meta: { forked: true, versionId: 'v2', versionNumber: 4 },
    });
    const { rerender } = renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    // `endpoint` closes over the PRE-fork version id and stays wrong until the route changes, so a
    // second save released here would write to the version the admin has just been moved off.
    await waitFor(() => expect(screen.getByTestId('routing-map')).toBeDisabled());
    rerender(<TopicsPanel questionnaireId="q1" versionId="v1" payload={payload()} />);
    expect(screen.getByTestId('routing-map')).toBeDisabled();

    // The redirect lands: new versionId, lock released.
    rerender(<TopicsPanel questionnaireId="q1" versionId="v2" payload={payload()} />);
    await waitFor(() => expect(screen.getByTestId('routing-map')).not.toBeDisabled());
  });
});

/* -------------------------------------------------------------------------- */
/* The routing map's "Edit this topic"                                        */
/* -------------------------------------------------------------------------- */

describe('TopicsPanel — focusing a topic from the routing map', () => {
  it('passes no focus request until the map makes one', () => {
    renderPanel();

    expect(screen.getByTestId('focus')).toHaveAttribute('data-key', '');
  });

  it('hands the requested topic key down to the list editor', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('routing-map'));

    expect(screen.getByTestId('focus')).toHaveAttribute('data-key', 'pricing');
    expect(screen.getByTestId('focus')).toHaveAttribute('data-nonce', '1');
  });

  it('increments the nonce on a repeat request, so asking twice still moves the list', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('routing-map'));
    await user.click(screen.getByTestId('routing-map'));

    expect(screen.getByTestId('focus')).toHaveAttribute('data-key', 'pricing');
    expect(screen.getByTestId('focus')).toHaveAttribute('data-nonce', '2');
  });

  it('drops the request once the list reports it handled', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('routing-map'));

    await user.click(screen.getByTestId('focus-handled'));

    // The list is keyed on the topic set, so the next save remounts it. A request left standing here
    // would replay then — clearing the admin's filter and yanking the view back to an old topic.
    expect(screen.getByTestId('focus')).toHaveAttribute('data-key', '');
  });

  it('honours a fresh request after the previous one was dropped', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('routing-map'));
    await user.click(screen.getByTestId('focus-handled'));

    await user.click(screen.getByTestId('routing-map'));

    // The nonce restarts from 1 because the previous request is gone, and that is harmless: each
    // click produces a new object, which is what the editor's effect actually keys on. What matters
    // is that dropping a request does not make the next one unreachable.
    expect(screen.getByTestId('focus')).toHaveAttribute('data-key', 'pricing');
    expect(screen.getByTestId('focus')).toHaveAttribute('data-nonce', '1');
  });
});

/* -------------------------------------------------------------------------- */
/* Turning a Routing Analyst gap into a topic (F17.20)                        */
/* -------------------------------------------------------------------------- */

describe('TopicsPanel — turning a gap into a topic (F17.20)', () => {
  it('passes no seed request until a gap is turned into a topic', () => {
    renderPanel();

    expect(screen.getByTestId('seed')).toHaveAttribute('data-nonce', '');
  });

  it('hands the gap down to the list editor, criteria from the quote and description from the explanation', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('turn-gap-into-topic'));

    const seed = screen.getByTestId('seed');
    expect(seed).toHaveAttribute('data-criteria', GAP_FIXTURE.sourceQuote);
    expect(seed).toHaveAttribute('data-description', GAP_FIXTURE.explanation);
    expect(seed).toHaveAttribute('data-nonce', '1');
  });

  it('increments the nonce on a repeat request, so a second gap still adds a second row', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('turn-gap-into-topic'));
    await user.click(screen.getByTestId('turn-gap-into-topic'));

    expect(screen.getByTestId('seed')).toHaveAttribute('data-nonce', '2');
  });

  it('drops the request once the list reports it handled', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('turn-gap-into-topic'));

    await user.click(screen.getByTestId('seed-handled'));

    expect(screen.getByTestId('seed')).toHaveAttribute('data-nonce', '');
  });
});

/* -------------------------------------------------------------------------- */
/* The AI entry point in the Topics section (F17.22 Phase 1)                  */
/* -------------------------------------------------------------------------- */

/**
 * The analyst was always reachable — but only from its own card, which sits above the settings, the
 * preview, the quality card and the evaluation card. An admin scrolling the topic list to decide
 * which groups are conditional is doing by hand exactly what the analyst does, and had nothing to
 * press. This is the same nonce contract as `focusTopic` and `seedTopic`: the panel asks, the card
 * acts, and asking twice must ask twice.
 */
describe('TopicsPanel — "Set up conditional topics with AI"', () => {
  const pressAiButton = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: /Set up conditional topics with AI/ }));

  it('passes no run request until the button is pressed', () => {
    renderPanel();
    expect(screen.getByTestId('analyst-card')).toHaveAttribute('data-run-nonce', '');
  });

  it('asks the analyst card to run', async () => {
    const user = userEvent.setup();
    renderPanel();

    await pressAiButton(user);

    expect(screen.getByTestId('analyst-card')).toHaveAttribute('data-run-nonce', '1');
  });

  it('increments the nonce when pressed again before the card has consumed the first', async () => {
    const user = userEvent.setup();
    renderPanel();

    await pressAiButton(user);
    await pressAiButton(user);

    // Without the counter this would be unchanged state and the card's effect would stay silent.
    expect(screen.getByTestId('analyst-card')).toHaveAttribute('data-run-nonce', '2');
  });

  it('restarts the nonce at 1 after an ack, which is harmless — the card keys on identity', async () => {
    const user = userEvent.setup();
    renderPanel();

    await pressAiButton(user);
    await user.click(screen.getByTestId('ack-run'));
    await pressAiButton(user);

    // Same reasoning as the focus nonce: the previous request is gone, so the count restarts, and
    // each press still hands the card a fresh object its effect fires on.
    expect(screen.getByTestId('analyst-card')).toHaveAttribute('data-run-nonce', '1');
  });

  it('drops the request once the card reports it handled', async () => {
    const user = userEvent.setup();
    renderPanel();
    await pressAiButton(user);

    await user.click(screen.getByTestId('ack-run'));

    expect(screen.getByTestId('analyst-card')).toHaveAttribute('data-run-nonce', '');
  });

  it('is disabled while a save is in flight, so it cannot race a fork', async () => {
    const user = userEvent.setup();
    // A save that never settles holds the panel's busy lock open.
    authoringMutateMock.mockReturnValue(new Promise(() => {}));
    renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Set up conditional topics with AI/ })
      ).toBeDisabled()
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Composition                                                                */
/* -------------------------------------------------------------------------- */

describe('TopicsPanel — composition', () => {
  it('mounts the whole tab: explainer, map, findings and the five cards', () => {
    renderPanel();

    expect(screen.getByText('How conditional topics works')).toBeInTheDocument();
    expect(screen.getByTestId('routing-map')).toBeInTheDocument();
    expect(screen.getByTestId('scope-issues')).toBeInTheDocument();
    expect(screen.getByTestId('analyst-card')).toBeInTheDocument();
    expect(screen.getByTestId('preview-card')).toBeInTheDocument();
    expect(screen.getByTestId('quality-card')).toBeInTheDocument();
    expect(screen.getByTestId('save-settings')).toBeInTheDocument();
    expect(screen.getByTestId('save-topics')).toBeInTheDocument();
  });

  it('passes the candidacy verdict and auto-trigger flag through to the analyst card (F17.19 Phase 3)', () => {
    renderPanel(
      payload({
        candidacy: { isCandidate: true, confidence: 0.9, summary: 'Reads like a screener.' },
        autoTriggerPending: true,
      })
    );

    const card = screen.getByTestId('analyst-card');
    expect(card).toHaveAttribute('data-is-candidate', 'true');
    expect(card).toHaveAttribute('data-auto-trigger-pending', 'true');
  });

  it('tells the routing-quality card how many topics are conditional', () => {
    renderPanel(
      payload({
        topics: [topic('open', 'opening'), topic('a', 'conditional'), topic('b', 'conditional')],
      })
    );

    expect(screen.getByTestId('quality-card')).toHaveAttribute('data-conditional-count', '2');
  });
});
