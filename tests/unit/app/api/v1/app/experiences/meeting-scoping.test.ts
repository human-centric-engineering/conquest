/**
 * Meeting scoping regression (P15.5) — rooms are keyed on the STEP, and one experience can host
 * MANY meetings. The same `(stepId, roomId)` pair therefore recurs across every meeting of that
 * experience, so a scribe-pen lookup that keys on `(stepId, roomId)` alone finds whichever
 * meeting's leg happens to match — not necessarily this one.
 *
 * Two queries did exactly that:
 *
 *  - `ensureBreakoutSession`'s scribe-pen lookup. A participant in meeting B could match meeting
 *    A's leg, fail the `scribeLeg.runId === params.runId` check, and get `sessionId: null` —
 *    permanently unable to take the pen in their OWN meeting.
 *  - `loadBreakoutRooms`'s `scribeTaken` flag. A room could read as "pen already taken" because a
 *    DIFFERENT meeting of the same experience had claimed it.
 *
 * The fix added `run: { meetingId: params.meetingId }` to both `where` clauses. These tests pin
 * that scoping through the exported entry points (`loadBreakoutRooms`, `chooseRoom`) and — because
 * Prisma is mocked, so a wrong `where` would otherwise return whatever the test told it to — also
 * assert the `where` shape that reaches Prisma directly. That second assertion is the one that
 * would actually have caught the original bug.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Mock = ReturnType<typeof vi.fn>;

/** The subset of `AppExperienceRunLeg` where-clause shapes the source code actually issues. */
interface RunLegWhere {
  runId?: string;
  stepId?: string;
  roomId?: string | { in: (string | null)[] } | null;
  run?: { meetingId: string };
}

/** A fake row, with `meetingId` denormalised from the (mocked) `run` relation for matching. */
interface LegRow {
  runId: string;
  stepId: string;
  roomId: string | null;
  sessionId: string;
  meetingId: string;
}

const prismaMock = vi.hoisted(() => ({
  prisma: {
    appExperienceMeeting: { findUnique: vi.fn() },
    appExperienceRun: { findFirst: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
    appExperienceRunLeg: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
    appExperienceStep: { findUnique: vi.fn() },
    appExperienceBreakoutRoom: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => prismaMock);

const stepsMock = vi.hoisted(() => ({ resolveStepVersionId: vi.fn() }));
vi.mock('@/app/api/v1/app/experiences/_lib/steps', () => stepsMock);

const createSessionMock = vi.hoisted(() => ({ createSessionForExperienceLeg: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/create', () => createSessionMock);

import { loadBreakoutRooms, chooseRoom } from '@/app/api/v1/app/experiences/_lib/meeting-service';

const MEETING_A = 'meeting_a';
const MEETING_B = 'meeting_b';
const STEP_ID = 'step_breakout';
const ROOM_ID = 'room_scribe';
const RUN_A = 'run_a1';
const RUN_B1 = 'run_b1';
const RUN_B2 = 'run_b2';
const SESS_A = 'sess_a1';
const SESS_B1 = 'sess_b1';
const NEW_SESSION_ID = 'sess_new_from_create';

/** Mirrors the `where` filters (`runId`, `stepId`, `roomId`/`{in}`, `run.meetingId`) real calls use. */
function matchesLegWhere(row: LegRow, where: RunLegWhere): boolean {
  if (where.runId !== undefined && row.runId !== where.runId) return false;
  if (where.stepId !== undefined && row.stepId !== where.stepId) return false;
  if (where.roomId !== undefined) {
    if (where.roomId !== null && typeof where.roomId === 'object' && 'in' in where.roomId) {
      if (!where.roomId.in.includes(row.roomId)) return false;
    } else if (row.roomId !== where.roomId) {
      return false;
    }
  }
  if (where.run?.meetingId !== undefined && row.meetingId !== where.run.meetingId) return false;
  return true;
}

/** The `where.run.meetingId`-bearing call to `appExperienceRunLeg.findFirst` (the scribe-pen lookup). */
function scribeFindFirstWhere(): RunLegWhere | undefined {
  const call = (prismaMock.prisma.appExperienceRunLeg.findFirst as Mock).mock.calls.find(
    (c) => (c[0] as { where: RunLegWhere }).where.roomId !== undefined
  );
  return (call?.[0] as { where: RunLegWhere } | undefined)?.where;
}

/** The `where.run.meetingId`-bearing call to `appExperienceRunLeg.findMany` (the `scribeTaken` read). */
function scribeFindManyWhere(): RunLegWhere | undefined {
  const call = (prismaMock.prisma.appExperienceRunLeg.findMany as Mock).mock.calls.find(
    (c) => (c[0] as { where: RunLegWhere }).where.roomId !== undefined
  );
  return (call?.[0] as { where: RunLegWhere } | undefined)?.where;
}

let legRows: LegRow[];

beforeEach(() => {
  vi.clearAllMocks();
  legRows = [];

  // A minimal fake DB for AppExperienceRunLeg — realistic enough that a `where` missing the
  // meeting scope actually returns the WRONG meeting's leg, the same way the real Prisma query did
  // before the fix. A findResolvedValue() stub could never catch that class of bug.
  prismaMock.prisma.appExperienceRunLeg.findFirst.mockImplementation(
    (args: { where: RunLegWhere }) => {
      const match = legRows.find((row) => matchesLegWhere(row, args.where));
      return Promise.resolve(match ? { sessionId: match.sessionId, runId: match.runId } : null);
    }
  );
  prismaMock.prisma.appExperienceRunLeg.findMany.mockImplementation(
    (args: { where: RunLegWhere }) => {
      const matches = legRows.filter((row) => matchesLegWhere(row, args.where));
      return Promise.resolve(
        matches.map((row) => ({ roomId: row.roomId, sessionId: row.sessionId }))
      );
    }
  );
  prismaMock.prisma.appExperienceRunLeg.count.mockResolvedValue(0);
  prismaMock.prisma.appExperienceRunLeg.create.mockResolvedValue({});

  prismaMock.prisma.appExperienceRun.findFirst.mockImplementation(
    (args: { where: { id: string; meetingId: string } }) =>
      Promise.resolve({ id: args.where.id, respondentUserId: `user_${args.where.id}` })
  );
  prismaMock.prisma.appExperienceRun.update.mockResolvedValue({});
  prismaMock.prisma.appExperienceRun.groupBy.mockResolvedValue([]);

  prismaMock.prisma.appExperienceMeeting.findUnique.mockResolvedValue({
    id: MEETING_B,
    experienceId: 'exp_1',
    status: 'live',
    currentStepId: STEP_ID,
    breakoutEndsAt: null,
    breakoutGraceSeconds: 30,
  });

  prismaMock.prisma.appExperienceBreakoutRoom.findFirst.mockResolvedValue({
    id: ROOM_ID,
    mode: 'scribe',
  });
  prismaMock.prisma.appExperienceBreakoutRoom.findUnique.mockResolvedValue({
    id: ROOM_ID,
    mode: 'scribe',
    questionnaireId: null,
    versionId: null,
  });
  prismaMock.prisma.appExperienceBreakoutRoom.findMany.mockResolvedValue([
    { id: ROOM_ID, name: 'Scribe room', ordinal: 0, mode: 'scribe' },
  ]);

  prismaMock.prisma.appExperienceStep.findUnique.mockResolvedValue({
    id: STEP_ID,
    questionnaireId: 'q_1',
    versionId: null,
    roundId: null,
  });

  stepsMock.resolveStepVersionId.mockResolvedValue('version_1');
  createSessionMock.createSessionForExperienceLeg.mockResolvedValue({
    ok: true,
    session: { id: NEW_SESSION_ID, status: 'active', versionId: 'version_1' },
    resumed: false,
  });
});

describe('loadBreakoutRooms — scribeTaken must scope to the meeting', () => {
  it('does NOT mark a room scribeTaken from a DIFFERENT meeting’s leg', async () => {
    // Meeting A already claimed the pen for this (stepId, roomId). Meeting B has not.
    legRows.push({
      runId: RUN_A,
      stepId: STEP_ID,
      roomId: ROOM_ID,
      sessionId: SESS_A,
      meetingId: MEETING_A,
    });

    const rooms = await loadBreakoutRooms({ meetingId: MEETING_B, stepId: STEP_ID });

    expect(rooms).toHaveLength(1);
    // BUG (pre-fix): the query matched meeting A's leg by (stepId, roomId) alone and reported the
    // room as taken for meeting B, where nobody has claimed anything.
    expect(rooms[0].scribeTaken).toBe(false);

    // The assertion that would have caught it: the where clause sent to Prisma must scope to THIS
    // meeting, not just this step+room.
    expect(scribeFindManyWhere()).toMatchObject({ run: { meetingId: MEETING_B } });
  });

  it('marks a room scribeTaken when the leg belongs to THIS meeting', async () => {
    legRows.push({
      runId: RUN_B1,
      stepId: STEP_ID,
      roomId: ROOM_ID,
      sessionId: SESS_B1,
      meetingId: MEETING_B,
    });

    const rooms = await loadBreakoutRooms({ meetingId: MEETING_B, stepId: STEP_ID });

    expect(rooms[0].scribeTaken).toBe(true);
    expect(scribeFindManyWhere()).toMatchObject({ run: { meetingId: MEETING_B } });
  });
});

describe('chooseRoom / ensureBreakoutSession — scribe pen must scope to the meeting', () => {
  it('does not block a meeting-B participant with meeting A’s pen on the same (stepId, roomId)', async () => {
    legRows.push({
      runId: RUN_A,
      stepId: STEP_ID,
      roomId: ROOM_ID,
      sessionId: SESS_A,
      meetingId: MEETING_A,
    });

    const result = await chooseRoom({ meetingId: MEETING_B, runId: RUN_B1, roomId: ROOM_ID });

    // BUG (pre-fix): the scribe-pen lookup found meeting A's leg; since `scribeLeg.runId` (RUN_A)
    // did not equal `params.runId` (RUN_B1), the participant got `sessionId: null` — permanently
    // unable to take the pen in their OWN meeting.
    expect(result).toEqual({ ok: true, sessionId: NEW_SESSION_ID });
    expect(createSessionMock.createSessionForExperienceLeg).toHaveBeenCalledTimes(1);

    // The assertion that would have caught it directly.
    expect(scribeFindFirstWhere()).toMatchObject({ run: { meetingId: MEETING_B } });
  });

  it('within one meeting, a second joiner gets null while the pen-holder keeps their session', async () => {
    legRows.push({
      runId: RUN_B1,
      stepId: STEP_ID,
      roomId: ROOM_ID,
      sessionId: SESS_B1,
      meetingId: MEETING_B,
    });

    // Someone else in the SAME meeting, same room: watching only, no session of their own.
    const second = await chooseRoom({ meetingId: MEETING_B, runId: RUN_B2, roomId: ROOM_ID });
    expect(second).toEqual({ ok: true, sessionId: null });

    // The pen-holder (e.g. rejoining after a refresh) gets their own session back.
    const holder = await chooseRoom({ meetingId: MEETING_B, runId: RUN_B1, roomId: ROOM_ID });
    expect(holder).toEqual({ ok: true, sessionId: SESS_B1 });

    // Neither call minted a fresh session — one was blocked, the other already had one.
    expect(createSessionMock.createSessionForExperienceLeg).not.toHaveBeenCalled();
  });
});
