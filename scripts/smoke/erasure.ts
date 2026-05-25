/* eslint-disable no-console -- CLI smoke script */
/**
 * Account-erasure smoke script.
 *
 * Proves the DB-enforced erasure behavior that mocked unit/integration tests
 * cannot: `ON DELETE CASCADE` removes personal data, `ON DELETE SET NULL`
 * retains org config with a nulled creator, residual `clientIp` is scrubbed,
 * and a `DataErasureReceipt` is written. Runs against the real dev/CI Postgres.
 *
 * Skips cleanly (exit 0) when no database is reachable, so it is safe to invoke
 * anywhere — it only does real work where a DB exists (CI's `validate` job,
 * which provisions Postgres + migrations + seeds, and locally with a running
 * DB). It must NOT be wired into `docker build` / `next build` (no DB there).
 *
 * Self-cleaning: creates only `smoke-test-erasure-*` rows and removes whatever
 * it created on every path. Never uses unscoped deletes or touches seed data.
 *
 * Run with:
 *   npm run smoke:erasure
 *   npx tsx --env-file=.env.local scripts/smoke/erasure.ts
 */

import { prisma } from '@/lib/db/client';
import { eraseUser } from '@/lib/privacy/erase-user';

const PREFIX = 'smoke-test-erasure';
const stamp = Date.now();

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:erasure skipped — no database reachable (DATABASE_URL unset or DB down).');
    return;
  }

  let subjectUserId: string | null = null;
  let agentId: string | null = null;
  let auditId: string | null = null;
  let receiptId: string | null = null;

  try {
    // Subject (ADMIN so we also prove a config-creator's createdBy is nulled).
    const subject = await prisma.user.create({
      data: {
        name: `${PREFIX} subject`,
        email: `${PREFIX}-subject-${stamp}@example.com`,
        role: 'ADMIN',
      },
    });
    subjectUserId = subject.id;

    // Org config (retained → createdBy SetNull) + personal data (cascade).
    const agent = await prisma.aiAgent.create({
      data: {
        name: `${PREFIX} agent`,
        slug: `${PREFIX}-agent-${stamp}`,
        description: 'smoke',
        systemInstructions: 'smoke',
        model: '',
        createdBy: subject.id,
      },
    });
    agentId = agent.id;

    const conversation = await prisma.aiConversation.create({
      data: { userId: subject.id, agentId: agent.id, title: 'smoke convo' },
    });
    const message = await prisma.aiMessage.create({
      data: { conversationId: conversation.id, role: 'user', content: 'hi' },
    });

    // Retained audit row carrying the subject's IP (residual PII to scrub).
    const audit = await prisma.aiAdminAuditLog.create({
      data: {
        userId: subject.id,
        action: 'agent.create',
        entityType: 'agent',
        clientIp: '203.0.113.7',
      },
    });
    auditId = audit.id;

    // Erase.
    const result = await eraseUser({
      userId: subject.id,
      userEmail: subject.email,
      actorUserId: subject.id,
      reason: 'self_service',
    });
    receiptId = result.receiptId;

    // Personal data cascaded away.
    check(
      (await prisma.user.findUnique({ where: { id: subject.id } })) === null,
      'user row deleted'
    );
    check(
      (await prisma.aiConversation.findUnique({ where: { id: conversation.id } })) === null,
      'conversation cascade-deleted'
    );
    check(
      (await prisma.aiMessage.findUnique({ where: { id: message.id } })) === null,
      'message cascade-deleted via its conversation'
    );

    // Org config retained, creator de-attributed.
    const agentAfter = await prisma.aiAgent.findUnique({ where: { id: agent.id } });
    check(agentAfter !== null, 'agent retained');
    check(agentAfter?.createdBy === null, 'agent.createdBy nulled (SetNull)');

    // Audit retained, link nulled, IP scrubbed.
    const auditAfter = await prisma.aiAdminAuditLog.findUnique({ where: { id: audit.id } });
    check(auditAfter !== null, 'audit row retained');
    check(auditAfter?.userId === null, 'audit.userId nulled (SetNull)');
    check(auditAfter?.clientIp === null, 'audit.clientIp scrubbed (residual PII)');

    // Receipt written without re-introducing PII.
    const receipt = await prisma.dataErasureReceipt.findUnique({ where: { id: result.receiptId } });
    check(receipt !== null, 'erasure receipt written');
    check(receipt?.subjectUserId === subject.id, 'receipt subjectUserId matches');
    check(
      typeof receipt?.subjectEmailHash === 'string' && receipt.subjectEmailHash.length === 64,
      'receipt stores a 64-char sha256 email hash, not the raw email'
    );
    check(receipt?.reason === 'self_service', 'receipt records the reason');

    console.log('\n✓ smoke:erasure passed');
  } finally {
    // Self-clean by tracked id. The user + its cascade children may already be
    // gone (erased); deleteMany is a no-op then. All FKs here are Cascade/SetNull,
    // so order can't cause constraint violations.
    if (receiptId)
      await prisma.dataErasureReceipt
        .deleteMany({ where: { id: receiptId } })
        .catch(() => undefined);
    if (auditId)
      await prisma.aiAdminAuditLog.deleteMany({ where: { id: auditId } }).catch(() => undefined);
    if (subjectUserId)
      await prisma.user.deleteMany({ where: { id: subjectUserId } }).catch(() => undefined);
    if (agentId) await prisma.aiAgent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch(async (err) => {
  console.error('\n✗ smoke:erasure failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
