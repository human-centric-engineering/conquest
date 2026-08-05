/**
 * Subject-access export smoke script.
 *
 * Proves what mocked unit tests cannot: that every manifest query actually
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
import { APP_SUBJECT_DATA_SOURCES } from '@/lib/app/questionnaire/privacy/export-sources';

const PREFIX = 'smoke-test-export';
const stamp = Date.now();

/** Credential values planted on the subject; none may appear in the bundle. */
const SESSION_TOKEN = `${PREFIX}-session-token-${stamp}`;
const PASSWORD_HASH = `${PREFIX}-password-hash-${stamp}`;
const KEY_HASH = `${PREFIX}-key-hash-${stamp}`;
const WEBHOOK_SECRET = `${PREFIX}-webhook-secret-${stamp}`;
/**
 * ConQuest addition. `AppQuestionnaireInvitation.tokenHash` grants access to a
 * questionnaire session, so the app manifest omits it — and this is the value
 * that proves the omit runs. Without an invitation planted on the subject, that
 * `omit` is never exercised against real Postgres and the script's promise
 * ("a new source added without an `omit` is caught here") would not hold for
 * the app tier.
 */
const INVITE_TOKEN_HASH = `${PREFIX}-invite-token-hash-${stamp}`;

/**
 * A third party's identifiers, planted on rows the inbound path attributes to
 * the subject. Neither may appear in the subject's own export.
 */
const THIRD_PARTY_PHONE = `+1555${String(stamp).slice(-7)}`;
const THIRD_PARTY_MESSAGE = `${PREFIX}-third-party-message-${stamp}`;

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
  let workflowId: string | null = null;
  // ConQuest: the questionnaire the planted invitation hangs off. Deleting it
  // cascades the version and the invitation.
  let questionnaireId: string | null = null;

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

    // A third party's inbound traffic, written the way the inbound route writes
    // it since #502: system-owned, `userId: null`. It must not appear in this
    // subject's export — nor in anyone's, since no account owns it. Planted
    // against the same agent the subject owns, so a source that reached these
    // messages through the agent relation rather than the user's own would
    // surface here.
    const inboundConversation = await prisma.aiConversation.create({
      data: {
        userId: null,
        agentId: agent.id,
        title: `sms:${THIRD_PARTY_PHONE}`,
        channel: 'sms',
        provider: 'twilio',
        fromAddress: THIRD_PARTY_PHONE,
      },
    });
    await prisma.aiMessage.create({
      data: {
        conversationId: inboundConversation.id,
        role: 'user',
        content: THIRD_PARTY_MESSAGE,
      },
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

    // ConQuest app tier: an invitation addressed to the subject. Exercises the
    // app manifest's one credential omit (`tokenHash`) and its OR-match — the
    // row is matched on `userId` here, and the `email` arm covers an invitation
    // sent before the invitee ever registered.
    const questionnaire = await prisma.appQuestionnaire.create({
      data: { title: `${PREFIX} questionnaire` },
    });
    questionnaireId = questionnaire.id;

    const version = await prisma.appQuestionnaireVersion.create({
      data: { questionnaireId: questionnaire.id },
    });

    await prisma.appQuestionnaireInvitation.create({
      data: {
        versionId: version.id,
        email,
        name: `${PREFIX} invitee`,
        tokenHash: INVITE_TOKEN_HASH,
        userId: subject.id,
        invitedByUserId: subject.id,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });

    // A first-party run and an inbound-triggered one. Only the first is the
    // subject's; the second carries a third party's message as
    // `inputData.trigger` and is system-owned, exactly as the inbound route
    // writes it.
    const workflow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} workflow`,
        slug: `${PREFIX}-workflow-${stamp}`,
        description: 'smoke',
        createdBy: subject.id,
      },
    });
    workflowId = workflow.id;

    await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        status: 'completed',
        inputData: { note: 'first-party run' },
        executionTrace: [],
        userId: subject.id,
      },
    });
    await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        status: 'completed',
        inputData: { trigger: { from: THIRD_PARTY_PHONE, text: THIRD_PARTY_MESSAGE } },
        executionTrace: [],
        triggerSource: 'inbound:sms',
        userId: null,
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

    check(
      bundle.personalData.workflowExecutions?.length === 1,
      'first-party workflow run exported, inbound-triggered run excluded'
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
      // ConQuest: the invitation token hash. A bearer credential for a
      // questionnaire session — an export leaking it would let anyone holding
      // the file redeem the invitation.
      ['invitation token hash', INVITE_TOKEN_HASH],
    ] as const) {
      check(!serialised.includes(secret), `${name} is absent from the bundle`);
    }

    // A third party's identifiers must not reach the subject. Same recursive
    // sweep as the credentials above — it covers the whole bundle, including
    // nested messages and `inputData` JSON.
    //
    // Before #502 these rows carried the operator's `userId` and two explicit
    // filters kept them out. Now they carry none, so this pair asserts the
    // upstream fix end-to-end against real Postgres: system-owned rows are
    // unreachable from any subject's export because no subject owns them.
    check(
      !serialised.includes(THIRD_PARTY_PHONE),
      'a third party’s phone number is absent from the bundle'
    );
    check(
      !serialised.includes(THIRD_PARTY_MESSAGE),
      'a third party’s inbound message is absent from the bundle'
    );

    // The subject's own IP is personal data and SHOULD be there — proves the
    // sweep above is withholding credentials, not just emptying the export.
    check(serialised.includes('203.0.113.7'), 'the subject’s own IP address IS exported');
    check(serialised.includes('remember my postcode'), 'message content IS exported');

    // Nothing is withheld at row level any more, so nothing should claim to
    // be. A `scopeNote` surviving here would tell the subject their export was
    // narrowed when it wasn't — the silent-omission failure inverted.
    check(
      bundle.meta.exported.every((entry) => entry.scopeNote === undefined),
      'no exported source claims a narrowing'
    );

    check(
      bundle.meta.exported.length + bundle.meta.attribution.length === sections.length,
      'meta summarises every source'
    );
    check(bundle.meta.excluded.length > 0, 'meta discloses the documented exclusions');

    // FORK EDIT (ConQuest) — upstream asserts the app seam is EMPTY, which is
    // true only of vanilla Sunrise. This fork fills it, so the equivalent
    // assertion is that the seam produced exactly one section per declared
    // source: that is what catches a source silently dropped from the manifest,
    // which is the failure the empty-check was standing in for.
    check(
      Object.keys(bundle.app).length === APP_SUBJECT_DATA_SOURCES.length,
      'app seam yields a section per declared app source'
    );
    check(
      APP_SUBJECT_DATA_SOURCES.every((source) => Array.isArray(bundle.app[source.section])),
      'every app source returned rows (its query executed)'
    );
    // The planted invitation must come back — proof the OR-match reaches a row
    // by `userId` and that the query runs at all.
    check(
      JSON.stringify(bundle.app.questionnaireInvitations ?? []).includes(`${PREFIX} invitee`),
      'the subject’s own invitation IS exported'
    );

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
    // webhook subscriptions all cascade from the user; the agent, the workflow
    // (and its executions) and the contact submission do not — the workflow is
    // SetNull-retained on the user, so it outlives the delete below.
    if (contactId)
      await prisma.contactSubmission
        .deleteMany({ where: { id: contactId } })
        .catch(() => undefined);
    if (subjectUserId)
      await prisma.user.deleteMany({ where: { id: subjectUserId } }).catch(() => undefined);
    if (workflowId) {
      await prisma.aiWorkflowExecution.deleteMany({ where: { workflowId } }).catch(() => undefined);
      await prisma.aiWorkflow.deleteMany({ where: { id: workflowId } }).catch(() => undefined);
    }
    if (agentId) await prisma.aiAgent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
    // ConQuest: the version and its invitation cascade from the questionnaire,
    // and neither is linked to the user, so deleting the subject above does not
    // reach them.
    if (questionnaireId)
      await prisma.appQuestionnaire
        .deleteMany({ where: { id: questionnaireId } })
        .catch(() => undefined);
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
