/**
 * Unit tests: `TopicsPanel` — the Adaptive scope tab's client shell.
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

vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));

vi.mock('@/components/admin/questionnaires/authoring-mutate', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/admin/questionnaires/authoring-mutate')
  >('@/components/admin/questionnaires/authoring-mutate');
  return { ...actual, authoringMutate: authoringMutateMock };
});

// The cards are stubbed to the callbacks the panel hands them. Each has its own test file.
vi.mock('@/components/admin/questionnaires/topics/routing-analyst-card', () => ({
  RoutingAnalystCard: () => <div data-testid="analyst-card" />,
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
      Routing map
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
  }: {
    onSave: (t: unknown[]) => Promise<boolean>;
    busy: boolean;
    focusTopic: { key: string; nonce: number } | null;
    onFocusHandled?: () => void;
  }) => (
    <div>
      <div
        data-testid="focus"
        data-key={focusTopic?.key ?? ''}
        data-nonce={focusTopic?.nonce ?? ''}
      />
      {/* Stands in for the real editor's effect, which reports once it has acted on a request. */}
      <button type="button" data-testid="focus-handled" onClick={() => onFocusHandled?.()}>
        handled
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
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  type AdaptiveScopeSettings,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import { EMPTY_TOPICS_PAYLOAD, type TopicsPayload } from '@/lib/app/questionnaire/scope/views';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ENDPOINT = '/api/v1/app/questionnaires/q1/versions/v1/topics';

/**
 * A settings blob with every field set to something other than its default, so a field the panel
 * forgets to enumerate shows up as a missing key rather than as a coincidentally-equal value.
 */
const SETTINGS_FIXTURE: AdaptiveScopeSettings = {
  ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
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
    settings: { ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS, enabled: true },
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
    });
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

  it('holds the busy lock until the refreshed payload arrives', async () => {
    const user = userEvent.setup();
    let release: (v: { data: unknown; meta: null }) => void = () => {};
    authoringMutateMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const { rerender } = renderPanel();

    await user.click(screen.getByTestId('save-topics'));

    // In flight: every child is locked, including the routing map.
    await waitFor(() => expect(screen.getByTestId('save-topics')).toBeDisabled());
    expect(screen.getByTestId('routing-map')).toBeDisabled();

    release({ data: {}, meta: null });
    // The lock is released by the NEW payload, not by the promise settling — which is what closes the
    // window where a second save could fire against the pre-fork version id.
    rerender(<TopicsPanel questionnaireId="q1" versionId="v1" payload={payload()} />);
    await waitFor(() => expect(screen.getByTestId('save-topics')).not.toBeDisabled());
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
/* Composition                                                                */
/* -------------------------------------------------------------------------- */

describe('TopicsPanel — composition', () => {
  it('mounts the whole tab: explainer, map, findings and the five cards', () => {
    renderPanel();

    expect(screen.getByText('How adaptive scope works')).toBeInTheDocument();
    expect(screen.getByTestId('routing-map')).toBeInTheDocument();
    expect(screen.getByTestId('scope-issues')).toBeInTheDocument();
    expect(screen.getByTestId('analyst-card')).toBeInTheDocument();
    expect(screen.getByTestId('preview-card')).toBeInTheDocument();
    expect(screen.getByTestId('quality-card')).toBeInTheDocument();
    expect(screen.getByTestId('save-settings')).toBeInTheDocument();
    expect(screen.getByTestId('save-topics')).toBeInTheDocument();
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
