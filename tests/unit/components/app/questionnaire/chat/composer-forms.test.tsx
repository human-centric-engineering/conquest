// @vitest-environment happy-dom

/**
 * The composer has two forms, and the LAYOUT picks — not the composer.
 *
 * **Prominent** — a bordered, brand-tinted box opening at prose height with the controls inside
 * along its bottom edge. Broadsheet (an otherwise empty margin, where a bare field would float
 * unfindable) and Horizon (one question on a stage, the answer box the only other thing on screen)
 * both ask for it.
 *
 * **Quiet** — a field with its controls on the line beside it, one line tall and growing. Classic
 * and Focus, where a scrolling transcript is pressing down on the box and competing for the same
 * fixed viewport.
 *
 * This has been got wrong in both directions inside one week: the box shipped applied everywhere,
 * giving Classic a four-line bordered field under a rule; the correction then took it off Horizon,
 * which is the one stacked layout that had earned it. That is exactly the shape of thing a
 * declaration nothing asserts keeps doing, so the registry membership is pinned here as a set — a
 * layout that gains or loses the flag has to come and say so.
 *
 * The forms differ in CHROME ONLY. Every affordance — field, mic, send — exists in both, which is
 * the assertion that stops "make it compact" from becoming "drop a control".
 *
 * @see components/app/questionnaire/chat/chat-composer.tsx
 * @see lib/app/questionnaire/layout/slots.ts — the `prominent` placement flag
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { ConversationProvider } from '@/components/app/questionnaire/chat/conversation-context';
import { ChatComposer } from '@/components/app/questionnaire/chat/chat-composer';
import { LAYOUT_REGISTRY } from '@/components/app/questionnaire/layouts/registry';
import type { SlotPlacement } from '@/lib/app/questionnaire/layout/slots';
import type { UseQuestionnaireSessionStreamReturn } from '@/lib/hooks/use-questionnaire-session-stream';
import type { QuestionnaireChatStatus } from '@/lib/app/questionnaire/chat/types';

function streamStub() {
  return {
    turns: [{ role: 'assistant', content: 'What brought you here today?' }],
    streaming: false,
    inspectorTurns: [],
    status: 'idle' as QuestionnaireChatStatus,
    error: null,
    canSend: true,
    sendMessage: vi.fn(),
    continueAfterCard: vi.fn(),
    dismissError: vi.fn(),
    retry: vi.fn(),
  } as unknown as UseQuestionnaireSessionStreamReturn;
}

function renderComposer(prominent: boolean) {
  const stream = streamStub();
  return render(
    <ConversationProvider stream={stream} animateOpening={false}>
      <ChatComposer sessionId="s1" stream={stream} voiceInputEnabled prominent={prominent} />
    </ConversationProvider>
  );
}

/** The bordered surface the prominent form draws for itself. Absent means "the layout drew it". */
function ownSurface(container: HTMLElement) {
  return container.querySelector('.cq-composer');
}

describe('quiet — the form Classic and Focus get', () => {
  it('draws no surface of its own: the conversation card already is one', () => {
    const { container } = renderComposer(false);
    expect(ownSurface(container)).toBeNull();
  });

  it('starts one line tall, so an empty box costs the conversation almost nothing', () => {
    renderComposer(false);
    // The floor, not the height: the auto-grow effect writes an inline height on every keystroke and
    // `min-height` still wins over it, which is the whole reason `rows` cannot do this job. jsdom
    // computes no layout, so the declaration is the only thing there is to assert — the same lesson
    // the answer drawer's `lg:hidden` taught.
    const box = screen.getByLabelText('Your answer');
    expect(box.className).toContain('min-h-[2.5rem]');
    expect(box.className).not.toContain('min-h-[6.5rem]');
  });
});

describe('prominent — the form Broadsheet and Horizon ask for', () => {
  it('draws its own bordered surface, because the layout gave it the room', () => {
    const { container } = renderComposer(true);
    expect(ownSurface(container)).not.toBeNull();
  });

  it('opens at prose height, and the field contributes no border of its own', () => {
    const { container } = renderComposer(true);
    const box = screen.getByLabelText('Your answer');
    expect(box.className).toContain('min-h-[6.5rem]');
    // One rectangle, not two: the surface owns the edge, so the field inside it must not draw one.
    expect(box.className).toContain('border-0');
    expect(ownSurface(container)?.contains(box)).toBe(true);
  });
});

describe('what the two forms must NOT differ on', () => {
  it.each([
    ['quiet', false],
    ['prominent', true],
  ])('%s keeps every affordance — the change is chrome, not capability', (_name, prominent) => {
    renderComposer(prominent);
    expect(screen.getByLabelText('Your answer')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /voice|mic/i })).toBeInTheDocument();
  });
});

describe('the registry is what decides', () => {
  it('Broadsheet and Horizon are the layouts whose composer is prominent — and the only two', () => {
    // Asserted as a SET rather than per-layout, and sorted so it does not also pin registry order.
    // Both memberships have been wrong within a week of each other, in opposite directions, so both
    // directions are the assertion: a layout that gains the flag and one that loses it each land
    // here and have to be argued for.
    const prominent = Object.entries(LAYOUT_REGISTRY)
      .filter(([, def]) => {
        // Widened to the declared contract on purpose: `satisfies` in the registry keeps each
        // entry's literal type, so reading `.prominent` off the union would only compile for the
        // layouts that already set it — and the point is to catch one that newly does.
        const placement: SlotPlacement = def.placements.composer;
        return placement.kind === 'region' && placement.prominent === true;
      })
      .map(([id]) => id)
      .sort();

    expect(prominent).toEqual(['broadsheet', 'horizon']);
  });

  it('only Broadsheet also fills its column — Horizon is prominent WITHOUT that', () => {
    // The pair is why the two flags are separate. Horizon wants the surface and the prose height,
    // but its stage above still needs the room, so a composer that became the whole column would
    // take the layout apart. Collapsing `prominent` into `fills` would do exactly that.
    const fills = Object.entries(LAYOUT_REGISTRY)
      .filter(([, def]) => {
        const placement: SlotPlacement = def.placements.composer;
        return placement.kind === 'region' && placement.fills === true;
      })
      .map(([id]) => id)
      .sort();

    expect(fills).toEqual(['broadsheet']);
  });

  it('every layout places the composer somewhere — none of them is `omitted`', () => {
    // `composer` is an ESSENTIAL slot, so "not prominent" must mean "quiet", never "absent".
    for (const [id, def] of Object.entries(LAYOUT_REGISTRY)) {
      expect(def.placements.composer.kind, `${id} composer`).not.toBe('omitted');
    }
  });
});
