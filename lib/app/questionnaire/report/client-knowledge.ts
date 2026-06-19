/**
 * Per-client knowledge isolation for the Respondent Report.
 *
 * A client's private knowledge corpus is modelled as a dedicated platform `KnowledgeTag` whose id is
 * stored on `AppDemoClient.knowledgeTagId`. Documents carrying that tag are the client's corpus;
 * everything here resolves *to that tag* so report generation and the admin viewer only ever see one
 * client's documents — no bleed — WITHOUT forking the platform knowledge schema (we reuse the
 * existing tag + document-tag join, the same machinery behind agent restricted-access).
 *
 * The tag is provisioned lazily the first time a client's KB is opened or used (idempotent upsert by
 * a deterministic slug). Uploads then apply this tag id; `resolveClientKnowledgeDocumentIds` reads it
 * back for the vector-search `documentIds` filter (see lib/orchestration/knowledge/search.ts).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/** Deterministic, stable slug for a client's private knowledge tag (clientId is a cuid). */
export function clientKnowledgeTagSlug(clientId: string): string {
  return `app-client-${clientId}`;
}

/** A client's document as surfaced to the Generation-tab KB viewer (trimmed list item). */
export interface ClientKnowledgeDocument {
  id: string;
  name: string;
  fileName: string;
  status: string;
  chunkCount: number;
  sourceUrl: string | null;
  createdAt: string;
}

/** The client's KB view: the client (or null when unattributed), its tag id, and its documents. */
export interface ClientKnowledgeView {
  client: { id: string; name: string } | null;
  knowledgeTagId: string | null;
  documents: ClientKnowledgeDocument[];
}

/**
 * Ensure the client has a dedicated knowledge tag and return its id. Idempotent: reuses
 * `knowledgeTagId` when already set and the tag still exists; otherwise upserts the tag by its
 * deterministic slug and persists the pointer back onto the client. Returns `null` only when the
 * client id doesn't resolve.
 */
export async function ensureClientKnowledgeTag(clientId: string): Promise<string | null> {
  const client = await prisma.appDemoClient.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, knowledgeTagId: true },
  });
  if (!client) return null;

  // Fast path: the pointer is set and the tag still exists.
  if (client.knowledgeTagId) {
    const existing = await prisma.knowledgeTag.findUnique({
      where: { id: client.knowledgeTagId },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  // Provision (or re-link) by the deterministic slug — upsert keeps this race-tolerant and
  // idempotent across re-provisioning if the pointer was cleared.
  const slug = clientKnowledgeTagSlug(clientId);
  const tag = await prisma.knowledgeTag.upsert({
    where: { slug },
    create: {
      slug,
      name: `Client: ${client.name}`,
      description: `Private knowledge corpus for the "${client.name}" client — used to ground its Respondent Reports. Isolated from other clients.`,
    },
    update: {},
    select: { id: true },
  });

  if (client.knowledgeTagId !== tag.id) {
    await prisma.appDemoClient.update({
      where: { id: clientId },
      data: { knowledgeTagId: tag.id },
    });
    logger.info('Linked client knowledge tag', { clientId, tagId: tag.id });
  }

  return tag.id;
}

/**
 * Resolve the document ids carrying a client's knowledge tag — the allowlist passed to vector search
 * as `SearchFilters.documentIds` so retrieval is scoped to this client only. Returns `[]` when the
 * client has no tag yet (no corpus) or no documents are tagged. Does NOT provision the tag (read-only
 * resolution for the generation path); callers that need provisioning use
 * {@link ensureClientKnowledgeTag}.
 */
export async function resolveClientKnowledgeDocumentIds(clientId: string): Promise<string[]> {
  const client = await prisma.appDemoClient.findUnique({
    where: { id: clientId },
    select: { knowledgeTagId: true },
  });
  if (!client?.knowledgeTagId) return [];

  const rows = await prisma.aiKnowledgeDocumentTag.findMany({
    where: { tagId: client.knowledgeTagId },
    select: { documentId: true },
  });
  return rows.map((r) => r.documentId);
}

/**
 * The client-scoped KB view for a questionnaire's attributed client: ensures the client's tag exists,
 * then lists the documents carrying it. Returns an unattributed view (`client: null`) when the
 * questionnaire has no demo client — there is no corpus to scope to in that case.
 */
export async function getClientKnowledgeViewForQuestionnaire(
  questionnaireId: string
): Promise<ClientKnowledgeView> {
  const questionnaire = await prisma.appQuestionnaire.findUnique({
    where: { id: questionnaireId },
    select: { demoClient: { select: { id: true, name: true } } },
  });
  const client = questionnaire?.demoClient ?? null;
  if (!client) return { client: null, knowledgeTagId: null, documents: [] };

  const tagId = await ensureClientKnowledgeTag(client.id);
  if (!tagId) return { client, knowledgeTagId: null, documents: [] };

  const rows = await prisma.aiKnowledgeDocument.findMany({
    where: { tags: { some: { tagId } } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      fileName: true,
      status: true,
      chunkCount: true,
      sourceUrl: true,
      createdAt: true,
    },
  });

  return {
    client,
    knowledgeTagId: tagId,
    documents: rows.map((d) => ({
      id: d.id,
      name: d.name,
      fileName: d.fileName,
      status: d.status,
      chunkCount: d.chunkCount,
      sourceUrl: d.sourceUrl,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}
