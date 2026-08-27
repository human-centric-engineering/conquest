// @vitest-environment happy-dom

/**
 * Unit tests: the routing map's detail panel.
 *
 * The panel's whole job is provenance — it exists so an author can see where a number came from and
 * what it leaves out. So the assertions are about what is *stated*, not about markup:
 *
 * 1. **The arithmetic is reachable, and the figures are not.** The breakdown is collapsed because it
 *    is wanted once; the two readings are not, because they are wanted every time. Both halves of
 *    that split are asserted — a disclosure that swallowed the figures would be the old problem
 *    wearing a chevron.
 * 2. **The chat caveat is on screen without opening ANYTHING** — not the disclosure, not the ⓘ. The
 *    estimate counts answering time only, and an author who reads it as a stopwatch sets a budget
 *    that cuts their instrument in half.
 * 3. **The author's criteria are all still there.** The panel restructures them; it must never edit
 *    them.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { RoutingMapDetail } from '@/components/admin/questionnaires/topics/routing-map-detail';
import {
  SCOPE_BADGES,
  type ScopeGraphNode,
  type ScopeNodeTiming,
} from '@/lib/app/questionnaire/scope/graph';

const TIMING: ScopeNodeTiming = {
  depth: 'full',
  fullSeconds: 77,
  lightSeconds: 16,
  memberCount: 5,
  lightMemberCount: 2,
  groups: [
    { label: 'Free text', count: 1, secondsEach: 45, seconds: 45 },
    { label: 'Likert', count: 4, secondsEach: 8, seconds: 32 },
  ],
  lightItems: [
    { key: 'q_a', label: 'How do you win new logos?', typeLabel: 'Likert', seconds: 8 },
    { key: 'q_b', label: 'How healthy is the channel?', typeLabel: 'Likert', seconds: 8 },
  ],
  unresolvedCount: 0,
};

const CRITERIA = [
  'Include this when the opening shows ANY of the following:',
  '• Growth source — new business (high priority) — they said something like: new logo, hunting.',
  '• Partner and channel (medium priority) — they said something like: resellers, alliances.',
].join('\n');

function node(overrides: Partial<ScopeGraphNode['detail']> = {}): ScopeGraphNode {
  return {
    id: 'conditional:sales_channels',
    kind: 'conditional',
    x: 0,
    y: 0,
    label: 'Sales channels',
    detail: {
      title: 'Sales channels',
      summary: 'Asked only when it is selected.',
      rows: [{ label: 'Key', value: 'sales_channels' }],
      topicKey: 'sales_channels',
      timing: TIMING,
      ...overrides,
    },
  };
}

describe('RoutingMapDetail', () => {
  it('invites a selection when nothing is selected', () => {
    render(<RoutingMapDetail node={null} onEditTopic={vi.fn()} />);
    expect(screen.getByText(/Select anything on the map/)).toBeInTheDocument();
  });

  describe('the duration figures', () => {
    /** Open the arithmetic. It is collapsed on mount — see the block comment above. */
    const expand = () =>
      fireEvent.click(screen.getByRole('button', { name: /How this is worked out/ }));

    it('shows both readings at a glance, without anything having to be opened', () => {
      render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);

      expect(screen.getByText('1m 17s')).toBeInTheDocument();
      expect(screen.getByText('16s')).toBeInTheDocument();
      expect(screen.getByText('full')).toBeInTheDocument();
      expect(screen.getByText('light')).toBeInTheDocument();
    });

    it('keeps the arithmetic out of the way until it is asked for', () => {
      render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);

      expect(screen.queryByText('How the full figure adds up')).not.toBeInTheDocument();
      expect(screen.queryByText(/4 × Likert/)).not.toBeInTheDocument();
      expect(screen.queryByText('A light run asks only')).not.toBeInTheDocument();

      expand();

      expect(screen.getByText('How the full figure adds up')).toBeInTheDocument();
    });

    it('collapses again, so the panel does not stay long once a reader is done', () => {
      render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);
      expand();
      fireEvent.click(screen.getByRole('button', { name: /Hide the arithmetic/ }));

      expect(screen.queryByText('How the full figure adds up')).not.toBeInTheDocument();
    });

    it('marks the depth the topic is actually set to, so one figure is the answer', () => {
      const { rerender } = render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);
      // Collapsed, the marker sits on the reading it belongs to.
      expect(screen.getByText('1m 17s').parentElement?.textContent).toContain('this topic');

      rerender(
        <RoutingMapDetail
          node={node({ timing: { ...TIMING, depth: 'light' } })}
          onEditTopic={vi.fn()}
        />
      );
      expect(screen.getByText('16s').parentElement?.textContent).toContain('this topic');
    });

    it('marks the authored depth on the expanded cards too', () => {
      render(
        <RoutingMapDetail
          node={node({ timing: { ...TIMING, depth: 'light' } })}
          onEditTopic={vi.fn()}
        />
      );
      expand();

      expect(screen.getByText('Light').closest('div')?.textContent).toContain('this topic');
      expect(screen.getByText('all 5 members')).toBeInTheDocument();
      expect(screen.getByText('the 2 members carrying the most weight')).toBeInTheDocument();
    });

    it('shows the rate behind every line of the breakdown once expanded', () => {
      render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);
      expand();

      expect(screen.getByText(/4 × Likert/)).toBeInTheDocument();
      expect(screen.getByText('@ 8s')).toBeInTheDocument();
      expect(screen.getByText(/1 × Free text/)).toBeInTheDocument();
      expect(screen.getByText('@ 45s')).toBeInTheDocument();
      expect(screen.getByText('32s')).toBeInTheDocument();
      expect(screen.getByText('45s')).toBeInTheDocument();
    });

    it('states the chat caveat while collapsed — not behind the chevron, not behind the ⓘ', () => {
      render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);

      expect(
        screen.getByText('Answering time only — a real chat runs longer.')
      ).toBeInTheDocument();

      expand();
      expect(screen.getByText(/follow-ups are not counted/)).toBeInTheDocument();
    });

    it('names the members a light run would sample', () => {
      render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);
      expand();

      expect(screen.getByText('A light run asks only')).toBeInTheDocument();
      expect(screen.getByText('How do you win new logos?')).toBeInTheDocument();
    });

    it('says so when members price at nothing because their key is gone', () => {
      render(
        <RoutingMapDetail
          node={node({ timing: { ...TIMING, unresolvedCount: 2 } })}
          onEditTopic={vi.fn()}
        />
      );
      expand();

      expect(screen.getByText(/2 members no longer exist/)).toBeInTheDocument();
    });

    it('does not offer a light sample when a light run is the whole topic', () => {
      render(
        <RoutingMapDetail
          node={node({ timing: { ...TIMING, lightSeconds: 77, lightItems: [] } })}
          onEditTopic={vi.fn()}
        />
      );
      expand();

      expect(screen.queryByText('A light run asks only')).not.toBeInTheDocument();
      expect(
        screen.getByText('this topic is small enough that a light run is the whole of it')
      ).toBeInTheDocument();
    });

    it('shows no timing block for a node that has none', () => {
      render(<RoutingMapDetail node={node({ timing: undefined })} onEditTopic={vi.fn()} />);
      expect(screen.queryByTestId('routing-map-timing')).not.toBeInTheDocument();
    });
  });

  describe('the criteria', () => {
    it('draws the lead-in, the terms and the priorities as separate things', () => {
      render(<RoutingMapDetail node={node({ criteria: CRITERIA })} onEditTopic={vi.fn()} />);

      expect(
        screen.getByText('Include this when the opening shows ANY of the following:')
      ).toBeInTheDocument();
      expect(screen.getByText('Growth source')).toBeInTheDocument();
      expect(screen.getByText('high priority')).toBeInTheDocument();
      expect(screen.getByText('Partner and channel')).toBeInTheDocument();
      expect(screen.getByText('medium priority')).toBeInTheDocument();
    });

    it('keeps every word the author wrote', () => {
      render(<RoutingMapDetail node={node({ criteria: CRITERIA })} onEditTopic={vi.fn()} />);

      const rendered = screen.getByTestId('routing-map-criteria').textContent ?? '';
      for (const word of ['new logo', 'hunting', 'resellers', 'alliances']) {
        expect(rendered).toContain(word);
      }
    });

    it('renders criteria that are plain prose as plain prose', () => {
      const prose = 'Ask this whenever the respondent sounds unsure about their pipeline.';
      render(<RoutingMapDetail node={node({ criteria: prose })} onEditTopic={vi.fn()} />);

      expect(screen.getByText(prose)).toBeInTheDocument();
    });
  });

  it('offers the jump back into authoring only for nodes that are a topic', () => {
    const onEditTopic = vi.fn();
    const { rerender } = render(<RoutingMapDetail node={node()} onEditTopic={onEditTopic} />);
    screen.getByRole('button', { name: /Edit this topic/ }).click();
    expect(onEditTopic).toHaveBeenCalledWith('sales_channels');

    rerender(<RoutingMapDetail node={node({ topicKey: undefined })} onEditTopic={onEditTopic} />);
    expect(screen.queryByRole('button', { name: /Edit this topic/ })).not.toBeInTheDocument();
  });
});

describe('what the tags mean', () => {
  it('explains every badge the node draws, in the same order', () => {
    render(
      <RoutingMapDetail
        node={node({
          badgeNotes: [{ ...SCOPE_BADGES.fallback }, { ...SCOPE_BADGES.preferredCheck }],
        })}
        onEditTopic={vi.fn()}
      />
    );

    // The chip the reader just clicked, and the sentence it never had on the canvas. `Fallback` and
    // `Preferred check` name guardrail mechanics an author met once in a settings field; two words on
    // a node cannot carry that.
    const section = screen.getByTestId('routing-map-badges');
    expect(section).toHaveTextContent('Fallback');
    expect(section).toHaveTextContent('used only when the decision chooses nothing at all');
    expect(section).toHaveTextContent('Preferred check');
    expect(section).toHaveTextContent('one topic the agent did NOT choose');
  });

  it('draws no section at all for a node that carries no badges', () => {
    render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);

    expect(screen.queryByTestId('routing-map-badges')).not.toBeInTheDocument();
  });
});
