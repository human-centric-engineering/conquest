// @vitest-environment happy-dom

/**
 * `DndContext` must always be given an explicit `id` — a hydration guard.
 *
 * dnd-kit derives the drag handle's `aria-describedby` from `useUniqueId`, which is backed by a
 * MODULE-SCOPED counter (`let ids = {}` in `@dnd-kit/utilities`), not React's `useId`:
 *
 *     const id = ids[prefix] == null ? 0 : ids[prefix] + 1;
 *
 * On the server that counter lives for the lifetime of the Node process and is shared across every
 * request, so the Nth `DndContext` ever rendered gets `DndDescribedBy-(N-1)`. The client always
 * starts at 0. Any page whose server render is not the process's first therefore hydrates with a
 * mismatched `aria-describedby` — which React reports and does not patch up, leaving the handle
 * pointing at a description node that may not exist.
 *
 * `useUniqueId` short-circuits and returns `value` verbatim when one is passed, so an explicit `id`
 * is the fix. Note it is returned RAW — the id becomes a DOM id directly, with no `DndDescribedBy-`
 * prefix, which is why ours are namespaced `dnd-*` rather than named after the list they wrap.
 *
 * @see components/admin/questionnaires/topics/topic-list-editor.tsx
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { DndContext, useDraggable } from '@dnd-kit/core';

function Handle() {
  const { attributes } = useDraggable({ id: 'x' });
  return <button {...attributes}>h</button>;
}

const describedBy = (html: string) => /aria-describedby="([^"]+)"/.exec(html)?.[1];

describe('why the id is required', () => {
  it('drifts between renders without one — the mismatch, reproduced', () => {
    const first = describedBy(
      renderToString(
        <DndContext>
          <Handle />
        </DndContext>
      )
    );
    const second = describedBy(
      renderToString(
        <DndContext>
          <Handle />
        </DndContext>
      )
    );
    // Two renders in ONE process disagree; server-vs-client is the same defect across two.
    expect(first).not.toBe(second);
  });

  it('is pinned by an explicit id, and used verbatim as the DOM id', () => {
    const render = () =>
      describedBy(
        renderToString(
          <DndContext id="dnd-topic-list">
            <Handle />
          </DndContext>
        )
      );
    expect(render()).toBe(render());
    // Verbatim, no prefix — hence the `dnd-` namespace on ours.
    expect(render()).toBe('dnd-topic-list');
  });
});

describe('every DndContext in the admin surfaces passes one', () => {
  // Source-level, because the defect is a MISSING prop: a rendering test can only cover the call
  // sites someone remembered to write a test for, while this fails for any new one.
  const FILES = [
    'components/admin/questionnaires/topics/topic-list-editor.tsx',
    'components/admin/questionnaires/version-editor.tsx',
    'components/admin/questionnaires/section-editor.tsx',
  ];

  it.each(FILES)('%s opens DndContext with an id', (file) => {
    const source = readFileSync(file, 'utf8');
    const opens = source.match(/<DndContext[\s>]/g) ?? [];
    expect(opens.length).toBeGreaterThan(0);
    for (const match of source.matchAll(/<DndContext\b([\s\S]*?)>/g)) {
      expect(match[1]).toMatch(/\sid=/);
    }
  });
});
