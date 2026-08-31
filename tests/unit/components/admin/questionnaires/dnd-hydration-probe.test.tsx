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
import ts from 'typescript';

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

/**
 * Every `<DndContext>` JSX opening element in a parsed source file that has no `id` attribute.
 *
 * Walks the real AST rather than matching the text — an earlier version of this test used
 * `/<DndContext\b([\s\S]*?)>/g`, which is exactly the kind of check the defect it guards against
 * would slip past: fooled by a `>` inside an attribute value, a self-closing tag, a reformat that
 * moves `id` across a line boundary the pattern didn't anticipate, or a JSX shape nobody tested it
 * against — all while the underlying hydration-safety invariant is unaffected either way. The
 * TypeScript compiler already knows what a JSX opening element and its attributes are; asking it is
 * what `cost-log-fk-attribution.test.ts` does for the same reason, for a different defect.
 */
function findDndContextsMissingId(sourceFile: ts.SourceFile): string[] {
  const missing: string[] = [];

  function visit(node: ts.Node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sourceFile) === 'DndContext' &&
      !node.attributes.properties.some(
        (prop) => ts.isJsxAttribute(prop) && prop.name.getText(sourceFile) === 'id'
      )
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      missing.push(`line ${line + 1}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return missing;
}

function parseTsx(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

describe('every DndContext in the admin surfaces passes one', () => {
  // AST-checked, not rendered, because the defect is a MISSING prop: a rendering test can only
  // cover the call sites someone remembered to write one for, while this fails for any new one —
  // and it can never fire a false negative from a reformat the way a regex over the text could.
  const FILES = [
    'components/admin/questionnaires/topics/topic-list-editor.tsx',
    'components/admin/questionnaires/version-editor.tsx',
    'components/admin/questionnaires/section-editor.tsx',
  ];

  it.each(FILES)('%s opens every DndContext with an id', (file) => {
    const missing = findDndContextsMissingId(parseTsx(file, readFileSync(file, 'utf8')));
    expect(missing).toEqual([]);
  });

  it('the checker itself catches a DndContext with no id (self-test)', () => {
    // A synthetic file, not one of the three above — proves the walk actually flags an omission
    // rather than vacuously passing because every real file happens to be well-formed.
    const source = parseTsx(
      'synthetic.tsx',
      'function C() { return <DndContext sensors={s}><Child /></DndContext>; }'
    );
    expect(findDndContextsMissingId(source)).toEqual(['line 1']);
  });

  it('does not flag an unrelated JSX element that happens to have no id', () => {
    const source = parseTsx('synthetic.tsx', 'function C() { return <SortableContext />; }');
    expect(findDndContextsMissingId(source)).toEqual([]);
  });
});
