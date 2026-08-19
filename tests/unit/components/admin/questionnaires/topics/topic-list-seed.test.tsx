/**
 * Unit tests: `TopicListEditor`'s `seedTopic` seam (F17.20).
 *
 * The Routing Analyst's "Turn into topic" action, on a gap it could not formalize, asks the list to
 * add a new draft row pre-filled from the gap rather than leaving the admin to re-type what the
 * analyst already found. Scoped narrowly to that seam, mirroring `topic-list-focus.test.tsx`:
 *
 * 1. **The new row carries the gap's text** — `criteria` from `sourceQuote` (the document's own
 *    words), `description` from `explanation` (why the analyst couldn't formalize it) — and nothing
 *    else about it is inferred; the admin still names it and picks its members.
 * 2. **A repeat request still adds a second row.** The request carries a nonce for the same reason
 *    `focusTopic` does: two gaps can produce the same text, and unchanged state would mean the
 *    second click does nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TopicListEditor } from '@/components/admin/questionnaires/topics/topic-list-editor';
import type { Topic } from '@/lib/app/questionnaire/scope/types';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';

function topic(key: string, phase: Topic['phase'], label: string, ordinal: number): Topic {
  return {
    id: `t-${key}`,
    key,
    label,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it applies' : null,
    depth: 'full',
    members: { questionKeys: [`q_${key}`], dataSlotKeys: [] },
    ordinal,
    source: 'manual',
  };
}

const TOPICS = [
  topic('spine', 'core', 'Company basics', 0),
  topic('pricing', 'conditional', 'Pricing and packaging', 1),
];

const INVENTORY: TopicsPayload['inventory'] = {
  questions: TOPICS.map((t) => ({
    key: `q_${t.key}`,
    prompt: `Question for ${t.label}`,
    sectionTitle: t.label,
    type: 'free_text',
    estimatedSeconds: 45,
    weight: 1,
  })),
  dataSlots: [],
};

const GAP = {
  description: 'Too vague to test mechanically — no data slot captures "judgement".',
  criteria: 'Use judgement for respondents outside these categories.',
};

function renderEditor(seedTopic?: { description: string; criteria: string; nonce: number } | null) {
  return render(
    <TopicListEditor
      topics={TOPICS}
      inventory={INVENTORY}
      onSave={vi.fn().mockResolvedValue(true)}
      busy={false}
      enabled
      seedTopic={seedTopic ?? null}
    />
  );
}

describe('TopicListEditor — seedTopic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom implements neither, and the effect calls both.
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('adds no row when nothing has been requested', () => {
    renderEditor();

    expect(screen.getByText('2 topics')).toBeInTheDocument();
  });

  it('adds a new conditional row, opened, pre-filled from the gap', () => {
    // Scrolling is not asserted here: the row is created BY this effect, so the synchronous
    // `requestAnimationFrame` stub fires before React has committed the new row to the DOM — a
    // test-harness timing gap, not a production one (a real animation frame runs well after commit).
    renderEditor({ ...GAP, nonce: 1 });

    expect(screen.getByText('3 topics')).toBeInTheDocument();
    expect(screen.getByText('Untitled topic')).toBeInTheDocument();
    expect(screen.getByDisplayValue(GAP.criteria)).toBeInTheDocument();
    expect(screen.getByDisplayValue(GAP.description)).toBeInTheDocument();
  });

  it('leaves the existing rows untouched', () => {
    renderEditor({ ...GAP, nonce: 1 });

    expect(screen.getByText('Company basics')).toBeInTheDocument();
    expect(screen.getByText('Pricing and packaging')).toBeInTheDocument();
  });

  it('adds a second row for a second request, even with identical text', () => {
    const { rerender } = renderEditor({ ...GAP, nonce: 1 });

    rerender(
      <TopicListEditor
        topics={TOPICS}
        inventory={INVENTORY}
        onSave={vi.fn().mockResolvedValue(true)}
        busy={false}
        enabled
        seedTopic={{ ...GAP, nonce: 2 }}
      />
    );

    expect(screen.getByText('4 topics')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue(GAP.criteria)).toHaveLength(2);
  });

  describe('onSeedHandled', () => {
    it('reports the request handled, so the caller can drop it', () => {
      const onSeedHandled = vi.fn();
      render(
        <TopicListEditor
          topics={TOPICS}
          inventory={INVENTORY}
          onSave={vi.fn().mockResolvedValue(true)}
          busy={false}
          enabled
          seedTopic={{ ...GAP, nonce: 1 }}
          onSeedHandled={onSeedHandled}
        />
      );

      expect(onSeedHandled).toHaveBeenCalledTimes(1);
    });

    it('does not replay a retired request across a remount', () => {
      const props = {
        topics: TOPICS,
        inventory: INVENTORY,
        onSave: vi.fn().mockResolvedValue(true),
        busy: false,
        enabled: true,
      };
      // The caller honours the report by clearing the request, which is what `null` stands for here.
      const { rerender } = render(<TopicListEditor {...props} seedTopic={{ ...GAP, nonce: 1 }} />);
      rerender(<TopicListEditor {...props} seedTopic={null} />);
      expect(screen.getByText('3 topics')).toBeInTheDocument();

      // A save changes the key set, so the editor remounts — a fresh instance reinitialises its
      // drafts from `topics`, dropping the seeded row along with every other unsaved edit. What
      // this pins down is narrower: a null `seedTopic` on that fresh instance must not resurrect it.
      rerender(<TopicListEditor {...props} key="remounted" seedTopic={null} />);

      expect(screen.getByText('2 topics')).toBeInTheDocument();
    });
  });
});
