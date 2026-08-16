/**
 * Unit tests: the routing map's detail panel.
 *
 * The panel's whole job is provenance — it exists so an author can see where a number came from and
 * what it leaves out. So the assertions are about what is *stated*, not about markup:
 *
 * 1. **The arithmetic is on screen.** A duration with no visible breakdown is the thing this panel
 *    replaced; a rate line that disappeared would take the trust with it.
 * 2. **The chat caveat is on screen without opening anything.** The estimate counts answering time
 *    only, and an author who reads it as a stopwatch sets a budget that cuts their instrument in
 *    half. It must not be hidden behind the ⓘ.
 * 3. **The author's criteria are all still there.** The panel restructures them; it must never edit
 *    them.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { RoutingMapDetail } from '@/components/admin/questionnaires/topics/routing-map-detail';
import type { ScopeGraphNode, ScopeNodeTiming } from '@/lib/app/questionnaire/scope/graph';

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
    it('shows both depths with what each one covers', () => {
      render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);

      expect(screen.getByText('1m 17s')).toBeInTheDocument();
      expect(screen.getByText('16s')).toBeInTheDocument();
      expect(screen.getByText('all 5 members')).toBeInTheDocument();
      expect(screen.getByText('the 2 members carrying the most weight')).toBeInTheDocument();
    });

    it('marks the depth the topic is actually set to, so one figure is the answer', () => {
      const { rerender } = render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);
      expect(screen.getByText('this topic').closest('span')?.textContent).toContain('this topic');

      rerender(
        <RoutingMapDetail
          node={node({ timing: { ...TIMING, depth: 'light' } })}
          onEditTopic={vi.fn()}
        />
      );
      // The marker moves with the authored depth rather than staying on the larger figure.
      const light = screen.getByText('Light').closest('div');
      expect(light?.textContent).toContain('this topic');
    });

    it('shows the rate behind every line of the breakdown', () => {
      render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);

      expect(screen.getByText(/4 × Likert/)).toBeInTheDocument();
      expect(screen.getByText('@ 8s')).toBeInTheDocument();
      expect(screen.getByText(/1 × Free text/)).toBeInTheDocument();
      expect(screen.getByText('@ 45s')).toBeInTheDocument();
      expect(screen.getByText('32s')).toBeInTheDocument();
      expect(screen.getByText('45s')).toBeInTheDocument();
    });

    it('states the chat caveat in the panel itself, not only behind the help icon', () => {
      render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);

      expect(screen.getByText(/Answering time only/)).toBeInTheDocument();
      expect(screen.getByText(/follow-ups are not counted/)).toBeInTheDocument();
    });

    it('names the members a light run would sample', () => {
      render(<RoutingMapDetail node={node()} onEditTopic={vi.fn()} />);

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

      expect(screen.getByText(/2 members no longer exist/)).toBeInTheDocument();
    });

    it('does not offer a light sample when a light run is the whole topic', () => {
      render(
        <RoutingMapDetail
          node={node({ timing: { ...TIMING, lightSeconds: 77, lightItems: [] } })}
          onEditTopic={vi.fn()}
        />
      );

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
