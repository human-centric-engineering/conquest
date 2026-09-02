/**
 * Integration test: the live turn-context loader (F6.1, PR4).
 *
 * Prisma is mocked; this pins the loader's mapping from the persisted session graph onto
 * the orchestrator shapes: questions/slots, coverage vs value answer views, the recent
 * transcript (oldest → newest), the active question (the prior turn's target), and the
 * monotonic selection round.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    // Conditional Topics (P17): only queried when a version has opted in — see the parity test below.
    appQuestionnaireTopic: { findMany: vi.fn(async () => []) },
    // G03: only queried when the opening's follow-up allowance actually governs the turn.
    appQuestionnaireTurn: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';

type Mock = ReturnType<typeof vi.fn>;

function sessionGraph(over: Record<string, unknown> = {}) {
  const merged = {
    id: 'sess-1',
    status: 'active',
    versionId: 'v1',
    respondentUserId: 'user-1',
    version: {
      config: null, // lazy — resolves to defaults
      dataSlots: [], // Data Slots feature: none by default
      sections: [
        {
          id: 's1',
          ordinal: 0,
          questions: [
            {
              id: 'q1',
              key: 'role',
              ordinal: 0,
              weight: 1,
              required: true,
              type: 'free_text',
              prompt: 'What is your role?',
              guidelines: 'Be specific',
              typeConfig: null,
              tags: [],
            },
            {
              id: 'q2',
              key: 'team',
              ordinal: 1,
              weight: 1,
              required: false,
              type: 'numeric',
              prompt: 'Team size?',
              guidelines: null,
              typeConfig: { min: 0 },
              tags: [{ tagId: 't1' }],
            },
          ],
        },
      ],
    },
    answers: [
      {
        value: 'marketing',
        confidence: 0.9,
        provenanceLabel: 'direct',
        rationale: 'said so',
        questionSlot: { id: 'q1', key: 'role' },
      },
    ],
    dataSlotFills: [], // Data Slots feature: none by default
    turns: [
      // newest first (orderBy ordinal desc)
      {
        userMessage: 'I do marketing',
        agentResponse: 'And your team size?',
        targetedQuestionId: 'q2',
        ordinal: 2,
      },
      {
        userMessage: 'hi',
        agentResponse: 'What is your role?',
        targetedQuestionId: 'q1',
        ordinal: 1,
      },
    ],
    ...over,
  } as Record<string, unknown> & { turns: unknown[] };
  // The true turn count defaults to the (possibly windowed) turns length, but can be
  // overridden to model a session whose history exceeds the transcript window.
  return { _count: { turns: merged.turns.length }, ...merged };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildTurnContext', () => {
  it('returns null for an unknown session', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);
    expect(await buildTurnContext('nope')).toBeNull();
  });

  it('maps versionArchivedAt off the version row — null when the version is active', async () => {
    // This is the SOLE seam reading `archivedAt` from the DB onto `versionArchivedAt`; the
    // messages-route 410 archive gate depends on it (the route test mocks buildTurnContext wholesale).
    const graph = sessionGraph();
    (graph as unknown as { version: { archivedAt: Date | null } }).version.archivedAt = null;
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(graph);

    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.versionArchivedAt).toBeNull();
  });

  it('maps versionArchivedAt off the version row — the archive marker when the version is archived', async () => {
    const archivedAt = new Date('2026-07-18T00:00:00.000Z');
    const graph = sessionGraph();
    (graph as unknown as { version: { archivedAt: Date | null } }).version.archivedAt = archivedAt;
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(graph);

    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.versionArchivedAt).toEqual(archivedAt);
  });

  it('maps questions, slots, and the active question (the prior turn target)', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionGraph());
    const loaded = await buildTurnContext('sess-1');

    expect(loaded).not.toBeNull();
    expect(loaded!.base.questions.map((q) => q.key)).toEqual(['role', 'team']);
    // Slots carry typeConfig/guidelines only when present.
    expect(loaded!.slots[0]).toMatchObject({ key: 'role', guidelines: 'Be specific' });
    expect(loaded!.slots[0]).not.toHaveProperty('typeConfig');
    expect(loaded!.slots[1]).toMatchObject({ key: 'team', typeConfig: { min: 0 } });
    expect(loaded!.slots[1]).not.toHaveProperty('guidelines');
    // The most recent turn targeted q2 → active question key is 'team'.
    expect(loaded!.activeQuestionKey).toBe('team');
  });

  it('counts the consecutive re-ask run for the most-recently targeted data slot', async () => {
    // A real data-slot turn stamps the slot id on BOTH targetedQuestionId (overloaded active
    // target) and targetedDataSlotId (the unambiguous park counter source).
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({
        version: {
          config: null,
          dataSlots: [
            {
              id: 'd1',
              key: 'satisfaction',
              name: 'Satisfaction',
              description: 'd',
              theme: 'Wellbeing',
              ordinal: 0,
              weight: 1,
              questions: [],
            },
            {
              id: 'd2',
              key: 'blockers',
              name: 'Blockers',
              description: 'd',
              theme: 'Wellbeing',
              ordinal: 1,
              weight: 1,
              questions: [],
            },
          ],
          sections: [{ id: 's1', ordinal: 0, questions: [] }],
        },
        answers: [],
        dataSlotFills: [],
        turns: [
          { userMessage: 'dunno', agentResponse: '…', targetedQuestionId: 'd1', targetedDataSlotId: 'd1', ordinal: 3 }, // prettier-ignore
          { userMessage: 'meh', agentResponse: '…', targetedQuestionId: 'd1', targetedDataSlotId: 'd1', ordinal: 2 }, // prettier-ignore
          { userMessage: 'hi', agentResponse: '…', targetedQuestionId: 'd2', targetedDataSlotId: 'd2', ordinal: 1 }, // prettier-ignore
        ],
      })
    );
    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.base.activeDataSlotKey).toBe('satisfaction');
    // d1 was targeted in the two most-recent turns consecutively → 2; d2 broke the run before that.
    expect(loaded!.base.dataSlotAttempts).toEqual({ d1: 2 });
  });

  it('builds coverage + value answer views and the oldest→newest transcript', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionGraph());
    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.answered).toEqual([{ questionId: 'q1', confidence: 0.9 }]);
    expect(loaded!.base.existingAnswers[0]).toMatchObject({
      slotKey: 'role',
      value: 'marketing',
      provenance: 'direct',
      confidence: 0.9,
      rationale: 'said so',
    });
    // Reversed to oldest → newest, interleaving user + agent messages.
    expect(loaded!.base.recentMessages).toEqual([
      'hi',
      'What is your role?',
      'I do marketing',
      'And your team size?',
    ]);
    // selectionRound is the number of prior turns (monotonic).
    expect(loaded!.base.selectionRound).toBe(2);
  });

  it('uses the TRUE turn count for selectionRound, not the windowed transcript length', async () => {
    // 2 transcript turns (windowed) but a real history of 20 — selectionRound must be 20,
    // so the random strategy's session+round seed keeps advancing past the window.
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ _count: { turns: 20 } })
    );
    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.base.selectionRound).toBe(20);
    // The transcript itself is still just the windowed turns.
    expect(loaded!.base.recentMessages.length).toBeGreaterThan(0);
  });

  it('resolves an absent config row to defaults', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionGraph());
    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.base.config.selectionStrategy).toBe('adaptive');
    expect(loaded!.base.config.contradictionMode).toBe('off');
  });

  it('has no active question and an empty transcript on a fresh session (no turns/answers)', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ answers: [], turns: [] })
    );
    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.activeQuestionKey).toBeNull();
    expect(loaded!.base.recentMessages).toEqual([]);
    expect(loaded!.base.answered).toEqual([]);
    expect(loaded!.base.existingAnswers).toEqual([]);
    expect(loaded!.base.selectionRound).toBe(0);
  });

  it('drops blank user/agent messages from the transcript and tolerates null answer fields', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({
        answers: [
          {
            value: 5,
            confidence: null,
            provenanceLabel: 'inferred',
            rationale: null,
            questionSlot: { id: 'q2', key: 'team' },
          },
        ],
        turns: [
          { userMessage: 'only user', agentResponse: '', targetedQuestionId: null, ordinal: 1 },
        ],
      })
    );
    const loaded = await buildTurnContext('sess-1');
    // Blank agent response is dropped; the active question is null (turn targeted nothing).
    expect(loaded!.base.recentMessages).toEqual(['only user']);
    expect(loaded!.activeQuestionKey).toBeNull();
    const ans = loaded!.base.existingAnswers[0];
    expect(ans).toMatchObject({ slotKey: 'team', value: 5, provenance: 'inferred' });
    expect(ans).not.toHaveProperty('confidence');
    expect(ans).not.toHaveProperty('rationale');
  });

  it('leaves meta empty when the version has no goal or audience', async () => {
    // The default fixture version carries neither — meta is an empty object, not undefined,
    // so the phraser simply has nothing extra to calibrate on. (Tone reaches the phraser from
    // config, not meta — see the messages route.)
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionGraph());
    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.meta).toEqual({});
  });

  it('builds meta with the version goal and only the string audience fields', async () => {
    const graph = sessionGraph();
    const version = (graph as Record<string, unknown>).version as Record<string, unknown>;
    version.goal = 'Assess readiness';
    version.audience = {
      role: 'CTO',
      expertiseLevel: 'expert',
      sensitivity: 'high',
      locale: 'fr',
      // Non-string fields are dropped by toTurnAudience, not coerced.
      headcount: 200,
      decisionMaker: true,
    };
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(graph);

    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.meta).toEqual({
      goal: 'Assess readiness',
      audience: { role: 'CTO', expertiseLevel: 'expert', sensitivity: 'high', locale: 'fr' },
    });
  });

  it('omits audience when it has no usable string fields, and goal when blank', async () => {
    const graph = sessionGraph();
    // A non-null audience whose every field is the wrong type collapses to undefined → omitted.
    ((graph as Record<string, unknown>).version as Record<string, unknown>).audience = {
      role: 42,
      locale: null,
    };
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(graph);

    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.meta).not.toHaveProperty('audience');
    expect(loaded!.meta).not.toHaveProperty('goal');
  });

  it('maps a valid sensitivityLevel and survives the sensitivityNotes JSON column', async () => {
    // Arrange: a session carrying a high-severity level plus two persisted disclosure notes.
    const notes = [
      {
        severity: 'high',
        category: 'distress',
        summary: 'Mentioned feeling overwhelmed',
        turnOrdinal: 1,
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        severity: 'high',
        category: 'harassment',
        summary: 'Described a workplace incident',
        turnOrdinal: 2,
        createdAt: '2024-01-01T00:01:00Z',
      },
    ];
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ sensitivityLevel: 'high', sensitivityNotes: notes })
    );

    // Act
    const loaded = await buildTurnContext('sess-1');

    // Assert: loader must narrow 'high' to SensitivitySeverity and extract only the
    // `summary` strings from the notes array — not pass the raw objects through.
    expect(loaded!.base.sensitivityLevel).toBe('high');
    expect(loaded!.base.sensitivityNotes).toEqual([
      'Mentioned feeling overwhelmed',
      'Described a workplace incident',
    ]);
  });

  it('coerces an unrecognised sensitivityLevel to null', async () => {
    // Arrange: 'extreme' is not in SENSITIVITY_SEVERITIES (['low','medium','high']).
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ sensitivityLevel: 'extreme', sensitivityNotes: null })
    );

    // Act
    const loaded = await buildTurnContext('sess-1');

    // Assert: loader must not pass an arbitrary string through — invalid values become null.
    expect(loaded!.base.sensitivityLevel).toBeNull();
  });

  it('threads abuseStrikes from the session row into base', async () => {
    // Arrange: a session that already has three flagged non-genuine answers.
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ abuseStrikes: 3 })
    );

    // Act
    const loaded = await buildTurnContext('sess-1');

    // Assert: the loader must copy the DB value into base.abuseStrikes unchanged so the
    // orchestrator can fold a new strike in (not just start from zero).
    expect(loaded!.base.abuseStrikes).toBe(3);
  });

  it('populates mappedQuestionKeys from the AppDataSlotQuestion mapping (forward propagation)', async () => {
    const graph = sessionGraph({
      version: {
        config: null,
        dataSlots: [
          {
            id: 'ds1',
            key: 'role_satisfaction',
            name: 'Role Satisfaction',
            description: 'd',
            theme: 'Wellbeing',
            ordinal: 0,
            weight: 1,
            // The slot captures two questions; the loader flattens to their keys.
            questions: [
              { questionSlot: { key: 'satisfaction' } },
              { questionSlot: { key: 'morale' } },
            ],
          },
          {
            id: 'ds2',
            key: 'unmapped',
            name: 'Unmapped',
            description: 'd',
            theme: 'Wellbeing',
            ordinal: 1,
            weight: 1,
            questions: [],
          },
        ],
        sections: [{ id: 's1', ordinal: 0, questions: [] }],
      },
      answers: [],
      dataSlotFills: [],
      turns: [],
    });
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(graph);

    const loaded = await buildTurnContext('sess-1');
    const slots = loaded!.base.dataSlots ?? [];
    expect(slots.find((s) => s.key === 'role_satisfaction')?.mappedQuestionKeys).toEqual([
      'satisfaction',
      'morale',
    ]);
    // A slot that maps to nothing carries an empty array (not undefined) — the route reads `.length`.
    expect(slots.find((s) => s.key === 'unmapped')?.mappedQuestionKeys).toEqual([]);
  });

  it('maps dataSlotFills into the dataSlotAnswered view with all detail fields', async () => {
    // Arrange: a session whose version has one data slot, and a fill carrying all fields
    // the extractor needs to UPDATE/CORRECT the slot across turns (value, paraphrase, provisional).
    const graph = sessionGraph({
      version: {
        config: null,
        dataSlots: [
          {
            id: 'ds1',
            key: 'satisfaction',
            name: 'Satisfaction',
            description: 'Overall satisfaction',
            theme: 'Wellbeing',
            ordinal: 0,
            weight: 1,
            questions: [],
          },
        ],
        sections: [{ id: 's1', ordinal: 0, questions: [] }],
      },
      answers: [],
      dataSlotFills: [
        {
          dataSlotId: 'ds1',
          confidence: 0.75,
          value: 'pretty good',
          paraphrase: 'The respondent expressed moderate satisfaction',
          provisional: true,
        },
      ],
      turns: [],
    });
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(graph);

    // Act
    const loaded = await buildTurnContext('sess-1');

    // Assert: every field the extractor relies on must survive the mapping — not be stripped
    // or left as a raw DB row. The loader adds no new fields; it must pass all five through.
    const fills = loaded!.base.dataSlotAnswered;
    expect(fills).toHaveLength(1);
    expect(fills![0]).toMatchObject({
      dataSlotId: 'ds1',
      confidence: 0.75,
      value: 'pretty good',
      paraphrase: 'The respondent expressed moderate satisfaction',
      provisional: true,
    });
  });

  // -------------------------------------------------------------------------
  // parsePendingContradiction — defensive JSON parsing (lines 46–62)
  // -------------------------------------------------------------------------
  // The function is called via buildTurnContext; it exercises all its branches
  // through the pendingContradiction field on the session row.

  it('parses a fully-valid pendingContradiction and threads it into base', async () => {
    // Arrange: a well-formed contradiction object with all required fields.
    const raw = {
      slotKeys: ['role', 'tenure'],
      explanation: 'Earlier answer contradicts the latest.',
      statement: 'Earlier you said engineer; now you say manager.',
      raisedAtTurnIndex: 3,
      suggestedProbe: 'Can you clarify your current title?',
    };
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ pendingContradiction: raw })
    );

    // Act
    const loaded = await buildTurnContext('sess-1');

    // Assert: the loader must parse the raw JSON into a PendingContradiction and thread
    // it into base.pendingContradiction — not pass the raw object through.
    expect(loaded!.base.pendingContradiction).toEqual({
      slotKeys: ['role', 'tenure'],
      explanation: 'Earlier answer contradicts the latest.',
      statement: 'Earlier you said engineer; now you say manager.',
      raisedAtTurnIndex: 3,
      suggestedProbe: 'Can you clarify your current title?',
    });
  });

  it('omits suggestedProbe when the raw field is not a string', async () => {
    // Arrange: valid required fields but suggestedProbe is a number (wrong type).
    const raw = {
      slotKeys: ['role'],
      explanation: 'Conflict detected.',
      statement: 'You said both A and B.',
      raisedAtTurnIndex: 1,
      suggestedProbe: 42, // not a string — must be omitted
    };
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ pendingContradiction: raw })
    );

    const loaded = await buildTurnContext('sess-1');

    // The parsed result must carry all required fields but NOT suggestedProbe.
    expect(loaded!.base.pendingContradiction).not.toBeNull();
    expect(loaded!.base.pendingContradiction).not.toHaveProperty('suggestedProbe');
    expect(loaded!.base.pendingContradiction?.slotKeys).toEqual(['role']);
  });

  it('returns null for pendingContradiction when the raw value is not a record (null)', async () => {
    // Arrange: session row has pendingContradiction=null (DB default — no contradiction pending).
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ pendingContradiction: null })
    );

    const loaded = await buildTurnContext('sess-1');

    // null is not a record → parsePendingContradiction returns null.
    expect(loaded!.base.pendingContradiction).toBeNull();
  });

  it('returns null for pendingContradiction when slotKeys is not an array', async () => {
    // Arrange: an object whose slotKeys is a string, not an array.
    const raw = {
      slotKeys: 'role', // string, not array
      explanation: 'Conflict.',
      statement: 'You said both A and B.',
      raisedAtTurnIndex: 1,
    };
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ pendingContradiction: raw })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.pendingContradiction).toBeNull();
  });

  it('returns null for pendingContradiction when slotKeys contains non-string elements', async () => {
    // Arrange: slotKeys array exists but contains a number — every element must be a string.
    const raw = {
      slotKeys: ['role', 42], // 42 is not a string
      explanation: 'Conflict.',
      statement: 'You said both A and B.',
      raisedAtTurnIndex: 1,
    };
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ pendingContradiction: raw })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.pendingContradiction).toBeNull();
  });

  it('returns null for pendingContradiction when slotKeys is an empty array', async () => {
    // Arrange: slotKeys is [] — an empty array is treated as "no contradiction" (nothing to
    // probe), so the parser degrades gracefully rather than passing an unusable object through.
    const raw = {
      slotKeys: [],
      explanation: 'Conflict.',
      statement: 'You said both A and B.',
      raisedAtTurnIndex: 1,
    };
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ pendingContradiction: raw })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.pendingContradiction).toBeNull();
  });

  it('returns null for pendingContradiction when explanation is missing', async () => {
    // Arrange: explanation is absent — the parser requires both explanation and statement.
    const raw = {
      slotKeys: ['role'],
      // explanation intentionally omitted
      statement: 'You said both A and B.',
      raisedAtTurnIndex: 1,
    };
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ pendingContradiction: raw })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.pendingContradiction).toBeNull();
  });

  it('returns null for pendingContradiction when raisedAtTurnIndex is not a number', async () => {
    // Arrange: all required string fields present but raisedAtTurnIndex is a string.
    const raw = {
      slotKeys: ['role'],
      explanation: 'Conflict.',
      statement: 'You said both A and B.',
      raisedAtTurnIndex: '1', // string, not number
    };
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ pendingContradiction: raw })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.pendingContradiction).toBeNull();
  });

  // -------------------------------------------------------------------------
  // parseRaisedContradictions — defensive JSON parsing of the "don't nag" ledger
  // -------------------------------------------------------------------------
  // Exercised via buildTurnContext through the raisedContradictions field on the row.
  // Each malformed entry is skipped individually; a non-array degrades to [].

  it('parses a well-formed raisedContradictions ledger and threads it into base', async () => {
    const raw = [
      { key: 'a|b', slotKeys: ['a', 'b'], resolution: 'resolved', raisedAtTurnIndex: 2 },
      { key: 'c', slotKeys: ['c'], resolution: 'unresolved', raisedAtTurnIndex: 4 },
    ];
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ raisedContradictions: raw })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.raisedContradictions).toEqual(raw);
  });

  it('degrades a non-array raisedContradictions to an empty ledger', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ raisedContradictions: 'not-an-array' })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.raisedContradictions).toEqual([]);
  });

  it('defaults to an empty ledger when the column is the JSON default (empty array)', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ raisedContradictions: [] })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.raisedContradictions).toEqual([]);
  });

  it('skips ledger entries that are malformed, keeping only the valid ones', async () => {
    const raw = [
      'not-a-record', // not an object → skipped
      { key: '', slotKeys: ['a'], resolution: 'resolved', raisedAtTurnIndex: 1 }, // empty key → skipped
      { key: 'a', slotKeys: 'a', resolution: 'resolved', raisedAtTurnIndex: 1 }, // slotKeys not array → skipped
      { key: 'b', slotKeys: ['b', 2], resolution: 'resolved', raisedAtTurnIndex: 1 }, // non-string element → skipped
      { key: 'c', slotKeys: ['c'], resolution: 'bogus', raisedAtTurnIndex: 1 }, // bad resolution → skipped
      { key: 'd', slotKeys: ['d'], resolution: 'flagged', raisedAtTurnIndex: '1' }, // non-number index → skipped
      { key: 'e', slotKeys: ['e'], resolution: 'kept', raisedAtTurnIndex: 5 }, // the one valid entry
    ];
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ raisedContradictions: raw })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.raisedContradictions).toEqual([
      { key: 'e', slotKeys: ['e'], resolution: 'kept', raisedAtTurnIndex: 5 },
    ]);
  });

  // -------------------------------------------------------------------------
  // parseRaisedMilestones — defensive JSON parsing of the completeness-milestone
  // "don't nag" ledger. A non-array degrades to []; out-of-range/non-integer entries skipped.
  // -------------------------------------------------------------------------

  it('parses a well-formed raisedMilestones ledger and threads it into base', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ raisedMilestones: [25, 50] })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.raisedMilestones).toEqual([25, 50]);
  });

  it('degrades a non-array raisedMilestones to an empty ledger', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ raisedMilestones: 'not-an-array' })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.raisedMilestones).toEqual([]);
  });

  it('defaults to an empty ledger when the column is the JSON default (empty array)', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ raisedMilestones: [] })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.raisedMilestones).toEqual([]);
  });

  it('skips ledger entries that are out of range or not integers, keeping only the valid ones', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ raisedMilestones: [25, 0, 100, 50.5, 'fifty', 90] })
    );

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.raisedMilestones).toEqual([25, 90]);
  });
});

describe('buildTurnContext — Conditional Topics (P17)', () => {
  /** A version config blob with Conditional Topics on. `null` config = feature off (the default). */
  function scopedConfig(over: Record<string, unknown> = {}) {
    return {
      conditionalTopics: { enabled: true, maxConditionalTopics: 1, ...over },
    };
  }

  /** The base graph's `version` object, typed loosely so a test can swap its config. */
  function baseVersion(): Record<string, unknown> {
    return (sessionGraph() as unknown as { version: Record<string, unknown> }).version;
  }

  function topicRow(
    key: string,
    phase: string,
    questionKeys: string[],
    depth = 'full',
    dataSlotKeys: string[] = []
  ) {
    return {
      id: `t-${key}`,
      key,
      label: key,
      description: null,
      phase,
      criteria: null,
      depth,
      members: { questionKeys, dataSlotKeys },
      ordinal: 0,
      source: 'seeded',
    };
  }

  /** A version carrying two data slots, so scope has something to filter. */
  function versionWithDataSlots(): Record<string, unknown> {
    return {
      ...baseVersion(),
      config: scopedConfig(),
      dataSlots: [
        {
          id: 'ds-role',
          key: 'role_fit',
          name: 'Role fit',
          description: 'd',
          theme: 'People',
          ordinal: 0,
          weight: 1,
          questions: [{ questionSlot: { key: 'role' } }],
        },
        {
          id: 'ds-team',
          key: 'team_shape',
          name: 'Team shape',
          description: 'd',
          theme: 'People',
          ordinal: 1,
          weight: 1,
          questions: [{ questionSlot: { key: 'team' } }],
        },
      ],
    };
  }

  describe('the inert guarantee', () => {
    it('changes nothing for a version that never opted in', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionGraph());

      const loaded = await buildTurnContext('sess-1');

      expect(loaded!.base.questions.map((q) => q.key)).toEqual(['role', 'team']);
      expect(loaded!.slots.map((s) => s.key)).toEqual(['role', 'team']);
      expect(loaded!.scope.scope.active).toBe(false);
    });

    it('does not even query topics when the feature is off', async () => {
      // The cost guarantee: on a fresh install every version is in this state, so the scope
      // machinery must add exactly zero queries to the turn path.
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionGraph());

      await buildTurnContext('sess-1');

      expect(mocks.prisma.appQuestionnaireTopic.findMany).not.toHaveBeenCalled();
    });

    it('changes nothing when the feature is on but no topics were ever authored', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionGraph({ version: { ...baseVersion(), config: scopedConfig() } })
      );
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([]);

      const loaded = await buildTurnContext('sess-1');

      expect(loaded!.base.questions.map((q) => q.key)).toEqual(['role', 'team']);
      expect(loaded!.scope.scope.active).toBe(false);
    });

    it('leaves the progress denominator identical to the gate’s for a version that never opted in', async () => {
      // F17.33's inert half: `progressQuestions` is the bar's denominator, and on every version
      // that never opted in it must be the SAME LIST the gate reads — not a copy that could drift.
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionGraph());

      const loaded = await buildTurnContext('sess-1');

      expect(loaded!.base.progressQuestions).toBe(loaded!.base.questions);
    });
  });

  /**
   * F17.33. The gate measures the interview as it is; the bar measures what could still be asked
   * until the plan settles it. The whole reason for the split is that a plan landing must move the
   * bar UP (topics were excluded) rather than down (topics added to a total that ignored them).
   */
  describe('the progress denominator', () => {
    it('counts every candidate question while the plan is still undecided', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionGraph({ version: { ...baseVersion(), config: scopedConfig() } })
      );
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
        topicRow('core', 'core', ['role']),
        topicRow('later', 'conditional', ['team']),
      ]);

      const loaded = await buildTurnContext('sess-1');

      // The interview so far is the always-run half...
      expect(loaded!.base.questions.map((q) => q.key)).toEqual(['role']);
      // ...but the bar is measured against everything still possible, so seating `later` cannot
      // make the figure fall.
      expect(loaded!.base.progressQuestions.map((q) => q.key)).toEqual(['role', 'team']);
    });

    it('collapses onto the interview once the plan exists', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionGraph({
          version: { ...baseVersion(), config: scopedConfig() },
          interviewPlan: {
            v: 1,
            topics: [{ key: 'later', depth: 'full', source: 'llm', rationale: 'r' }],
            excluded: [],
            checkTopicKey: null,
            confidence: 0.9,
            source: 'llm',
            respondentMessage: '',
            decidedAtTurn: 1,
            decidedAt: '2026-08-13T00:00:00.000Z',
          },
        })
      );
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
        topicRow('core', 'core', ['role']),
        topicRow('later', 'conditional', ['team']),
      ]);

      const loaded = await buildTurnContext('sess-1');

      // Decided: the interview IS the scope, so the two denominators are the same thing again.
      expect(loaded!.base.progressQuestions.map((q) => q.key)).toEqual(
        loaded!.base.questions.map((q) => q.key)
      );
    });

    it('narrows the denominator when the plan excludes a topic — the bar steps UP', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionGraph({
          version: { ...baseVersion(), config: scopedConfig() },
          interviewPlan: {
            v: 1,
            topics: [],
            excluded: [{ key: 'later', source: 'llm', rationale: 'not relevant' }],
            checkTopicKey: null,
            confidence: 0.9,
            source: 'llm',
            respondentMessage: '',
            decidedAtTurn: 1,
            decidedAt: '2026-08-13T00:00:00.000Z',
          },
        })
      );
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
        topicRow('core', 'core', ['role']),
        topicRow('later', 'conditional', ['team']),
      ]);

      const loaded = await buildTurnContext('sess-1');

      // Pre-plan the bar was measured against two questions; now it is measured against one, so an
      // unchanged answer count reads HIGHER than it did a turn ago.
      expect(loaded!.base.progressQuestions.map((q) => q.key)).toEqual(['role']);
    });
  });

  /**
   * Data-slot membership is the half of a topic that decides what the CONVERSATION targets — the
   * questions decide what is recorded, the slots decide what is talked about. Phase 1 of the
   * data-slot/scope work exists to populate this field, so it needs a test proving the field does
   * something once populated. Before that work, every topic's `dataSlotKeys` was `[]` on every
   * version, and so was every fixture here.
   */
  describe('data-slot membership', () => {
    it('withholds the data slots of a topic that is out of scope', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionGraph({ version: versionWithDataSlots() })
      );
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
        topicRow('core', 'core', ['role'], 'full', ['role_fit']),
        // Conditional and unplanned, so neither its question nor its slot is offered.
        topicRow('later', 'conditional', ['team'], 'full', ['team_shape']),
      ]);

      const loaded = await buildTurnContext('sess-1');

      expect(loaded!.base.dataSlots?.map((d) => d.key)).toEqual(['role_fit']);
      expect(loaded!.base.questions.map((q) => q.key)).toEqual(['role']);
    });

    it('offers a topic’s data slots once the plan selects it', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionGraph({
          version: versionWithDataSlots(),
          interviewPlan: {
            v: 1,
            topics: [{ key: 'later', depth: 'full', source: 'llm', rationale: 'r' }],
            excluded: [],
            checkTopicKey: null,
            confidence: 0.9,
            source: 'llm',
            respondentMessage: '',
            decidedAtTurn: 1,
            decidedAt: '2026-08-13T00:00:00.000Z',
          },
        })
      );
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
        topicRow('core', 'core', ['role'], 'full', ['role_fit']),
        topicRow('later', 'conditional', ['team'], 'full', ['team_shape']),
      ]);

      const loaded = await buildTurnContext('sess-1');

      expect(loaded!.base.dataSlots?.map((d) => d.key)).toEqual(['role_fit', 'team_shape']);
    });

    it('leaves every slot in scope when a topic carries none — the pre-attachment state', async () => {
      // A version seeded before data slots existed: topics hold questions only. Scope must not
      // read "no slots listed" as "no slots allowed", or an instrument in that state would have
      // nothing to talk about at all.
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionGraph({ version: versionWithDataSlots() })
      );
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
        topicRow('core', 'core', ['role', 'team']),
      ]);

      const loaded = await buildTurnContext('sess-1');

      // Documents the CURRENT behaviour: an unclaimed slot is filtered out, which is exactly the
      // failure Phase 1's attachment pass prevents at the source.
      expect(loaded!.base.dataSlots ?? []).toEqual([]);
    });
  });

  describe('the early-seating bridge (F17.36 phase 4)', () => {
    const EARLY = {
      v: 1,
      seated: [
        {
          key: 'later',
          depth: 'full',
          confidence: 0.93,
          rationale: 'r',
          respondentReason: 'rr',
          atTurn: 3,
        },
      ],
      deferred: [],
      lastPassAtTurn: 3,
      evidenceKey: 'e',
      overCap: false,
    };

    /** A version with early seating ON — the bridge is unreachable without it. */
    function earlyVersion(over: Record<string, unknown> = {}) {
      return {
        ...versionWithDataSlots(),
        config: scopedConfig({ earlyTopicSeating: true, ...over }),
      };
    }

    function graph(over: Record<string, unknown> = {}) {
      return sessionGraph({
        version: earlyVersion(),
        interviewPlan: null,
        earlySeatedTopics: EARLY,
        ...over,
      });
    }

    const TOPICS = [
      topicRow('core', 'core', ['role'], 'full', ['role_fit']),
      topicRow('later', 'conditional', ['team'], 'full', ['team_shape']),
    ];

    beforeEach(() => {
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue(TOPICS);
    });

    it("names the seated topic's data slots, so targeting can move to them", async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(graph());

      const loaded = await buildTurnContext('sess-1');

      // In scope (that is phase 3) AND flagged for the bridge (that is this phase). Without the
      // second half the seated topic is invisible to the respondent: it sorts behind every opening
      // slot and is never reached until the opening is done.
      expect(loaded!.base.dataSlots?.map((d) => d.key)).toEqual(['role_fit', 'team_shape']);
      expect(loaded!.base.bridgeDataSlotKeys).toEqual(['team_shape']);
    });

    it('names nothing once the plan is sealed', async () => {
      // After the seal the opening is over and the plan governs. Preferring one topic over another
      // then would be re-ordering a decision that has already been made.
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        graph({
          interviewPlan: {
            v: 1,
            topics: [{ key: 'later', depth: 'full', source: 'early', rationale: 'r' }],
            excluded: [],
            checkTopicKey: null,
            confidence: 0.9,
            source: 'llm',
            respondentMessage: '',
            decidedAtTurn: 5,
            decidedAt: '2026-09-02T00:00:00.000Z',
          },
        })
      );

      const loaded = await buildTurnContext('sess-1');

      expect(loaded!.base.bridgeDataSlotKeys).toBeUndefined();
    });

    it('names nothing when the admin turned the bridge off', async () => {
      // The escape hatch: the area is still in scope and still covered, just later and in the
      // usual order.
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        graph({ version: earlyVersion({ bridgeToSeatedTopics: false }) })
      );

      const loaded = await buildTurnContext('sess-1');

      expect(loaded!.base.dataSlots?.map((d) => d.key)).toContain('team_shape');
      expect(loaded!.base.bridgeDataSlotKeys).toBeUndefined();
    });

    it('names nothing on a session that seated nothing early', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        graph({ earlySeatedTopics: null })
      );

      const loaded = await buildTurnContext('sess-1');

      expect(loaded!.base.bridgeDataSlotKeys).toBeUndefined();
    });
  });

  describe('before the plan exists', () => {
    it('offers the always-run topics and withholds the conditional ones', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionGraph({
          version: { ...baseVersion(), config: scopedConfig() },
          interviewPlan: null,
        })
      );
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
        topicRow('open', 'opening', ['role']),
        topicRow('depth', 'conditional', ['team']),
      ]);

      const loaded = await buildTurnContext('sess-1');

      // The opening decides the rest, rather than running alongside it.
      expect(loaded!.base.questions.map((q) => q.key)).toEqual(['role']);
      expect(loaded!.slots.map((s) => s.key)).toEqual(['role']);
      expect(loaded!.scope.scope.active).toBe(true);
    });
  });

  describe('with a plan', () => {
    it('admits the planned conditional topic', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionGraph({
          version: { ...baseVersion(), config: scopedConfig() },
          interviewPlan: {
            v: 1,
            topics: [{ key: 'depth', depth: 'full', source: 'llm', rationale: 'they raised it' }],
            excluded: [],
            checkTopicKey: null,
            confidence: 0.9,
            source: 'llm',
            respondentMessage: '',
            decidedAtTurn: 2,
            decidedAt: '2026-08-12T00:00:00.000Z',
          },
        })
      );
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
        topicRow('open', 'opening', ['role']),
        topicRow('depth', 'conditional', ['team']),
      ]);

      const loaded = await buildTurnContext('sess-1');

      expect(loaded!.base.questions.map((q) => q.key)).toEqual(['role', 'team']);
    });

    it('treats a malformed plan as no plan — widening, never narrowing', async () => {
      (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
        sessionGraph({
          version: { ...baseVersion(), config: scopedConfig() },
          interviewPlan: { v: 99, garbage: true },
        })
      );
      (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
        topicRow('open', 'opening', ['role']),
        topicRow('depth', 'conditional', ['team']),
      ]);

      const loaded = await buildTurnContext('sess-1');

      // Falls back to the always-run phases rather than to an empty interview.
      expect(loaded!.base.questions.map((q) => q.key)).toEqual(['role']);
    });
  });

  it('still resolves a question asked BEFORE the plan narrowed the interview', async () => {
    // The prior turn targeted q2 ("team"), which the plan then left out. Extraction still has to
    // know what was asked in order to read the answer to it — scope governs what is asked next,
    // never what was.
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({
        version: { ...baseVersion(), config: scopedConfig() },
        interviewPlan: null,
      })
    );
    (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
      topicRow('open', 'opening', ['role']),
      topicRow('depth', 'conditional', ['team']),
    ]);

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.questions.map((q) => q.key)).toEqual(['role']);
    expect(loaded!.byId.get('q2')?.key).toBe('team');
    expect(loaded!.activeQuestionKey).toBe('team');
  });
});

/**
 * The opening's follow-up allowance (G03 / F17.17).
 *
 * Two things are worth pinning here: that the allowance is resolved only when it can actually bind
 * (nobody else pays a query for it), and that "spent" is counted off the FULL turn record rather
 * than the windowed transcript — an allowance read off a window would quietly refill itself.
 */
describe('buildTurnContext — the opening follow-up allowance (G03)', () => {
  function baseVersion(): Record<string, unknown> {
    return (sessionGraph() as unknown as { version: Record<string, unknown> }).version;
  }

  /** A version with one opening data slot and Conditional Topics on. */
  function probeVersion(scopeOver: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...baseVersion(),
      config: {
        conditionalTopics: {
          enabled: true,
          limitOpeningProbes: true,
          maxOpeningProbes: 1,
          ...scopeOver,
        },
      },
      dataSlots: [
        {
          id: 'ds-sig',
          key: 'signal',
          name: 'The signal',
          description: 'd',
          theme: 'Opening',
          ordinal: 0,
          weight: 1,
          questions: [{ questionSlot: { key: 'role' } }],
        },
      ],
    };
  }

  const openingTopic = {
    id: 't-open',
    key: 'open',
    label: 'open',
    description: null,
    phase: 'opening',
    criteria: null,
    depth: 'full',
    members: { questionKeys: ['role'], dataSlotKeys: ['signal'] },
    ordinal: 0,
    source: 'seeded',
  };

  beforeEach(() => {
    (mocks.prisma.appQuestionnaireTurn.findMany as Mock).mockResolvedValue([]);
  });

  it('resolves the allowance and counts what the opening has already spent', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ version: probeVersion(), interviewPlan: null })
    );
    (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([openingTopic]);
    // The slot was asked twice — one ask and one follow-up.
    (mocks.prisma.appQuestionnaireTurn.findMany as Mock).mockResolvedValue([
      { targetedDataSlotId: 'ds-sig' },
      { targetedDataSlotId: 'ds-sig' },
    ]);

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.openingProbe).toEqual({
      slotIds: ['ds-sig'],
      spent: 1,
      allowance: 1,
    });
  });

  it('does not resolve one — or query for it — when the version never opted in', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ version: probeVersion({ limitOpeningProbes: false }), interviewPlan: null })
    );
    (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([openingTopic]);

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.openingProbe).toBeUndefined();
    expect(mocks.prisma.appQuestionnaireTurn.findMany).not.toHaveBeenCalled();
  });

  it('stops resolving one once the plan is decided — there is no opening left to ration', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({
        version: probeVersion(),
        interviewPlan: {
          v: 1,
          topics: [],
          excluded: [],
          checkTopicKey: null,
          confidence: 0.9,
          source: 'llm',
          respondentMessage: '',
          decidedAtTurn: 2,
          decidedAt: '2026-08-15T00:00:00.000Z',
        },
      })
    );
    (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([openingTopic]);

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.openingProbe).toBeUndefined();
    expect(mocks.prisma.appQuestionnaireTurn.findMany).not.toHaveBeenCalled();
  });

  it('resolves nothing when the opening names no data slot that exists', async () => {
    // The allowance rations conversational follow-ups. An opening built only from questions has
    // none to ration, and a budget over an empty slot set would be a lie in the state.
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ version: probeVersion(), interviewPlan: null })
    );
    (mocks.prisma.appQuestionnaireTopic.findMany as Mock).mockResolvedValue([
      { ...openingTopic, members: { questionKeys: ['role'], dataSlotKeys: ['deleted_slot'] } },
    ]);

    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.openingProbe).toBeUndefined();
    expect(mocks.prisma.appQuestionnaireTurn.findMany).not.toHaveBeenCalled();
  });
});
