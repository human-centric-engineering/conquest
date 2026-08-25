/**
 * Live end-to-end smoke for Conditional Topics against the real dev DB.
 *
 * Creates a scratch questionnaire, seeds topics through the real ingest seam, resolves scope with
 * and without a plan, then deletes everything. Proves the DB path, not just the pure logic.
 */
import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import { seedTopicsForVersion } from '@/app/api/v1/app/questionnaires/_lib/seed-topics';
import { buildSessionScope } from '@/app/api/v1/app/questionnaires/_lib/session-scope';
import { narrowConditionalTopicsSettings } from '@/lib/app/questionnaire/scope/types';
import { validateConditionalTopics } from '@/lib/app/questionnaire/scope/validate';
import { loadTopics } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import {
  acceptTopicDraft,
  loadTopicDraft,
  saveTopicDraft,
} from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import {
  ANALYSE_ROUTING_CAPABILITY_SLUG,
  EVALUATE_SCOPE_CAPABILITY_SLUG,
  EVALUATE_SCOPE_HANDLER,
  QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { SCOPE_EVALUATION_JUDGE_SLUGS } from '@/lib/app/questionnaire/scope-evaluation';

function ok(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  const q = await prisma.appQuestionnaire.create({
    data: { title: '__scope_smoke__', status: 'draft' },
    select: { id: true },
  });
  const v = await prisma.appQuestionnaireVersion.create({
    data: { questionnaireId: q.id, versionNumber: 1, status: 'draft' },
    select: { id: true },
  });

  try {
    // Two sections, three questions, one data slot mapped across the second section.
    const s1 = await prisma.appQuestionnaireSection.create({
      data: { versionId: v.id, ordinal: 0, title: 'Opening Situation' },
      select: { id: true },
    });
    const s2 = await prisma.appQuestionnaireSection.create({
      data: { versionId: v.id, ordinal: 1, title: 'Pipeline Management' },
      select: { id: true },
    });
    await prisma.appQuestionSlot.createMany({
      data: [
        {
          versionId: v.id,
          sectionId: s1.id,
          ordinal: 0,
          key: 'situation',
          prompt: 'Tell me about today.',
        },
        {
          versionId: v.id,
          sectionId: s2.id,
          ordinal: 1,
          key: 'pipe_1',
          prompt: 'Enough pipeline?',
          weight: 0.9,
        },
        {
          versionId: v.id,
          sectionId: s2.id,
          ordinal: 2,
          key: 'pipe_2',
          prompt: 'Moves at pace?',
          weight: 0.8,
        },
        {
          versionId: v.id,
          sectionId: s2.id,
          ordinal: 3,
          key: 'pipe_3',
          prompt: 'Anything else?',
          weight: 0.1,
        },
      ],
    });
    const ds = await prisma.appDataSlot.create({
      data: {
        versionId: v.id,
        key: 'pipeline_health',
        name: 'Pipeline health',
        description: 'x',
        theme: 'Pipeline',
        ordinal: 0,
      },
      select: { id: true },
    });
    const pipe1 = await prisma.appQuestionSlot.findFirstOrThrow({
      where: { versionId: v.id, key: 'pipe_1' },
      select: { id: true },
    });
    await prisma.appDataSlotQuestion.create({
      data: { dataSlotId: ds.id, questionSlotId: pipe1.id },
    });

    // 1. Seed through the real ingest seam.
    const created = await executeTransaction((tx) => seedTopicsForVersion(tx, v.id));
    ok('seeds one topic per section', created === 2, `created=${created}`);

    const topics = await loadTopics(v.id);
    ok(
      'every seeded topic is always-asked',
      topics.every((t) => t.phase === 'core')
    );
    ok(
      'membership uses keys',
      topics.some((t) => t.members.questionKeys.includes('pipe_1'))
    );
    ok(
      'data slot attributed to its section topic',
      topics.some((t) => t.members.dataSlotKeys.includes('pipeline_health'))
    );

    // 2. Inert: feature off → everything in scope, topic table not consulted.
    const off = await buildSessionScope(prisma, {
      versionId: v.id,
      settings: narrowConditionalTopicsSettings({}),
      interviewPlan: null,
    });
    ok('inert when disabled', off.scope.active === false);

    // 3. Enabled, conditional topic, no plan → conditional questions withheld.
    const pipelineTopic = topics.find((t) => t.members.questionKeys.includes('pipe_1'))!;
    await prisma.appQuestionnaireTopic.update({
      where: { id: pipelineTopic.id },
      data: { phase: 'conditional', criteria: 'when they mention stalling deals' },
    });
    const openingTopic = topics.find((t) => t.key !== pipelineTopic.key)!;
    await prisma.appQuestionnaireTopic.update({
      where: { id: openingTopic.id },
      data: { phase: 'opening' },
    });

    const settings = narrowConditionalTopicsSettings({
      enabled: true,
      maxConditionalTopics: 1,
      includeCheckTopic: false,
    });
    const noPlan = await buildSessionScope(prisma, {
      versionId: v.id,
      settings,
      interviewPlan: null,
    });
    ok('pre-plan: opening in scope', noPlan.scope.questionKeys.has('situation'));
    ok('pre-plan: conditional withheld', !noPlan.scope.questionKeys.has('pipe_1'));

    // 4. With a plan → conditional admitted.
    const planned = await buildSessionScope(prisma, {
      versionId: v.id,
      settings,
      interviewPlan: {
        v: 1,
        topics: [{ key: pipelineTopic.key, depth: 'full', source: 'llm', rationale: 'stalling' }],
        excluded: [],
        checkTopicKey: null,
        confidence: 0.9,
        source: 'llm',
        respondentMessage: 'Going deeper on pipeline.',
        decidedAtTurn: 2,
        decidedAt: new Date().toISOString(),
      },
    });
    ok('planned: conditional admitted', planned.scope.questionKeys.has('pipe_1'));

    // 5. Light depth samples the highest-weight member only.
    const light = await buildSessionScope(prisma, {
      versionId: v.id,
      settings,
      interviewPlan: {
        v: 1,
        topics: [
          { key: pipelineTopic.key, depth: 'light', source: 'check', rationale: 'blind spot' },
        ],
        excluded: [],
        checkTopicKey: pipelineTopic.key,
        confidence: 0.9,
        source: 'llm',
        respondentMessage: '',
        decidedAtTurn: 2,
        decidedAt: new Date().toISOString(),
      },
      weightByQuestionKey: new Map([
        ['pipe_1', 0.9],
        ['pipe_2', 0.8],
        ['pipe_3', 0.1],
      ]),
      allQuestionKeys: ['situation', 'pipe_1', 'pipe_2', 'pipe_3'],
    });
    ok(
      'light depth samples the two highest-weight members',
      light.scope.questionKeys.has('pipe_1') &&
        light.scope.questionKeys.has('pipe_2') &&
        !light.scope.questionKeys.has('pipe_3')
    );
    ok('trimmed member reported as not-asked', light.scope.notAskedQuestionKeys.has('pipe_3'));

    // 6. Coherence checks see the live rows.
    const issues = validateConditionalTopics({
      topics: await loadTopics(v.id),
      settings,
      allQuestionKeys: ['situation', 'pipe_1', 'pipe_2', 'pipe_3', 'orphan_q'],
      allDataSlotKeys: ['pipeline_health'],
    });
    ok(
      'orphan question is an error when enabled',
      issues.some((i) => i.code === 'orphaned_questions' && i.severity === 'error')
    );

    // 7. The planner agent is seeded and resolvable.
    const agent = await prisma.aiAgent.findUnique({
      where: { slug: 'app-scope-planner' },
      select: { id: true, isActive: true },
    });
    ok('scope planner agent is seeded and active', Boolean(agent?.isActive));

    // 8. The Routing Analyst (F17.4) is wired end to end — agent, capability, and the draft round
    // trip. The analysis CALL itself is not smoked (it costs a reasoning-model run over a whole
    // document); what is smoked is everything around it that a missing seed would break silently.
    const analyst = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG },
      select: { isActive: true },
    });
    ok('routing analyst agent is seeded and active', Boolean(analyst?.isActive));

    const analystCapability = await prisma.aiCapability.findUnique({
      where: { slug: ANALYSE_ROUTING_CAPABILITY_SLUG },
      select: { isActive: true, executionHandler: true },
    });
    ok(
      'routing analysis capability is seeded and points at its handler',
      analystCapability?.isActive === true &&
        analystCapability.executionHandler === 'AppAnalyseRoutingCapability'
    );

    // 8b. The scope-evaluation judge panel (F17.21) is wired end to end — four judges plus the
    // shared capability. Same posture as step 8: the panel CALL itself is not smoked (four paid
    // reasoning-model calls); what is smoked is everything a missing seed would break silently.
    const scopeJudges = await prisma.aiAgent.findMany({
      where: { slug: { in: [...SCOPE_EVALUATION_JUDGE_SLUGS] } },
      select: { kind: true, isActive: true },
    });
    ok(
      'all 4 scope-evaluation judges are seeded and active',
      scopeJudges.length === 4 && scopeJudges.every((j) => j.kind === 'judge' && j.isActive)
    );

    const scopeEvalCapability = await prisma.aiCapability.findUnique({
      where: { slug: EVALUATE_SCOPE_CAPABILITY_SLUG },
      select: { isActive: true, executionHandler: true },
    });
    ok(
      'scope-evaluation capability is seeded and points at its handler',
      scopeEvalCapability?.isActive === true &&
        scopeEvalCapability.executionHandler === EVALUATE_SCOPE_HANDLER
    );

    await saveTopicDraft(v.id, {
      v: 1,
      topics: [
        {
          key: 'proposed_pipeline',
          label: 'Pipeline',
          phase: 'conditional',
          criteria: 'They named deals stalling.',
          depth: 'full',
          members: { questionKeys: ['pipe_1'], dataSlotKeys: [] },
          rationale: 'The routing tab restricts this to sales-led businesses.',
          sourceQuote: 'Only cover pipeline for sales-led businesses.',
        },
      ],
      rules: [],
      gaps: [],
      summary: 'smoke',
      fromDocument: true,
      generatedAt: new Date().toISOString(),
    });
    const draft = await loadTopicDraft(v.id);
    ok(
      'topic draft round-trips through the Json column with its evidence intact',
      draft?.topics[0]?.sourceQuote === 'Only cover pipeline for sales-led businesses.' &&
        draft.fromDocument === true
    );

    // Persist a real settings blob first, so the next assertion tests what it claims: that accept
    // leaves `enabled` exactly as it found it, rather than merely defaulting to false.
    await prisma.appQuestionnaireConfig.upsert({
      where: { versionId: v.id },
      update: { conditionalTopics: { enabled: true } },
      create: { versionId: v.id, conditionalTopics: { enabled: true } },
    });

    // The accept is the transaction that matters: topics live, draft gone, in one step. A
    // half-applied accept would leave an admin reviewing work already done.
    const accepted = await acceptTopicDraft(v.id, {
      topics: [
        {
          key: 'proposed_pipeline',
          label: 'Pipeline',
          description: null,
          phase: 'conditional',
          criteria: 'They named deals stalling.',
          depth: 'full',
          questionKeys: ['pipe_1'],
          dataSlotKeys: [],
        },
      ],
      rules: [],
    });
    ok(
      'accepting the draft writes the topics live, stamped as the analyst’s',
      accepted.topics.length === 1 && accepted.topics[0]?.source === 'analyst'
    );
    ok(
      'accepting the draft clears it in the same transaction',
      (await loadTopicDraft(v.id)) === null
    );
    ok(
      'accepting a proposal leaves the master switch exactly as it found it',
      accepted.settings.enabled === true
    );
  } finally {
    await prisma.appQuestionnaire.delete({ where: { id: q.id } });
    console.log('🧹 scratch questionnaire removed');
  }
}

main()
  .catch((e) => {
    console.error('❌ smoke failed', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
