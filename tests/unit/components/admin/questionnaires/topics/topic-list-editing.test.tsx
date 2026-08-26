/**
 * Unit tests: `TopicListEditor` — editing the topic set.
 *
 * `topic-list-focus.test.tsx` covers the routing map's "Edit this topic" seam. What is covered here is
 * the editor itself: adding, removing, reordering, renaming, the per-row fields, and the three readouts
 * that exist to catch an authoring mistake nothing else in the system reports.
 *
 * The ones worth naming, because each is a decision rather than plumbing:
 *
 * - **"Questions in no topic" is computed off the live drafts, not the saved set.** Once conditional topics
 *   is on, a question no topic claims can never be asked — and the findings above the list only know
 *   about what was saved. An author who removes the last topic covering a question has to see it
 *   immediately, so the count tracks the draft and names the questions rather than only counting them.
 * - **The key is derived from the name, but only while it is still automatic.** Deriving forever would
 *   silently break every rule addressing the old key; never deriving would make an author hand-write a
 *   slug for every topic they add.
 * - **Reordering is disabled while a filter is on.** "Up" means the row above *in the full set*, which
 *   is not the row above on screen — so the buttons are locked rather than quietly moving the wrong row.
 *
 * The `Select` primitive is stubbed with a native `<select>`: Radix needs pointer geometry happy-dom
 * does not provide, and what is being asserted is the value that reaches the draft, not the popover.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
    disabled,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <select
      data-testid="select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import {
  TopicListEditor,
  reorderDrafts,
  type DraftTopic,
} from '@/components/admin/questionnaires/topics/topic-list-editor';
import type { Topic } from '@/lib/app/questionnaire/scope/types';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function topic(key: string, phase: Topic['phase'], label: string, ordinal: number): Topic {
  return {
    id: `t-${key}`,
    key,
    label,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'they operate in more than one region' : null,
    depth: 'full',
    members: { questionKeys: [`q_${key}`], dataSlotKeys: [] },
    ordinal,
    source: 'seeded',
    trigger: null,
  };
}

// Four topics: the filter row only appears once the set is worth skimming (`drafts.length > 3`).
const TOPICS = [
  topic('spine', 'core', 'Company basics', 0),
  topic('pricing', 'conditional', 'Pricing and packaging', 1),
  topic('talent', 'conditional', 'Hiring and capability', 2),
  topic('wrap', 'closing', 'Anything else', 3),
];

function inventory(extraQuestionKeys: string[] = []): TopicsPayload['inventory'] {
  return {
    questions: [
      ...TOPICS.map((t) => ({
        key: `q_${t.key}`,
        prompt: `Question for ${t.label}`,
        sectionTitle: t.label,
        type: 'free_text',
        estimatedSeconds: 45,
        weight: 1,
      })),
      ...extraQuestionKeys.map((key) => ({
        key,
        prompt: `Orphan question ${key}`,
        sectionTitle: 'Unsorted',
        type: 'free_text',
        estimatedSeconds: 30,
        weight: 1,
      })),
    ],
    dataSlots: [
      { key: 'slot_a', name: 'Region', theme: 'Company', estimatedSeconds: 20, weight: 1 },
    ],
  };
}

/** The editor's save handler, typed so the recorded drafts come back as drafts. */
type SaveMock = ReturnType<typeof saveMock>;

function saveMock(result = true) {
  return vi.fn<(topics: DraftTopic[]) => Promise<boolean>>().mockResolvedValue(result);
}

function renderEditor({
  topics = TOPICS,
  inv = inventory(),
  busy = false,
  enabled = true,
  onSave = saveMock(),
}: {
  topics?: Topic[];
  inv?: TopicsPayload['inventory'];
  busy?: boolean;
  enabled?: boolean;
  onSave?: SaveMock;
} = {}) {
  render(
    <TopicListEditor
      topics={topics}
      inventory={inv}
      onSave={onSave}
      busy={busy}
      enabled={enabled}
      focusTopic={null}
    />
  );
  return { onSave };
}

const saveButton = () => screen.getByRole('button', { name: /^Save/ });
const addButton = () => screen.getByRole('button', { name: /Add topic/ });

/**
 * A row's disclosure header. A topic's name also appears in its three icon buttons ("Move X up"), so
 * the header is picked out by the one thing only it has: `aria-expanded`.
 */
function queryRowHeader(name: string): HTMLElement | null {
  return (
    screen
      .queryAllByRole('button', { name: new RegExp(name, 'i') })
      .find((b) => b.hasAttribute('aria-expanded')) ?? null
  );
}

function rowHeader(name: string): HTMLElement {
  const header = queryRowHeader(name);
  if (!header) throw new Error(`no row header for ${name}`);
  return header;
}

/** Every row currently on screen. */
const rowHeaders = () =>
  screen.queryAllByRole('button').filter((b) => b.hasAttribute('aria-expanded') && b.closest('li'));

/** Open a row by clicking its collapsed header, and return the row element. */
function openRow(name: string): HTMLElement {
  const header = rowHeader(name);
  fireEvent.click(header);
  const row = header.closest('li');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** The saved drafts, in order. Reading them is the only way the editor's state leaves the component. */
async function savedDrafts(onSave: SaveMock): Promise<DraftTopic[]> {
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  return onSave.mock.calls.at(-1)![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

/* -------------------------------------------------------------------------- */
/* The counts                                                                 */
/* -------------------------------------------------------------------------- */

describe('TopicListEditor — the counts', () => {
  it('states the set’s size and how much of it is conditional', () => {
    renderEditor();

    expect(screen.getByText('4 topics')).toBeInTheDocument();
    expect(screen.getByText(/2 conditional/)).toBeInTheDocument();
  });

  it('says "topic" rather than "topics" for a set of one', () => {
    renderEditor({ topics: [TOPICS[0]] });

    expect(screen.getByText('1 topic')).toBeInTheDocument();
  });

  it('offers nothing to expand when there is only one row', () => {
    renderEditor({ topics: [TOPICS[0]] });

    expect(screen.queryByRole('button', { name: /Expand all/ })).not.toBeInTheDocument();
  });

  it('says so plainly when there are no topics at all', () => {
    renderEditor({ topics: [] });

    expect(screen.getByText(/No topics yet/)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Questions in no topic                                                      */
/* -------------------------------------------------------------------------- */

describe('TopicListEditor — questions in no topic', () => {
  it('stays silent when every question is claimed', () => {
    renderEditor();

    expect(screen.queryByText(/in no topic/)).not.toBeInTheDocument();
  });

  it('counts the orphans, and names them on request rather than leaving a bare number', () => {
    renderEditor({ inv: inventory(['q_orphan']) });

    const toggle = screen.getByRole('button', { name: /1 question in no topic/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(screen.getByText('These questions belong to no topic')).toBeInTheDocument();
    expect(screen.getByText('q_orphan')).toBeInTheDocument();
    expect(screen.getByText('Orphan question q_orphan')).toBeInTheDocument();
  });

  it('pluralises the count', () => {
    renderEditor({ inv: inventory(['q_one', 'q_two']) });

    expect(screen.getByRole('button', { name: /2 questions in no topic/ })).toBeInTheDocument();
  });

  it('collapses the list again on a second click', () => {
    renderEditor({ inv: inventory(['q_orphan']) });

    fireEvent.click(screen.getByRole('button', { name: /1 question in no topic/ }));
    fireEvent.click(screen.getByRole('button', { name: /1 question in no topic/ }));

    expect(screen.queryByText('These questions belong to no topic')).not.toBeInTheDocument();
  });

  it('tracks the live draft: removing the only topic covering a question orphans it at once', () => {
    renderEditor();
    expect(screen.queryByText(/in no topic/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Pricing and packaging' }));

    expect(screen.getByRole('button', { name: /1 question in no topic/ })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Adding, removing, reordering                                               */
/* -------------------------------------------------------------------------- */

describe('TopicListEditor — adding a topic', () => {
  it('appends a conditional topic, opened and ready to fill in', () => {
    renderEditor();

    fireEvent.click(addButton());

    expect(screen.getByText('5 topics')).toBeInTheDocument();
    // The new row is the one showing the placeholder name and its own badge.
    expect(screen.getByText('Untitled topic')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    // Opened, so its Name field is on screen.
    expect(screen.getByPlaceholderText('Site access')).toBeInTheDocument();
  });

  it('gives the new topic an unused key', async () => {
    const { onSave } = renderEditor();

    fireEvent.click(addButton());

    const saved = await savedDrafts(onSave);
    expect(saved.at(-1)!.key).toBe('new_topic');
    expect(new Set(saved.map((d) => d.key)).size).toBe(saved.length);
  });

  it('flags the new row as incomplete rather than letting it look finished', () => {
    renderEditor();

    fireEvent.click(addButton());

    expect(screen.getByText(/No name/)).toBeInTheDocument();
  });
});

describe('TopicListEditor — removing a topic', () => {
  it('drops the row it names, and only that row', async () => {
    const { onSave } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Pricing and packaging' }));

    const saved = await savedDrafts(onSave);
    expect(saved.map((d) => d.key)).toEqual(['spine', 'talent', 'wrap']);
  });
});

describe('TopicListEditor — reordering', () => {
  it('moves a row up in the saved order', async () => {
    const { onSave } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Move Pricing and packaging up' }));

    expect((await savedDrafts(onSave)).map((d) => d.key)).toEqual([
      'pricing',
      'spine',
      'talent',
      'wrap',
    ]);
  });

  it('moves a row down in the saved order', async () => {
    const { onSave } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Move Pricing and packaging down' }));

    expect((await savedDrafts(onSave)).map((d) => d.key)).toEqual([
      'spine',
      'talent',
      'pricing',
      'wrap',
    ]);
  });

  it('cannot move the first row up or the last row down', () => {
    renderEditor();

    expect(screen.getByRole('button', { name: 'Move Company basics up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Anything else down' })).toBeDisabled();
  });

  it('locks reordering while a filter is on, because "up" no longer means the row above', () => {
    renderEditor();

    // `aria-pressed` picks the FILTER chip specifically. Since F17.27 the phase badge on a
    // conditional row reads "Conditional" too — deliberately, so the filter and the thing it
    // filters finally use the same word — which makes a bare name match ambiguous.
    fireEvent.click(screen.getByRole('button', { name: /Conditional/, pressed: false }));

    const up = screen.getByRole('button', { name: 'Move Hiring and capability up' });
    expect(up).toBeDisabled();
    expect(up).toHaveAttribute('title', expect.stringContaining('Clear the filter to reorder'));
  });

  it('offers a drag handle per row, disabled by the same filter rule as the buttons', () => {
    // The handle and the buttons are two ways to do one thing, so they must agree about when it is
    // safe: a drop index under a filter names a position in the visible list, not in the set.
    renderEditor();
    expect(screen.getByRole('button', { name: 'Reorder Company basics' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Conditional/, pressed: false }));

    const handle = screen.getByRole('button', { name: 'Reorder Hiring and capability' });
    expect(handle).toBeDisabled();
    expect(handle).toHaveAttribute('title', expect.stringContaining('Clear the filter to reorder'));
  });

  it('keeps the drag handle out of the row’s expand target', () => {
    // The collapsed line is itself a button. If the handle were inside it, every drag would also
    // toggle the row open — and dnd-kit's own pointer handling would fight the click.
    renderEditor();

    const handle = screen.getByRole('button', { name: 'Reorder Company basics' });
    expect(handle.getAttribute('aria-expanded')).toBeNull();
    expect(handle.closest('[aria-expanded]')).toBeNull();
  });

  it('disables the drag handle while a save is in flight', () => {
    renderEditor({ busy: true });
    expect(screen.getByRole('button', { name: 'Reorder Company basics' })).toBeDisabled();
  });

  describe('the drop itself (reorderDrafts)', () => {
    // dnd-kit reads element geometry and happy-dom reports every rect as zero, so a simulated drag
    // never produces a drop. The behaviour is pinned here instead, on the pure function the drag
    // handler delegates to.
    const rows = [{ clientId: 'a' }, { clientId: 'b' }, { clientId: 'c' }];

    it('moves the dragged row to the drop position', () => {
      expect(reorderDrafts(rows, 'c', 'a')?.map((r) => r.clientId)).toEqual(['c', 'a', 'b']);
      expect(reorderDrafts(rows, 'a', 'c')?.map((r) => r.clientId)).toEqual(['b', 'c', 'a']);
    });

    it('treats a drop outside the list as a no-op, not a move to nowhere', () => {
      // `over` is null when the pointer is released off the list. A findIndex on it returns -1,
      // and an arrayMove to -1 silently sends the row to the END.
      expect(reorderDrafts(rows, 'a', null)).toBeNull();
    });

    it('treats a drop on itself, or on a row no longer in the set, as a no-op', () => {
      expect(reorderDrafts(rows, 'b', 'b')).toBeNull();
      expect(reorderDrafts(rows, 'b', 'gone')).toBeNull();
      expect(reorderDrafts(rows, 'gone', 'b')).toBeNull();
    });

    it('does not mutate the array it was given', () => {
      const before = rows.map((r) => r.clientId);
      reorderDrafts(rows, 'c', 'a');
      expect(rows.map((r) => r.clientId)).toEqual(before);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Filtering                                                                  */
/* -------------------------------------------------------------------------- */

describe('TopicListEditor — filtering', () => {
  it('hides the filter row until the set is worth skimming', () => {
    renderEditor({ topics: TOPICS.slice(0, 3) });

    expect(screen.queryByRole('group', { name: 'Filter topics' })).not.toBeInTheDocument();
  });

  it('narrows the list to conditional topics', () => {
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /^Conditional/ }));

    expect(queryRowHeader('Pricing and packaging')).not.toBeNull();
    expect(queryRowHeader('Company basics')).toBeNull();
  });

  it('narrows the list to the always-asked topics', () => {
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /Always asked/ }));

    expect(queryRowHeader('Company basics')).not.toBeNull();
    expect(queryRowHeader('Pricing and packaging')).toBeNull();
  });

  it('leaves the counts describing the whole set, not the filtered view', () => {
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /^Conditional/ }));

    expect(screen.getByText('4 topics')).toBeInTheDocument();
  });

  it('disables "Needs attention" while nothing needs any', () => {
    renderEditor();

    expect(screen.getByRole('button', { name: /Needs attention/ })).toBeDisabled();
  });

  it('enables "Needs attention" once a row has a problem, and shows only those rows', () => {
    renderEditor();
    fireEvent.click(addButton());

    fireEvent.click(screen.getByRole('button', { name: /Needs attention/ }));

    expect(screen.getByText('Untitled topic')).toBeInTheDocument();
    expect(queryRowHeader('Company basics')).toBeNull();
  });

  it('offers a way back when a filter matches nothing', () => {
    renderEditor({
      topics: [
        topic('a', 'core', 'A', 0),
        topic('b', 'core', 'B', 1),
        topic('c', 'core', 'C', 2),
        topic('d', 'core', 'D', 3),
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /^Conditional/ }));
    expect(screen.getByText(/No topics match this filter/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show all 4/ }));

    expect(rowHeaders()).toHaveLength(4);
  });

  it('clears the filter when a topic is added, so the new row is not filtered out of sight', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Always asked/ }));

    fireEvent.click(addButton());

    expect(screen.getByText('Untitled topic')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
  });
});

/* -------------------------------------------------------------------------- */
/* Expand / collapse                                                          */
/* -------------------------------------------------------------------------- */

describe('TopicListEditor — expanding rows', () => {
  it('starts every row collapsed — a seeded set is long', () => {
    renderEditor();

    expect(screen.queryByPlaceholderText('Site access')).not.toBeInTheDocument();
  });

  it('opens and closes a single row', () => {
    renderEditor();

    openRow('Pricing and packaging');
    expect(screen.getByPlaceholderText('Site access')).toBeInTheDocument();

    fireEvent.click(rowHeader('Pricing and packaging'));
    expect(screen.queryByPlaceholderText('Site access')).not.toBeInTheDocument();
  });

  it('expands every row at once, then collapses them all', () => {
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /Expand all/ }));
    expect(screen.getAllByPlaceholderText('Site access')).toHaveLength(4);

    fireEvent.click(screen.getByRole('button', { name: /Collapse all/ }));
    expect(screen.queryByPlaceholderText('Site access')).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Editing a row                                                              */
/* -------------------------------------------------------------------------- */

describe('TopicListEditor — editing a row', () => {
  it('derives the key from the name while the key is still automatic', async () => {
    const { onSave } = renderEditor();
    fireEvent.click(addButton());

    fireEvent.change(screen.getByPlaceholderText('Site access'), {
      target: { value: 'Site Access & Safety' },
    });

    const added = (await savedDrafts(onSave)).at(-1)!;
    expect(added.label).toBe('Site Access & Safety');
    expect(added.key).toBe('site_access_safety');
  });

  it('stops deriving once the author has hand-set the key', async () => {
    const { onSave } = renderEditor();
    fireEvent.click(addButton());
    const row = screen.getByPlaceholderText('Site access').closest('li')!;
    const keyField = within(row).getAllByRole('textbox')[1];

    fireEvent.change(keyField, { target: { value: 'chosen_by_hand' } });
    fireEvent.change(screen.getByPlaceholderText('Site access'), {
      target: { value: 'A completely different name' },
    });

    const added = (await savedDrafts(onSave)).at(-1)!;
    expect(added.key).toBe('chosen_by_hand');
  });

  it('never derives a key for a topic that came from the server', async () => {
    const { onSave } = renderEditor();
    openRow('Pricing and packaging');

    fireEvent.change(screen.getByPlaceholderText('Site access'), {
      target: { value: 'Renamed entirely' },
    });

    const saved = await savedDrafts(onSave);
    expect(saved.find((d) => d.label === 'Renamed entirely')!.key).toBe('pricing');
  });

  it('clears the derived key when the name is emptied, rather than leaving a stale slug', async () => {
    const { onSave } = renderEditor();
    fireEvent.click(addButton());
    const nameField = screen.getByPlaceholderText('Site access');

    fireEvent.change(nameField, { target: { value: 'Temporary' } });
    fireEvent.change(nameField, { target: { value: '' } });

    expect((await savedDrafts(onSave)).at(-1)!.key).toBe('temporary');
  });

  it('edits the phase and the depth', async () => {
    const { onSave } = renderEditor();
    const row = openRow('Pricing and packaging');
    const [phase, depth] = within(row).getAllByTestId('select');

    fireEvent.change(phase, { target: { value: 'opening' } });
    fireEvent.change(depth, { target: { value: 'light' } });

    const saved = (await savedDrafts(onSave)).find((d) => d.key === 'pricing')!;
    expect(saved.phase).toBe('opening');
    expect(saved.depth).toBe('light');
  });

  it('edits the criteria and the internal note', async () => {
    const { onSave } = renderEditor();
    openRow('Pricing and packaging');

    fireEvent.change(
      screen.getByPlaceholderText('They told us they operate across more than one region.'),
      { target: { value: 'they buy in more than one currency' } }
    );
    fireEvent.change(screen.getByPlaceholderText('Optional'), {
      target: { value: 'note to the next editor' },
    });

    const saved = (await savedDrafts(onSave)).find((d) => d.key === 'pricing')!;
    expect(saved.criteria).toBe('they buy in more than one currency');
    expect(saved.description).toBe('note to the next editor');
  });

  it('warns when a conditional topic has nothing for the agent to judge', () => {
    renderEditor();
    openRow('Pricing and packaging');

    fireEvent.change(
      screen.getByPlaceholderText('They told us they operate across more than one region.'),
      { target: { value: '   ' } }
    );

    expect(screen.getByText(/gives the agent nothing to judge it on/)).toBeInTheDocument();
  });

  it('says criteria are kept but unused on a topic that is never chosen between', () => {
    renderEditor();
    openRow('Company basics');

    expect(screen.getByText(/Kept, but not used/)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Duplicate keys                                                             */
/* -------------------------------------------------------------------------- */

describe('TopicListEditor — duplicate keys', () => {
  it('names the clash and says the save will be rejected', () => {
    renderEditor();
    const row = openRow('Pricing and packaging');
    const keyField = within(row).getAllByRole('textbox')[1];

    fireEvent.change(keyField, { target: { value: 'spine' } });

    expect(screen.getByRole('alert')).toHaveTextContent('Two topics share the key spine');
  });

  it('flags the offending row itself, so the problem is findable in a long list', () => {
    renderEditor();
    const row = openRow('Pricing and packaging');
    fireEvent.change(within(row).getAllByRole('textbox')[1], { target: { value: 'spine' } });

    expect(screen.getAllByText(/Duplicate key/).length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Saving                                                                     */
/* -------------------------------------------------------------------------- */

describe('TopicListEditor — saving', () => {
  it('cannot be saved until something changes', () => {
    renderEditor();

    expect(saveButton()).toBeDisabled();
  });

  it('enables the save once a row is edited', () => {
    renderEditor();

    fireEvent.click(addButton());

    expect(saveButton()).not.toBeDisabled();
  });

  it('stays dirty when the save is rejected, so the edit is not silently lost', async () => {
    const onSave = saveMock(false);
    renderEditor({ onSave });
    fireEvent.click(addButton());

    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());

    await waitFor(() => expect(saveButton()).not.toBeDisabled());
  });

  it('locks the toolbar while a save is in flight', () => {
    renderEditor({ busy: true });

    expect(addButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: /Expand all/ })).toBeDisabled();
  });
});

/* -------------------------------------------------------------------------- */
/* Mid-interview triggers (F17.31a)                                           */
/* -------------------------------------------------------------------------- */

describe('TopicListEditor — a recorded trigger', () => {
  const TRIGGER = {
    condition: 'The applicant discloses that they are fleeing abuse',
    cues: ['abuse'],
    sourceQuote: 'If the applicant discloses, at any stage…',
  };

  function withTrigger(): Topic[] {
    return TOPICS.map((t) => (t.key === 'pricing' ? { ...t, trigger: TRIGGER } : t));
  }

  it('says what the questionnaire asked for, and what will actually happen', async () => {
    // This is the whole reason the record exists before anything acts on it: the admin sees the
    // difference here, on the topic, rather than inferring it from the analyst's gap list.
    renderEditor({ topics: withTrigger() });

    openRow('Pricing and packaging');

    expect(
      await screen.findByText(/The questionnaire said to add this whenever it comes up/)
    ).toBeInTheDocument();
    expect(screen.getByText(/fleeing abuse/)).toBeInTheDocument();
    expect(screen.getByText(/not if it first comes up later/)).toBeInTheDocument();
  });

  it('says nothing at all on a topic without one', () => {
    renderEditor();

    openRow('Pricing and packaging');

    expect(
      screen.queryByText(/The questionnaire said to add this whenever it comes up/)
    ).not.toBeInTheDocument();
  });

  it('keeps it on the saved draft through an edit that has nothing to do with it', async () => {
    // The save replaces the whole set from these drafts. If the editor dropped the field, renaming
    // a topic would silently delete the record — which is exactly the failure worth pinning.
    const { onSave } = renderEditor({ topics: withTrigger() });

    fireEvent.click(screen.getByRole('button', { name: 'Move Pricing and packaging up' }));

    const saved = await savedDrafts(onSave);
    expect(saved.find((d) => d.key === 'pricing')?.trigger).toEqual(TRIGGER);
    expect(saved.find((d) => d.key === 'spine')?.trigger).toBeNull();
  });
});
