/**
 * One-shot: reset a respondent report back to `queued` so the worker regenerates it.
 *
 * Usage: tsx --env-file=.env.local scripts/reset-respondent-report.ts <sessionRef>
 *
 * Clears content/generatedAt/error/lease and sets status=queued for the report
 * attached to the session with the given public ref (dash optional, e.g. 1PPM-0MTT).
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { normalizeSessionRef } from '@/lib/app/questionnaire/session-ref';
import { logger } from '@/lib/logging';

async function main(): Promise<void> {
  const rawRef = process.argv[2];
  if (!rawRef) {
    logger.error('Missing sessionRef', {
      usage: 'tsx --env-file=.env.local scripts/reset-respondent-report.ts <sessionRef>',
    });
    process.exit(1);
  }

  const ref = normalizeSessionRef(rawRef);
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { publicRef: ref },
    select: { id: true, publicRef: true },
  });

  if (!session) {
    logger.error('No session found for ref', { rawRef, normalized: ref });
    process.exit(1);
  }

  const existing = await prisma.appRespondentReport.findUnique({
    where: { sessionId: session.id },
    select: { id: true, status: true, mode: true },
  });

  if (!existing) {
    logger.error('No respondent report row for session', {
      sessionId: session.id,
      ref: session.publicRef,
    });
    process.exit(1);
  }

  const updated = await prisma.appRespondentReport.update({
    where: { sessionId: session.id },
    data: {
      status: 'queued',
      content: Prisma.DbNull,
      generatedAt: null,
      error: null,
      costUsd: null,
      lockedBy: null,
      lockedAt: null,
    },
    select: { id: true, status: true, mode: true },
  });

  logger.info('Respondent report reset to queued', {
    ref: session.publicRef,
    sessionId: session.id,
    previousStatus: existing.status,
    newStatus: updated.status,
    mode: updated.mode,
  });
}

void main()
  .catch((err: unknown) => {
    logger.error('Reset failed', err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
