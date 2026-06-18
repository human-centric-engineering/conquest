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
  prisma: { appQuestionnaireSession: { findUnique: vi.fn() } },
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
});
