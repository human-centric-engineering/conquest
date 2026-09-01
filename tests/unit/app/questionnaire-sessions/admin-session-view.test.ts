/**
 * Unit test: admin session-viewer read seams.
 *
 * Prisma is mocked; the real `normalizeSessionRef` / `narrowToEnum` run. Pins the two behaviours the
 * viewer depends on: identity redaction in anonymous mode (never queries the user table — the same
 * hard gate the PDF export applies), and forgiving ref normalisation before the `publicRef` lookup.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    appQuestionnaireTurn: { groupBy: vi.fn() },
    appQuestionnaireTopic: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  resolveSessionSections: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
// Sectioned interviews (P21): the resolver goes through the live turn-context seam, which is far
// more machinery than this file's subject. Stubbed here; its own behaviour is pinned where it lives.
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-sections', () => ({
  resolveSessionSections: mocks.resolveSessionSections,
  NO_SESSION_SECTIONS: { active: false, sections: [], run: null },
}));

import { LIGHT_DEPTH_MEMBER_COUNT } from '@/lib/app/questionnaire/scope/types';
import {
  askedCount,
  loadAdminSessionView,
  resolveSessionRefLocation,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';

type Mock = ReturnType<typeof vi.fn>;
const findSession = mocks.prisma.appQuestionnaireSession.findUnique as Mock;
const findUser = mocks.prisma.user.findUnique as Mock;
const groupTurns = mocks.prisma.appQuestionnaireTurn.groupBy as Mock;
const findTopics = mocks.prisma.appQuestionnaireTopic.findMany as Mock;
const resolveSections = mocks.resolveSessionSections as Mock;

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    isPreview: false,
    publicRef: '7F3K9M2P',
    versionId: 'v-1',
    respondentUserId: 'user-1',
    version: {
      versionNumber: 2,
      questionnaireId: 'q-1',
      config: { anonymousMode: false },
      questionnaire: { title: 'Onboarding' },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUser.mockResolvedValue({ name: 'Ada' });
  groupTurns.mockResolvedValue([]);
  findTopics.mockResolvedValue([]);
});

/** A stored run: only the GATE. The labels and order come from the resolver. */
function storedRun(entries: Array<Record<string, unknown>>) {
  return { v: 1, activeKey: entries[0]?.key ?? null, sections: entries };
}

function runEntry(over: Record<string, unknown> & { key: string }) {
  return {
    status: 'closed',
    openedAtTurn: 1,
    closedAtTurn: 4,
    closeReason: 'respondent',
    reopenCount: 0,
    turnsSpent: 3,
    ...over,
  };
}

function resolved(
  sections: Array<{ key: string; label: string }>,
  entries: unknown[],
  // Taken from the caller rather than hardcoded: `activeKey` is what marks "where it stopped", so a
  // fixture that always says 'ctx' would let a timeline reading the wrong section pass unnoticed.
  activeKey: string | null = sections[0]?.key ?? null
) {
  return {
    active: true,
    sections: sections.map((s, i) => ({
      key: s.key,
      label: s.label,
      ordinal: i,
      source: 'topics' as const,
      questionKeys: [],
      dataSlotKeys: [],
    })),
    run: { v: 1, activeKey, sections: entries },
  };
}

describe('loadAdminSessionView', () => {
  it('returns null when the session does not exist', async () => {
    findSession.mockResolvedValue(null);
    expect(await loadAdminSessionView('missing')).toBeNull();
  });

  it('maps the row and looks up the respondent name when not anonymous', async () => {
    findSession.mockResolvedValue(sessionRow());
    const view = await loadAdminSessionView('sess-1');
    expect(view).toMatchObject({
      questionnaireId: 'q-1',
      questionnaireTitle: 'Onboarding',
      versionId: 'v-1',
      versionNumber: 2,
      isPreview: false,
      status: 'completed',
      publicRef: '7F3K9M2P',
      anonymous: false,
      respondentName: 'Ada',
    });
    expect(findUser).toHaveBeenCalledOnce();
  });

  it('never queries identity in anonymous mode (respondentName null)', async () => {
    findSession.mockResolvedValue(
      sessionRow({ version: { ...sessionRow().version, config: { anonymousMode: true } } })
    );
    const view = await loadAdminSessionView('sess-1');
    expect(view?.anonymous).toBe(true);
    expect(view?.respondentName).toBeNull();
    expect(findUser).not.toHaveBeenCalled();
  });

  it('narrows an unexpected status to active', async () => {
    findSession.mockResolvedValue(sessionRow({ status: 'bogus' }));
    const view = await loadAdminSessionView('sess-1');
    expect(view?.status).toBe('active');
  });
});

describe('resolveSessionRefLocation', () => {
  function refRow(over: Record<string, unknown> = {}) {
    return {
      id: 'sess-1',
      publicRef: '7F3K9M2P',
      isPreview: true,
      status: 'active',
      versionId: 'v-1',
      version: {
        versionNumber: 2,
        questionnaireId: 'q-1',
        questionnaire: { title: 'Onboarding' },
      },
      ...over,
    };
  }

  it('normalises the ref forgivingly before lookup (dash + lower-case + O/0)', async () => {
    findSession.mockResolvedValue(refRow());
    await resolveSessionRefLocation('7f3k-9m2p');
    expect(findSession).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicRef: '7F3K9M2P' } })
    );
  });

  it('returns null when no session matches', async () => {
    findSession.mockResolvedValue(null);
    expect(await resolveSessionRefLocation('7F3K-9M2P')).toBeNull();
  });

  it('returns the session location when found', async () => {
    findSession.mockResolvedValue(refRow());
    const loc = await resolveSessionRefLocation('7F3K-9M2P');
    expect(loc).toMatchObject({
      sessionId: 'sess-1',
      ref: '7F3K9M2P',
      questionnaireId: 'q-1',
      versionId: 'v-1',
      isPreview: true,
      status: 'active',
    });
  });
});

describe('loadAdminSessionView — where the run stopped (P21)', () => {
  /**
   * `activeKey` is the field behind the timeline's "Where it stopped" badge, and it is the first
   * thing an operator looks for on a stalled session. It is carried straight off the run, so nothing
   * else in the timeline would go wrong if it were dropped or read from the wrong section — which is
   * exactly why it needs its own assertion rather than riding along on the entry tests.
   */
  const entries = [runEntry({ key: 'ctx' }), runEntry({ key: 'prob', status: 'in_progress' })];
  const sections = [
    { key: 'ctx', label: 'Context' },
    { key: 'prob', label: 'Problem' },
  ];

  it('reports the section the run was in when it stopped', async () => {
    findSession.mockResolvedValue(sessionRow({ sectionRun: storedRun(entries) }));
    // Deliberately NOT the first section: a timeline that reported position one would pass a
    // fixture that stopped there, and say nothing about a run that stalled halfway.
    resolveSections.mockResolvedValue(resolved(sections, entries, 'prob'));
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline?.activeKey).toBe('prob');
  });

  it('reports no active section when the run closed every part', async () => {
    // `activeKey` is null once the last section closes. The badge must then appear on no row at all,
    // rather than pinning itself to whichever section happens to sort first.
    findSession.mockResolvedValue(sessionRow({ sectionRun: storedRun(entries) }));
    resolveSections.mockResolvedValue(resolved(sections, entries, null));
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline?.activeKey).toBeNull();
  });
});

describe('loadAdminSessionView — callers that do not want the timeline (P21)', () => {
  const entries = [runEntry({ key: 'ctx' })];

  it('skips the whole resolution when the caller opts out', async () => {
    // The admin transcript route needs the ownership check and the redaction fields, nothing more.
    // Resolving a timeline it will not return costs a full turn-context build plus a grouped read
    // over the turns — the same "pay to be told nothing useful" defect the sectionRun gate exists
    // to prevent, pointed the other way.
    findSession.mockResolvedValue(sessionRow({ sectionRun: storedRun(entries) }));
    const view = await loadAdminSessionView('sess-1', { sectionTimeline: false });
    expect(view?.sectionTimeline).toBeNull();
    expect(resolveSections).not.toHaveBeenCalled();
    expect(groupTurns).not.toHaveBeenCalled();
  });

  it('still resolves it by default, so the viewer page cannot lose it by omission', async () => {
    findSession.mockResolvedValue(sessionRow({ sectionRun: storedRun(entries) }));
    resolveSections.mockResolvedValue(resolved([{ key: 'ctx', label: 'Context' }], entries));
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline?.entries).toHaveLength(1);
  });
});

describe('loadAdminSessionView — the interview plan (P17)', () => {
  /**
   * A stored plan blob. Only the GATE for the query below: every LABEL on the viewer comes from the
   * version's topics, never from the plan, which stores keys.
   */
  function plan(over: Record<string, unknown> = {}) {
    return {
      v: 1,
      topics: [{ key: 'talent', depth: 'full', source: 'analyst', rationale: 'They raised it.' }],
      excluded: [{ key: 'finance', source: 'analyst', rationale: 'Nothing pointed at it.' }],
      checkTopicKey: null,
      confidence: 0.8,
      source: 'analyst',
      respondentMessage: 'We will focus on talent.',
      decidedAtTurn: 3,
      decidedAt: '2026-06-01T10:00:00.000Z',
      ...over,
    };
  }

  const topicRow = (key: string, label: string, members: Record<string, string[]>) => ({
    key,
    label,
    members,
  });

  it('is null, and costs no topic query, for a session that carries no plan', async () => {
    // Every ordinary session. The query is skipped entirely, so the surface as it stood before P17
    // pays nothing for the feature.
    findSession.mockResolvedValue(sessionRow());
    const view = await loadAdminSessionView('sess-1');
    expect(view?.plan).toBeNull();
    expect(findTopics).not.toHaveBeenCalled();
  });

  it('is null when the stored blob is unreadable, rather than a half-built plan', async () => {
    findSession.mockResolvedValue(sessionRow({ interviewPlan: { v: 99 } }));
    expect((await loadAdminSessionView('sess-1'))?.plan).toBeNull();
  });

  it('labels every topic key from the version, on both the selected and excluded halves', async () => {
    // The viewer must never show a bare key: "why did this respondent get those topics" is asked
    // months later, usually by someone who has never seen the key vocabulary.
    findSession.mockResolvedValue(sessionRow({ interviewPlan: plan() }));
    findTopics.mockResolvedValue([
      topicRow('talent', 'Talent & hiring', { questionKeys: [], dataSlotKeys: [] }),
      topicRow('finance', 'Finance', { questionKeys: [], dataSlotKeys: [] }),
    ]);
    const view = await loadAdminSessionView('sess-1');
    expect(view?.plan?.selected.map((t) => t.label)).toEqual(['Talent & hiring']);
    expect(view?.plan?.excluded.map((t) => t.label)).toEqual(['Finance']);
    expect(findTopics).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionId: 'v-1' } })
    );
  });

  it('falls back to the key for a topic deleted since the interview ran', async () => {
    // Dropping it would hide exactly the case an admin is investigating: the interview covered
    // something the instrument no longer has.
    findSession.mockResolvedValue(sessionRow({ interviewPlan: plan() }));
    findTopics.mockResolvedValue([]);
    const view = await loadAdminSessionView('sess-1');
    expect(view?.plan?.selected[0]?.label).toBe('talent');
    expect(view?.plan?.excluded[0]?.label).toBe('finance');
  });

  it('carries the handover message, confidence and decision point through', async () => {
    findSession.mockResolvedValue(sessionRow({ interviewPlan: plan() }));
    const view = await loadAdminSessionView('sess-1');
    expect(view?.plan).toMatchObject({
      respondentMessage: 'We will focus on talent.',
      confidence: 0.8,
      decidedAtTurn: 3,
      decidedAt: '2026-06-01T10:00:00.000Z',
      checkTopicKey: null,
    });
  });

  it('reports the budget the plan was fitted to, and null when the version set none', async () => {
    // With a budget, "why is this topic missing" has an arithmetic answer the viewer can show.
    findSession.mockResolvedValue(
      sessionRow({ interviewPlan: plan({ budgetSeconds: 900, estimatedSeconds: 780 }) })
    );
    expect(await loadAdminSessionView('sess-1').then((v) => v?.plan)).toMatchObject({
      budgetSeconds: 900,
      estimatedSeconds: 780,
    });

    findSession.mockResolvedValue(sessionRow({ interviewPlan: plan() }));
    expect(await loadAdminSessionView('sess-1').then((v) => v?.plan)).toMatchObject({
      budgetSeconds: null,
      estimatedSeconds: null,
    });
  });

  it('says "3 of 5" when the plan named a subset of the topic', async () => {
    // The distinction a challenged report turns on: "we covered Talent" is not the same claim as
    // "we asked three of Talent's five questions".
    findSession.mockResolvedValue(
      sessionRow({
        interviewPlan: plan({
          topics: [
            {
              key: 'talent',
              depth: 'full',
              source: 'analyst',
              rationale: 'r',
              members: { questionKeys: ['q1', 'q2', 'q3'], dataSlotKeys: [] },
            },
          ],
        }),
      })
    );
    findTopics.mockResolvedValue([
      topicRow('talent', 'Talent', {
        questionKeys: ['q1', 'q2', 'q3', 'q4', 'q5'],
        dataSlotKeys: [],
      }),
    ]);
    const view = await loadAdminSessionView('sess-1');
    expect(view?.plan?.selected[0]?.partial).toEqual({ asked: 3, total: 5 });
  });

  it('counts the two halves separately, so an un-named half reads as the depth and not as nothing', async () => {
    // The regression `askedCount` exists for, asserted through the surface that renders it: a plan
    // narrowing the questions leaves the data slots to the depth, and `full` takes all of them.
    findSession.mockResolvedValue(
      sessionRow({
        interviewPlan: plan({
          topics: [
            {
              key: 'talent',
              depth: 'full',
              source: 'analyst',
              rationale: 'r',
              members: { questionKeys: ['q1'], dataSlotKeys: [] },
            },
          ],
        }),
      })
    );
    findTopics.mockResolvedValue([
      topicRow('talent', 'Talent', {
        questionKeys: ['q1', 'q2', 'q3'],
        dataSlotKeys: ['s1', 's2'],
      }),
    ]);
    const view = await loadAdminSessionView('sess-1');
    // 1 named question + both data slots at `full` depth = 3 of 5, NOT 1 of 5.
    expect(view?.plan?.selected[0]?.partial).toEqual({ asked: 3, total: 5 });
  });

  it('omits the partial line when the plan took the whole topic', async () => {
    findSession.mockResolvedValue(
      sessionRow({
        interviewPlan: plan({
          topics: [
            {
              key: 'talent',
              depth: 'full',
              source: 'analyst',
              rationale: 'r',
              members: { questionKeys: ['q1', 'q2'], dataSlotKeys: [] },
            },
          ],
        }),
      })
    );
    findTopics.mockResolvedValue([
      topicRow('talent', 'Talent', { questionKeys: ['q1', 'q2'], dataSlotKeys: [] }),
    ]);
    const view = await loadAdminSessionView('sess-1');
    expect(view?.plan?.selected[0]?.partial).toBeUndefined();
  });

  it('omits the partial line for a topic the plan never narrowed', async () => {
    findSession.mockResolvedValue(sessionRow({ interviewPlan: plan() }));
    findTopics.mockResolvedValue([
      topicRow('talent', 'Talent', { questionKeys: ['q1', 'q2'], dataSlotKeys: [] }),
    ]);
    const view = await loadAdminSessionView('sess-1');
    expect(view?.plan?.selected[0]?.partial).toBeUndefined();
  });

  it('omits the partial line for a topic the version no longer carries', async () => {
    // No authored membership to count against, so "3 of ?" is unanswerable — and a fabricated
    // denominator would read as fact.
    findSession.mockResolvedValue(
      sessionRow({
        interviewPlan: plan({
          topics: [
            {
              key: 'talent',
              depth: 'full',
              source: 'analyst',
              rationale: 'r',
              members: { questionKeys: ['q1'], dataSlotKeys: [] },
            },
          ],
        }),
      })
    );
    findTopics.mockResolvedValue([]);
    const view = await loadAdminSessionView('sess-1');
    expect(view?.plan?.selected[0]?.partial).toBeUndefined();
  });
});

describe('askedCount — how much of one half of a topic an interview asked (C6)', () => {
  const authored = ['a', 'b', 'c', 'd'];

  it('counts a named subset, ignoring keys the topic no longer contains', () => {
    // The instrument can be edited after an interview ran, so a plan can name a key that is gone.
    expect(askedCount(authored, ['a', 'c', 'deleted-since'], 'full')).toBe(2);
  });

  it('falls to the depth for an un-named half rather than reading it as nothing asked', () => {
    // The regression this pins: an un-named half is stored EMPTY, meaning "the depth decides".
    // Counting it as a named-but-empty subset would report "1 of 8 asked" on an interview that
    // asked six things.
    expect(askedCount(authored, [], 'full')).toBe(4);
    expect(askedCount(authored, undefined, 'full')).toBe(4);
    expect(askedCount(authored, [], 'light')).toBe(LIGHT_DEPTH_MEMBER_COUNT);
  });

  it('falls to the depth when nothing named survives the intersection', () => {
    // Same rule the guardrails apply when seating: an empty intersection is not a narrowing.
    expect(askedCount(authored, ['gone', 'also-gone'], 'light')).toBe(LIGHT_DEPTH_MEMBER_COUNT);
  });

  it('never reports more than the topic contains', () => {
    expect(askedCount(['only'], [], 'light')).toBe(1);
    expect(askedCount([], [], 'full')).toBe(0);
  });
});

describe('loadAdminSessionView — section timeline (P21)', () => {
  it('is null, and costs nothing to resolve, for an unsectioned session', async () => {
    // The gate. Every session predating P21 has a null `sectionRun`, and none of them should pay a
    // turn-context build to be told the feature is off.
    findSession.mockResolvedValue(sessionRow());
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline).toBeNull();
    expect(resolveSections).not.toHaveBeenCalled();
    expect(groupTurns).not.toHaveBeenCalled();
  });

  it('is null when the run blob is stored but unreadable', async () => {
    // A malformed blob degrades to "not sectioned", the direction every P21 narrower takes.
    findSession.mockResolvedValue(sessionRow({ sectionRun: { v: 99, sections: [] } }));
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline).toBeNull();
    expect(resolveSections).not.toHaveBeenCalled();
  });

  it('numbers and labels the sections from the resolver, not from the stored run', async () => {
    const entries = [runEntry({ key: 'prob' }), runEntry({ key: 'ctx' })];
    findSession.mockResolvedValue(sessionRow({ sectionRun: storedRun(entries) }));
    resolveSections.mockResolvedValue(
      // The run lists them the other way round; the resolved sections are the ordering authority.
      resolved(
        [
          { key: 'ctx', label: 'Context' },
          { key: 'prob', label: 'Problem' },
        ],
        entries
      )
    );
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline?.entries.map((e) => [e.position, e.label])).toEqual([
      [1, 'Context'],
      [2, 'Problem'],
    ]);
  });

  it('carries the close reason and the reopen count through', async () => {
    const entries = [runEntry({ key: 'ctx', closeReason: 'cap', reopenCount: 2, turnsSpent: 9 })];
    findSession.mockResolvedValue(sessionRow({ sectionRun: storedRun(entries) }));
    resolveSections.mockResolvedValue(resolved([{ key: 'ctx', label: 'Context' }], entries));
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline?.entries[0]).toMatchObject({
      // The one reason that says the section closed WITHOUT its gate being satisfied.
      closeReason: 'cap',
      reopenCount: 2,
      turnsSpent: 9,
      stale: false,
    });
  });

  it('sums spend per section from the turn rows', async () => {
    const entries = [runEntry({ key: 'ctx' }), runEntry({ key: 'prob' })];
    findSession.mockResolvedValue(sessionRow({ sectionRun: storedRun(entries) }));
    resolveSections.mockResolvedValue(
      resolved(
        [
          { key: 'ctx', label: 'Context' },
          { key: 'prob', label: 'Problem' },
        ],
        entries
      )
    );
    groupTurns.mockResolvedValue([
      { sectionKey: 'ctx', _sum: { costUsd: 0.42 } },
      // Turns belonging to no section group under null and are never looked up.
      { sectionKey: null, _sum: { costUsd: 9.99 } },
    ]);
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline?.entries.map((e) => e.costUsd)).toEqual([0.42, null]);
  });

  it('reads a section with no recorded spend as unknown rather than free', async () => {
    // "We did not record it" and "it was free" are different claims, and only one is true.
    const entries = [runEntry({ key: 'ctx' })];
    findSession.mockResolvedValue(sessionRow({ sectionRun: storedRun(entries) }));
    resolveSections.mockResolvedValue(resolved([{ key: 'ctx', label: 'Context' }], entries));
    groupTurns.mockResolvedValue([{ sectionKey: 'ctx', _sum: { costUsd: null } }]);
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline?.entries[0]?.costUsd).toBeNull();
  });

  it('keeps a section the version no longer carries, marked stale', async () => {
    // Turns were tagged with it. Dropping the row would leave them belonging to nothing while the
    // timeline claimed to account for the whole run.
    const entries = [runEntry({ key: 'ctx' }), runEntry({ key: 'deleted-topic' })];
    findSession.mockResolvedValue(sessionRow({ sectionRun: storedRun(entries) }));
    resolveSections.mockResolvedValue(resolved([{ key: 'ctx', label: 'Context' }], entries));
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline?.entries.map((e) => [e.key, e.label, e.stale])).toEqual([
      ['ctx', 'Context', false],
      ['deleted-topic', 'deleted-topic', true],
    ]);
  });

  it('reads a section with no run entry as never opened', async () => {
    const entries = [runEntry({ key: 'ctx' })];
    findSession.mockResolvedValue(sessionRow({ sectionRun: storedRun(entries) }));
    resolveSections.mockResolvedValue(
      resolved(
        [
          { key: 'ctx', label: 'Context' },
          { key: 'later', label: 'Appetite' },
        ],
        entries
      )
    );
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline?.entries[1]).toMatchObject({
      status: 'not_started',
      openedAtTurn: 0,
      turnsSpent: 0,
    });
  });

  it('is null when the resolver finds the interview was not sectioned after all', async () => {
    // A blob banked before the version dropped below two resolvable sections.
    findSession.mockResolvedValue(
      sessionRow({ sectionRun: storedRun([runEntry({ key: 'ctx' })]) })
    );
    resolveSections.mockResolvedValue({ active: false, sections: [], run: null });
    const view = await loadAdminSessionView('sess-1');
    expect(view?.sectionTimeline).toBeNull();
  });
});
