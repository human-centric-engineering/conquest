/**
 * Definitions tab — curate the glossary of terms this version leans on (P16).
 *
 * Lifted into the workspace (header + version selector come from the layout). Reads `vid` from
 * the path and hands the whole curated set to a client editor that saves it as a replace-set.
 */
import type { Metadata } from 'next';

import { GlossaryEditor } from '@/components/admin/questionnaires/glossary/glossary-editor';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import {
  getQuestionnaireDetailCached,
  getVersionGraphCached,
} from '@/lib/app/questionnaire/workspace-data';
import type { GlossaryView } from '@/lib/app/questionnaire/glossary';

export const metadata: Metadata = {
  title: 'Definitions · Questionnaire',
  description:
    'Curate the ambiguous or context-dependent terms this questionnaire uses, and what they mean.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

async function getGlossary(id: string, versionId: string): Promise<GlossaryView> {
  const empty: GlossaryView = { terms: [], document: null };
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.versionGlossary(id, versionId));
    if (!res.ok) return empty;
    const body = await parseApiResponse<GlossaryView>(res);
    return body.success ? { terms: body.data.terms, document: body.data.document } : empty;
  } catch (err) {
    logger.error('definitions tab: glossary fetch failed', err);
    return empty;
  }
}

export default async function DefinitionsTab({ params }: PageProps) {
  const { id, vid } = await params;

  const [graph, glossary, detail] = await Promise.all([
    getVersionGraphCached(id, vid),
    getGlossary(id, vid),
    // The attributed client gates the opt-in "publish to client knowledge base" action. Read
    // through the detail endpoint (which already exposes `demoClient`) rather than hitting Prisma
    // from a page — the same API-first boundary the Settings tab observes.
    getQuestionnaireDetailCached(id),
  ]);
  const clientName = detail?.demoClient?.name ?? null;

  const questionCount = graph
    ? graph.sections.reduce((total, section) => total + section.questions.length, 0)
    : 0;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-3xl text-sm">
        Some questionnaires lean on words whose meaning is not settled — terms of art, internal
        jargon, or everyday words each respondent reads differently. Define them here once and every
        surface agrees: the interviewer phrases questions against your definition, the answer
        extractor interprets replies against it, and respondents can tap the term to see what you
        meant.
      </p>

      <GlossaryEditor
        clientName={clientName}
        questionnaireId={id}
        versionId={vid}
        initialTerms={glossary.terms}
        initialDocument={glossary.document}
        questionCount={questionCount}
      />
    </div>
  );
}
