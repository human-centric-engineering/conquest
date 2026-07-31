/**
 * Subject-access export smoke script.
 *
 * Proves what mocked unit tests cannot: that all ~28 manifest queries actually
 * execute against real Postgres. The unit suite mocks Prisma, so it verifies
 * the *arguments* the manifest builds — the right `where`, the right `omit` —
 * but never that the resulting queries run. Type-checking catches a wrong
 * column name; it does not catch `omit` combined with `include` on a relation
 * load, or a `mode: 'insensitive'` filter on a column type that rejects it.
 *
 * Also asserts the property that matters most and is easiest to regress: no
 * credential material reaches the bundle. That check is a recursive sweep over
 * the whole serialised export rather than a per-table assertion, so a new
 * source added without an `omit` is caught here even if nobody thought to test
 * it directly.
 *
 * Read-only against user data: creates a throwaway subject with a conversation
 * and an API key, exports it, and removes what it created. Never touches seed
 * data and never exports a real user.
 *
 * Skips cleanly (exit 0) when no database is reachable, so it is safe to invoke
 * anywhere — it only does real work where a DB exists (CI's `validate` job,
 * which provisions Postgres + migrations + seeds, and locally with a running
 * DB). It must NOT be wired into `docker build` / `next build` (no DB there).
 *
 * Run with:
 *   npm run smoke:export
 *   npx tsx --env-file=.env.local scripts/smoke/export.ts
 */

import { prisma } from '@/lib/db/client';
import { exportUserData, SubjectNotFoundError } from '@/lib/privacy/export-user';
import { SUBJECT_DATA_SOURCES } from '@/lib/privacy/export-sources';

const PREFIX = 'smoke-test-export';
const stamp = Date.now();

/** Credential values planted on the subject; none may appear in the bundle. */
const SESSION_TOKEN = `${PREFIX}-session-token-${stamp}`;
const PASSWORD_HASH = `${PREFIX}-password-hash-${stamp}`;
const KEY_HASH = `${PREFIX}-key-hash-${stamp}`;
const WEBHOOK_SECRET = `${PREFIX}-webhook-secret-${stamp}`;

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
    console.log('smoke:export skipped — no database reachable (DATABASE_URL unset or DB down).');
    return;
  }

  let subjectUserId: string | null = null;
  let agentId: string | null = null;
  let contactId: string | null = null;

  try {
    const email = `${PREFIX}-subject-${stamp}@example.com`;

    // ADMIN so the export also covers an attribution source (a created agent).
    const subject = await prisma.user.create({
      data: { name: `${PREFIX} subject`, email, role: 'ADMIN' },
    });
    subjectUserId = subject.id;

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
    await prisma.aiMessage.create({
      data: { conversationId: conversation.id, role: 'user', content: 'remember my postcode' },
    });

    // Credential-bearing rows — each is a column the manifest must withhold.
    await prisma.session.create({
      data: {
        userId: subject.id,
        token: SESSION_TOKEN,
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: '203.0.113.7',
      },
    });
    await prisma.account.create({
      data: {
        userId: subject.id,
        accountId: subject.id,
        providerId: 'credential',
        password: PASSWORD_HASH,
      },
    });
    await prisma.aiApiKey.create({
      data: {
        userId: subject.id,
        name: `${PREFIX} key`,
        keyHash: KEY_HASH,
        keyPrefix: 'sk_smoke',
      },
    });
    await prisma.aiWebhookSubscription.create({
      data: {
        createdBy: subject.id,
        channel: 'webhook',
        url: 'https://example.com/hook',
        secret: WEBHOOK_SECRET,
        events: ['workflow_failed'],
      },
    });

    // No FK to User — proves the by-email source resolves against real Postgres,
    // including the case-insensitive match.
    const contact = await prisma.contactSubmission.create({
      data: {
        name: `${PREFIX} contact`,
        email: email.toUpperCase(),
        subject: 'smoke',
        message: 'smoke enquiry',
      },
    });
    contactId = contact.id;

    // ---------------------------------------------------------------------
    console.log('\nexporting…');
    const bundle = await exportUserData({
      userId: subject.id,
      actorUserId: subject.id,
      reason: 'self_service',
    });

    // Every manifest source ran — this is the assertion the mocked suite can't
    // make, since a query that throws against real Postgres never reaches it.
    const sections = [...Object.keys(bundle.personalData), ...Object.keys(bundle.attributions)];
    check(
      sections.length === SUBJECT_DATA_SOURCES.length,
      `all ${SUBJECT_DATA_SOURCES.length} manifest sources ran against real Postgres`
    );

    check(bundle.account.id === subject.id, 'account row is the subject');
    check(bundle.personalData.conversations?.length === 1, 'conversation exported');

    const conversations = bundle.personalData.conversations as { messages: unknown[] }[];
    check(
      conversations[0].messages.length === 1,
      'messages load nested under the conversation (omit + include together)'
    );

    check(bundle.personalData.sessions?.length === 1, 'session exported');
    check(bundle.personalData.authProviders?.length === 1, 'linked sign-in method exported');
    check(bundle.personalData.apiKeys?.length === 1, 'API key metadata exported');
    check(
      bundle.personalData.contactSubmissions?.length === 1,
      'contact submission matched by email, case-insensitively'
    );
    check(bundle.attributions.agents?.length === 1, 'created agent exported as attribution');

    const [attributed] = bundle.attributions.agents as { label: string; id: string }[];
    check(
      Object.keys(attributed).sort().join(',') === 'createdAt,id,label',
      'attribution row carries id + label + date only, never the config'
    );

    // The property worth protecting above all others. A recursive sweep over the
    // serialised bundle, so a source added later without an `omit` fails here
    // even if no one wrote a test for it.
    const serialised = JSON.stringify(bundle);
    for (const [name, secret] of [
      ['session token', SESSION_TOKEN],
      ['password hash', PASSWORD_HASH],
      ['API key hash', KEY_HASH],
      ['webhook secret', WEBHOOK_SECRET],
    ] as const) {
      check(!serialised.includes(secret), `${name} is absent from the bundle`);
    }

    // The subject's own IP is personal data and SHOULD be there — proves the
    // sweep above is withholding credentials, not just emptying the export.
    check(serialised.includes('203.0.113.7'), 'the subject’s own IP address IS exported');
    check(serialised.includes('remember my postcode'), 'message content IS exported');

    check(
      bundle.meta.exported.length + bundle.meta.attribution.length === sections.length,
      'meta summarises every source'
    );
    check(bundle.meta.excluded.length > 0, 'meta discloses the documented exclusions');
    check(Object.keys(bundle.app).length === 0, 'app seam is empty in vanilla Sunrise');

    // A missing subject is a distinct, catchable failure — not a silent empty bundle.
    let notFound = false;
    try {
      await exportUserData({
        userId: 'smoke-nonexistent-user',
        actorUserId: subject.id,
        reason: 'admin_action',
      });
    } catch (error) {
      notFound = error instanceof SubjectNotFoundError;
    }
    check(notFound, 'a missing subject throws SubjectNotFoundError');

    console.log('\n✓ smoke:export passed');
  } finally {
    // Self-clean by tracked id. Sessions, accounts, conversations, API keys and
    // webhook subscriptions all cascade from the user; the agent and the
    // contact submission do not, so they are removed explicitly.
    if (contactId)
      await prisma.contactSubmission
        .deleteMany({ where: { id: contactId } })
        .catch(() => undefined);
    if (subjectUserId)
      await prisma.user.deleteMany({ where: { id: subjectUserId } }).catch(() => undefined);
    if (agentId) await prisma.aiAgent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch(async (err) => {
  console.error('\n✗ smoke:export failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
