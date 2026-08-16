/**
 * Unit tests: `RoutingMapDialog` — the Adaptive scope routing map.
 *
 * The graph itself is asserted in `tests/unit/lib/app/questionnaire/scope/graph.test.ts`; what is tested
 * here is the shell around it — the two states an author can misread (a map of a switched-off version,
 * and a map of a version with nothing to decide), the always-band toggle, and the one affordance that
 * writes anything at all: "Edit this topic", which has to close the dialog as well as fire, because the
 * row it lands on sits behind the overlay.
 *
 * `@xyflow/react` is mocked at module level using the `vi.hoisted` stub pattern established by
 * `workflow-canvas.test.tsx` — jsdom has no ResizeObserver and React Flow measures on mount. The stub
 * records the nodes it was handed, which is enough to assert the toggle without rendering a canvas.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import type { ReactNode } from 'react';

const { ReactFlowMock } = vi.hoisted(() => ({
  ReactFlowMock: vi.fn((props: Record<string, unknown>) => (
    <div data-testid="rf-canvas" data-node-count={(props.nodes as unknown[]).length} />
  )),
}));

vi.mock('@xyflow/react', () => ({
  ReactFlow: ReactFlowMock,
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Panel: ({ children }: { children: ReactNode }) => <>{children}</>,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  useNodesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  useEdgesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
}));

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

// Imported after the mocks, which vitest hoists above it.
import { RoutingMapDialog } from '@/components/admin/questionnaires/topics/routing-map-dialog';
import { ALWAYS_BAND_NODE_ID } from '@/lib/app/questionnaire/scope/graph';
import {
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  type AdaptiveScopeSettings,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import { EMPTY_TOPICS_PAYLOAD, type TopicsPayload } from '@/lib/app/questionnaire/scope/views';

/* -------------------------------------------------------------------------- */

function topic(key: string, phase: Topic['phase'], label = `Topic ${key}`): Topic {
  return {
    id: `t-${key}`,
    key,
    label,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it applies' : null,
    depth: 'full',
    members: { questionKeys: [`q_${key}`], dataSlotKeys: [] },
    ordinal: 0,
    source: 'manual',
  };
}

function payload(topics: Topic[], settings: Partial<AdaptiveScopeSettings> = {}): TopicsPayload {
  return {
    ...EMPTY_TOPICS_PAYLOAD,
    topics,
    settings: { ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS, enabled: true, ...settings },
  };
}

const FULL = [
  topic('open', 'opening', 'Where you are now'),
  topic('pricing', 'conditional', 'Pricing and packaging'),
  topic('spine', 'core', 'Company basics'),
  topic('wrap', 'closing', 'Anything else'),
];

function open(props: Partial<React.ComponentProps<typeof RoutingMapDialog>> = {}) {
  const onEditTopic = vi.fn();
  render(<RoutingMapDialog payload={payload(FULL)} onEditTopic={onEditTopic} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /routing map/i }));
  return { onEditTopic };
}

const nodeCount = () => Number(screen.getByTestId('rf-canvas').getAttribute('data-node-count'));

/* -------------------------------------------------------------------------- */

describe('RoutingMapDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a trigger and nothing else until it is opened', () => {
    render(<RoutingMapDialog payload={payload(FULL)} onEditTopic={vi.fn()} />);

    expect(screen.getByRole('button', { name: /routing map/i })).toBeInTheDocument();
    // A canvas mounted behind a closed dialog would measure and lay out for nothing on every render of
    // a tab the map is only occasionally wanted on.
    expect(screen.queryByTestId('rf-canvas')).not.toBeInTheDocument();
  });

  it('opens the canvas and says the map is structural rather than a prediction', () => {
    open();

    expect(screen.getByTestId('rf-canvas')).toBeInTheDocument();
    // The single most important disclaimer on the surface: an author who reads the map as a forecast
    // will trust it over the dry-run, which is the only thing that actually runs the planner.
    expect(screen.getByText(/not a prediction/i)).toBeInTheDocument();
  });

  it('is disabled while the tab is saving', () => {
    render(<RoutingMapDialog payload={payload(FULL)} onEditTopic={vi.fn()} disabled />);

    expect(screen.getByRole('button', { name: /routing map/i })).toBeDisabled();
  });

  describe('the states an author could misread', () => {
    it('says so when adaptive scope is off', () => {
      render(
        <RoutingMapDialog payload={payload(FULL, { enabled: false })} onEditTopic={vi.fn()} />
      );
      fireEvent.click(screen.getByRole('button', { name: /routing map/i }));

      expect(screen.getByTestId('routing-map-off-banner')).toHaveTextContent(/would happen/i);
    });

    it('shows no banner when it is on', () => {
      open();

      expect(screen.queryByTestId('routing-map-off-banner')).not.toBeInTheDocument();
    });

    it('says when nothing is conditional, so an empty-looking pipeline is not read as a fault', () => {
      render(
        <RoutingMapDialog
          payload={payload([topic('open', 'opening'), topic('spine', 'core')])}
          onEditTopic={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /routing map/i }));

      expect(screen.getByTestId('routing-map-nothing-conditional')).toHaveTextContent(
        /nothing to decide/i
      );
    });

    it('shows no such note once a topic is conditional', () => {
      open();

      expect(screen.queryByTestId('routing-map-nothing-conditional')).not.toBeInTheDocument();
    });
  });

  describe('the always-asked band', () => {
    it('starts collapsed and expands to one node per topic', () => {
      open();
      const collapsed = nodeCount();

      fireEvent.click(screen.getByRole('switch'));

      // Two always-run topics in the fixture — `spine` and `wrap`.
      expect(nodeCount()).toBe(collapsed + 2);
    });

    it('labels the toggle generically, with no count baked into it', () => {
      open();

      // A control names what it does. The count is a fact about THIS version and is already on the band
      // node; repeating it here made a general affordance read as hardcoded for whichever questionnaire
      // was open — the whole map is config-driven and the copy has to say so.
      expect(screen.getByText('Show always-asked topics')).toBeInTheDocument();
      expect(screen.queryByText(/show the \d+ always-asked/i)).not.toBeInTheDocument();
    });

    it('states the count on the band node instead, where it belongs', () => {
      open();
      selectNode(ALWAYS_BAND_NODE_ID);

      const detail = within(screen.getByTestId('routing-map-detail'));
      expect(detail.getByText('Always asked')).toBeInTheDocument();
      expect(detail.getByText('2')).toBeInTheDocument();
    });

    it('disables the toggle when there are none to show', () => {
      render(
        <RoutingMapDialog
          payload={payload([topic('open', 'opening'), topic('pricing', 'conditional')])}
          onEditTopic={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /routing map/i }));

      expect(screen.getByRole('switch')).toBeDisabled();
    });
  });

  describe('the detail panel', () => {
    it('prompts for a selection before anything is chosen', () => {
      open();

      expect(
        within(screen.getByTestId('routing-map-detail')).getByText(/select anything/i)
      ).toBeInTheDocument();
    });

    it('shows a selected topic’s detail, and offers the jump only for a topic', () => {
      const { onEditTopic } = open();
      selectNode('conditional:pricing');

      const detail = within(screen.getByTestId('routing-map-detail'));
      expect(detail.getByText('Pricing and packaging')).toBeInTheDocument();
      expect(detail.getByText('when it applies')).toBeInTheDocument();

      fireEvent.click(detail.getByRole('button', { name: /edit this topic/i }));
      expect(onEditTopic).toHaveBeenCalledWith('pricing');
      // It must close: the row it lands on is behind the overlay, so a dialog left open would look to
      // the admin like the button did nothing.
      expect(screen.queryByTestId('rf-canvas')).not.toBeInTheDocument();
    });

    it('offers no jump from a node that has no row to land on', () => {
      open();
      selectNode('guardrails');

      const detail = within(screen.getByTestId('routing-map-detail'));
      expect(detail.getByText('Guardrails')).toBeInTheDocument();
      expect(detail.queryByRole('button', { name: /edit this topic/i })).not.toBeInTheDocument();
    });
  });
});

/**
 * Drive the canvas's `onNodeClick` the way React Flow would, through the recorded props.
 *
 * Wrapped in `act` because this is a bare callback rather than a DOM event — without it the selection
 * state update is scheduled and never flushed, and the detail panel still shows its empty prompt.
 */
function selectNode(id: string): void {
  const props = ReactFlowMock.mock.calls[ReactFlowMock.mock.calls.length - 1]?.[0] as {
    onNodeClick: (event: unknown, node: { id: string }) => void;
  };
  act(() => {
    props.onNodeClick(null, { id });
  });
}
