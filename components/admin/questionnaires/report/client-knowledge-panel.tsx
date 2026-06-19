'use client';

/**
 * Client Knowledge panel (embedded in the Respondent Report → Generation tab).
 *
 * Lists + manages the attributed demo client's private knowledge corpus, scoped to the client's
 * dedicated tag so there is no cross-client bleed. Reads the client-scoped view from
 * `GET …/:id/report/knowledge` (never the platform global list), uploads through the platform
 * documents endpoint with the client's tag pre-applied, and deletes via the platform endpoint.
 * Degrades to a clear notice when the questionnaire has no attributed client (no corpus to scope to).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Trash2, Upload } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import type { ClientKnowledgeView } from '@/lib/app/questionnaire/report/client-knowledge';

const ACCEPT = '.md,.markdown,.txt,.csv,.docx,.pdf,.epub';

export interface ClientKnowledgePanelProps {
  questionnaireId: string;
}

export function ClientKnowledgePanel({ questionnaireId }: ClientKnowledgePanelProps) {
  const [view, setView] = useState<ClientKnowledgeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.get<ClientKnowledgeView>(
        API.APP.QUESTIONNAIRES.reportKnowledge(questionnaireId)
      );
      setView(data);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not load the knowledge base.');
    } finally {
      setLoading(false);
    }
  }, [questionnaireId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUpload = async (file: File, tagId: string) => {
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      // The server collects repeated tagIds via getAll — stamp the client's tag for isolation.
      formData.append('tagIds', tagId);
      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (documentId: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.knowledgeDocumentById(documentId));
      await load();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not delete the document.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading knowledge base…
      </div>
    );
  }

  if (!view?.client || !view.knowledgeTagId) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm">
        <p className="text-foreground font-medium">No client attributed</p>
        <p className="text-muted-foreground mt-1">
          Attribute a demo client to this questionnaire (Settings tab) to give its reports a private
          knowledge base. Documents are isolated per client.
        </p>
        {error && <p className="text-destructive mt-2 text-xs">{error}</p>}
      </div>
    );
  }

  const tagId = view.knowledgeTagId;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Private corpus for <span className="text-foreground font-medium">{view.client.name}</span>{' '}
          — used to ground this questionnaire&rsquo;s report insights. Isolated from other clients.
        </p>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file, tagId);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-3.5 w-3.5" />
            )}
            Upload document
          </Button>
        </div>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      {view.documents.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          No documents yet. Upload reference material (PDF, Markdown, DOCX, …) to ground the
          report&rsquo;s insights for this client.
        </p>
      ) : (
        <ul className="divide-border divide-y rounded-md border">
          {view.documents.map((doc) => (
            <li key={doc.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="text-foreground truncate font-medium">{doc.name}</p>
                <p className="text-muted-foreground text-xs">
                  {doc.status}
                  {doc.chunkCount > 0 ? ` · ${doc.chunkCount} chunks` : ''}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void handleDelete(doc.id)}
                aria-label={`Delete ${doc.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
