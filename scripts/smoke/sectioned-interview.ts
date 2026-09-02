/**
 * Live end-to-end smoke for Sectioned interviews (P21) against the real dev DB.
 *
 * Creates a scratch questionnaire, runs it through every seam the feature touches — the resolver,
 * the two-section floor, the turn-context bound, the transcript export, the report chapters and the
 * admin timeline — then deletes everything. Proves the DB path, not just the pure logic.
 *
 * The most valuable assertions here are the NEGATIVE ones. The feature's central promise is that it
 * is inert when off, and "inert" is precisely the property a unit test with a hand-built fixture
 * cannot check: it is a claim about what the real loaders do with a real row.
 *
 *   npm run smoke:sections
 */
import { prisma } from '@/lib/db/client';
import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import { loadTranscriptExport } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-export';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { assembleTranscriptExportModel } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-export';
import { buildTranscriptText } from '@/lib/app/questionnaire/export/build-transcript-text';
import { resolveSessionSections } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-sections';
import { loadAdminSessionView } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';
import { buildReportChapters } from '@/lib/app/questionnaire/report/chapters';

function ok(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

/** Write the version's sectioned-interview settings blob. */
async function setSections(versionId: string, sections: Record<string, unknown>) {
  await prisma.appQuestionnaireConfig.upsert({
    where: { versionId },
    update: { sections: jsonInput(sections) },
    create: { versionId, sections: jsonInput(sections) },
  });
}

async function main() {
  const q = await prisma.appQuestionnaire.create({
    data: { title: '__sections_smoke__', status: 'draft' },
    select: { id: true },
  });
  const v = await prisma.appQuestionnaireVersion.create({
    data: { questionnaireId: q.id, versionNumber: 1, status: 'draft' },
    select: { id: true },
  });

  try {
    // Two document sections, two questions each. `document` is the bottom rung of the resolver
    // ladder and the one with no other moving parts, so it isolates what this script is testing.
    const s1 = await prisma.appQuestionnaireSection.create({
      data: { versionId: v.id, ordinal: 0, title: 'Your context' },
      select: { id: true },
    });
    const s2 = await prisma.appQuestionnaireSection.create({
      data: { versionId: v.id, ordinal: 1, title: 'The problem' },
      select: { id: true },
    });
    await prisma.appQuestionSlot.createMany({
      data: [
        {
          versionId: v.id,
          sectionId: s1.id,
          ordinal: 0,
          key: 'ctx_1',
          prompt: 'How big is the team?',
        },
        {
          versionId: v.id,
          sectionId: s1.id,
          ordinal: 1,
          key: 'ctx_2',
          prompt: 'How long established?',
        },
        {
          versionId: v.id,
          sectionId: s2.id,
          ordinal: 2,
          key: 'prob_1',
          prompt: 'What is going wrong?',
        },
        { versionId: v.id, sectionId: s2.id, ordinal: 3, key: 'prob_2', prompt: 'Since when?' },
      ],
    });

    const session = await prisma.appQuestionnaireSession.create({
      data: { versionId: v.id, status: 'active', isPreview: true },
      select: { id: true },
    });

    // ── 1. Off is inert ───────────────────────────────────────────────────────────────────────
    // The feature's central promise, and the only place it can honestly be checked: against the
    // real loader, on a real row, with no settings written at all.
    {
      const loaded = await buildTurnContext(session.id);
      ok(
        'with no settings written, the interview is not sectioned',
        loaded?.sectionState.active === false
      );
      ok(
        'and the turn context carries NO section pools, so targeting sees exactly what it always saw',
        loaded?.base.sectionQuestions === undefined && loaded?.base.sectionDataSlots === undefined
      );
    }

    // ── 2. The two-section floor ──────────────────────────────────────────────────────────────
    // One section is not a sectioned interview: it is the whole questionnaire with a tab strip and
    // a "move on" control that goes nowhere. The resolver must return the EMPTY list, not the one
    // section, so every caller falls back by construction rather than by remembering a length check.
    {
      await setSections(v.id, { enabled: true, source: 'document' });
      const solo = await prisma.appQuestionnaireSection.findFirst({
        where: { versionId: v.id, ordinal: 1 },
        select: { id: true },
      });
      // Temporarily strip the second section's questions — a section with no questions is dropped
      // before the floor is applied, which is what takes this version down to one.
      await prisma.appQuestionSlot.updateMany({
        where: { versionId: v.id, sectionId: solo!.id },
        data: { sectionId: s1.id },
      });
      const loaded = await buildTurnContext(session.id);
      ok(
        'a version resolving to ONE section runs unsectioned, not as a single-tab interview',
        loaded?.sectionState.active === false
      );
      // Put them back.
      await prisma.appQuestionSlot.updateMany({
        where: { versionId: v.id, key: { in: ['prob_1', 'prob_2'] } },
        data: { sectionId: s2.id },
      });
    }

    // ── 3. On, and bounded ────────────────────────────────────────────────────────────────────
    let sectionKeys: string[] = [];
    {
      const loaded = await buildTurnContext(session.id);
      const state = loaded!.sectionState;
      sectionKeys = state.sections.map((s) => s.key);
      ok(
        'two sections resolve, in document order',
        state.sections.length === 2,
        state.sections.map((s) => s.label).join(' → ')
      );
      ok(
        'the first is active before any turn has landed',
        state.activeSection?.label === 'Your context'
      );
      ok('and the next reply opens it', state.isSectionOpening === true);
      ok(
        'the section pool is a SECOND list, bounded to the active section',
        loaded!.base.sectionQuestions?.length === 2,
        `${loaded!.base.sectionQuestions?.length} of ${loaded!.base.questions.length}`
      );
      ok(
        'while the MEASURED list stays the whole interview, so the submit gate and the bar are untouched',
        loaded!.base.questions.length === 4
      );
      ok(
        'the close gate refuses an untouched section',
        loaded!.sectionState.close?.canClose === false
      );
    }

    // ── 4. A run, and the artefacts that read it back ─────────────────────────────────────────
    const [first, second] = sectionKeys;
    await prisma.appQuestionnaireTurn.createMany({
      data: [
        {
          sessionId: session.id,
          ordinal: 1,
          userMessage: 'Twelve of us.',
          agentResponse: 'And how long?',
          sectionKey: first,
          costUsd: 0.01,
        },
        {
          sessionId: session.id,
          ordinal: 2,
          userMessage: 'Four years.',
          agentResponse: 'What is going wrong?',
          sectionKey: first,
          costUsd: 0.02,
        },
        // Back to the first section: a genuine revisit, which the transcript must announce twice.
        {
          sessionId: session.id,
          ordinal: 3,
          userMessage: 'One more on the team.',
          agentResponse: 'Go on.',
          sectionKey: first,
          costUsd: 0.01,
        },
      ],
    });
    await prisma.appQuestionnaireSession.update({
      where: { id: session.id },
      data: {
        sectionRun: jsonInput({
          v: 1,
          activeKey: first,
          sections: [
            {
              key: first,
              status: 'in_progress',
              openedAtTurn: 1,
              closedAtTurn: null,
              closeReason: null,
              reopenCount: 1,
              turnsSpent: 3,
            },
            // The second section was never reached. The whole point of the report's third gap.
            {
              key: second,
              status: 'not_started',
              openedAtTurn: 0,
              closedAtTurn: null,
              closeReason: null,
              reopenCount: 0,
              turnsSpent: 0,
            },
          ],
        }),
      },
    });

    {
      const exported = await loadTranscriptExport(session.id);
      const text = buildTranscriptText(
        await assembleTranscriptExportModel(exported!, { fetchLogo: false })
      );
      ok(
        'the transcript resolves the stored key to the section TITLE, never a bare key',
        text.includes('YOUR CONTEXT')
      );
      ok('and never leaks the key itself', !text.includes(first));
      ok('the part never reached contributes no heading', !text.includes('THE PROBLEM'));
    }

    {
      const resolved = await resolveSessionSections(session.id);
      const chapters = buildReportChapters(resolved.sections, resolved.run);
      ok(
        'the report resolves two chapters, in run order',
        chapters.map((c) => c.label).join(',') === 'Your context,The problem'
      );
      ok(
        'the part the respondent worked in is COVERED even though it was never finished',
        chapters[0]?.covered === true
      );
      ok(
        'and the part they never reached is NOT covered — the third kind of gap',
        chapters[1]?.covered === false
      );
    }

    {
      const view = await loadAdminSessionView(session.id);
      const timeline = view?.sectionTimeline;
      ok('the admin timeline resolves', Boolean(timeline));
      ok('it marks where the run stopped', timeline?.activeKey === first);
      ok('it counts the turns charged to the section', timeline?.entries[0]?.turnsSpent === 3);
      ok('it reports the revisit', timeline?.entries[0]?.reopenCount === 1);
      ok(
        'it sums spend from the turn rows',
        Math.abs((timeline?.entries[0]?.costUsd ?? 0) - 0.04) < 1e-6,
        String(timeline?.entries[0]?.costUsd)
      );
      ok(
        'a part never opened reads as turn zero with no spend recorded, not as free',
        timeline?.entries[1]?.openedAtTurn === 0 && timeline?.entries[1]?.costUsd === null
      );
      ok(
        'no section is marked stale on a version that still carries both',
        timeline?.entries.every((e) => !e.stale) === true
      );
    }

    // ── 5. Turning it off again is a full retreat ─────────────────────────────────────────────
    // Not just "no new sections": a session that already BANKED a run must go back to the flat
    // artefacts, because the setting is the switch and the blob is only a record.
    {
      await setSections(v.id, { enabled: false });
      const loaded = await buildTurnContext(session.id);
      ok(
        'switching the feature off unsections a session that already has a run',
        loaded?.sectionState.active === false
      );
      const view = await loadAdminSessionView(session.id);
      ok('and the admin timeline disappears with it', view?.sectionTimeline === null);
    }
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
