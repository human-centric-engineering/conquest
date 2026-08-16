/**
 * Unit tests: `TopicListEditor`'s `focusTopic` seam.
 *
 * The routing map's "Edit this topic" closes the map and asks the list to open a row. Scoped narrowly to
 * that request, because the two ways it can silently do nothing are both invisible to whoever clicks:
 *
 * 1. **The row is hidden by the current filter**, so expanding it changes nothing on screen. Clearing the
 *    filter is what makes the request honoured rather than swallowed.
 * 2. **The same topic is requested twice.** A bare key is unchanged state the second time, so the effect
 *    never re-fires — which is why the request carries a nonce.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

// Four topics, because the filter chips only appear once a set is worth skimming (`drafts.length > 3`)
// — and the filter is half of what these tests are about.
const TOPICS = [
  topic('spine', 'core', 'Company basics', 0),
  topic('pricing', 'conditional', 'Pricing and packaging', 1),
  topic('talent', 'conditional', 'Hiring and capability', 2),
  topic('wrap', 'closing', 'Anything else', 3),
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

function renderEditor(focusTopic?: { key: string; nonce: number } | null) {
  return render(
    <TopicListEditor
      topics={TOPICS}
      inventory={INVENTORY}
      onSave={vi.fn().mockResolvedValue(true)}
      busy={false}
      enabled
      focusTopic={focusTopic ?? null}
    />
  );
}

/** A topic row's body is only in the DOM while it is expanded, so its criteria field is the tell. */
const isOpen = (label: string): boolean =>
  screen.getByRole('button', { expanded: true, name: new RegExp(label, 'i') }) !== null;

describe('TopicListEditor — focusTopic', () => {
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

  it('leaves every row collapsed when nothing has been requested', () => {
    renderEditor();

    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0);
  });

  it('expands and scrolls to the requested topic', () => {
    renderEditor({ key: 'pricing', nonce: 1 });

    expect(isOpen('Pricing and packaging')).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('leaves the other rows alone', () => {
    renderEditor({ key: 'pricing', nonce: 1 });

    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(1);
  });

  it('clears an active filter so a hidden row is actually revealed', () => {
    const { rerender } = renderEditor();
    // Filter to the conditional topics — "Company basics" now has no row at all.
    fireEvent.click(screen.getByRole('button', { name: /^Conditional/ }));
    expect(screen.queryByText('Company basics')).not.toBeInTheDocument();

    rerender(
      <TopicListEditor
        topics={TOPICS}
        inventory={INVENTORY}
        onSave={vi.fn().mockResolvedValue(true)}
        busy={false}
        enabled
        focusTopic={{ key: 'spine', nonce: 1 }}
      />
    );

    // Without the reset the row would still be filtered out and the click would look like a no-op.
    expect(screen.getByText('Company basics')).toBeInTheDocument();
    expect(isOpen('Company basics')).toBe(true);
  });

  it('honours a repeat request for the same topic', () => {
    const props = {
      topics: TOPICS,
      inventory: INVENTORY,
      onSave: vi.fn().mockResolvedValue(true),
      busy: false,
      enabled: true,
    };
    const { rerender } = render(
      <TopicListEditor {...props} focusTopic={{ key: 'pricing', nonce: 1 }} />
    );
    // Collapse it again, as an admin reading and moving on would.
    fireEvent.click(screen.getByRole('button', { expanded: true, name: /Pricing and packaging/i }));
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0);

    rerender(<TopicListEditor {...props} focusTopic={{ key: 'pricing', nonce: 2 }} />);

    // The nonce is what makes this a new request rather than unchanged state.
    expect(isOpen('Pricing and packaging')).toBe(true);
  });

  it('does nothing for a topic the list does not hold', () => {
    renderEditor({ key: 'gone', nonce: 1 });

    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0);
  });

  /**
   * Retiring the request.
   *
   * The request has to be dropped once acted on, and the caller is the only place that can do it:
   * this component is keyed on the topic set, so any later save remounts it — and a remount is
   * exactly what a `useRef` guard cannot survive. Left in place, the stale request replays on that
   * remount, clearing whatever filter the admin has since set and yanking the view back to a topic
   * they finished with minutes ago.
   */
  describe('onFocusHandled', () => {
    it('reports the request handled, so the caller can drop it', () => {
      const onFocusHandled = vi.fn();
      render(
        <TopicListEditor
          topics={TOPICS}
          inventory={INVENTORY}
          onSave={vi.fn().mockResolvedValue(true)}
          busy={false}
          enabled
          focusTopic={{ key: 'pricing', nonce: 1 }}
          onFocusHandled={onFocusHandled}
        />
      );

      expect(onFocusHandled).toHaveBeenCalledTimes(1);
    });

    it('stays silent when the request names a topic the list does not hold', () => {
      const onFocusHandled = vi.fn();
      render(
        <TopicListEditor
          topics={TOPICS}
          inventory={INVENTORY}
          onSave={vi.fn().mockResolvedValue(true)}
          busy={false}
          enabled
          focusTopic={{ key: 'gone', nonce: 1 }}
          onFocusHandled={onFocusHandled}
        />
      );

      // Not handled — so the caller keeps the request, and it is honoured if that topic appears.
      expect(onFocusHandled).not.toHaveBeenCalled();
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
      const { rerender } = render(
        <TopicListEditor {...props} focusTopic={{ key: 'spine', nonce: 1 }} />
      );
      rerender(<TopicListEditor {...props} focusTopic={null} />);
      fireEvent.click(screen.getByRole('button', { name: /^Conditional/ }));
      expect(screen.queryByText('Company basics')).not.toBeInTheDocument();

      // A save changes the key set, so the editor remounts. The old request must not come back.
      rerender(<TopicListEditor {...props} key="remounted" focusTopic={null} />);

      expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0);
    });
  });
});
