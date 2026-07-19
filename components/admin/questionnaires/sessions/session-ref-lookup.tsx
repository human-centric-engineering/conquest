'use client';

/**
 * SessionRefLookup — resolve a support reference to its session viewer and navigate there.
 *
 * The shared entry point for the admin session viewer, in two shapes:
 *  - `compact` — a slim input + button for the workspace header (reachable from every tab).
 *  - default (panel) — a labelled card for the Sessions tab.
 *
 * The admin pastes the reference a respondent quoted ("7F3K-9M2P"); this resolves it server-side
 * (forgiving normalisation — a dash, lower-case, or O/0 slip still resolves) and routes to that
 * session's viewer. The resolved session may live under a DIFFERENT questionnaire/version than the
 * one currently open, so we navigate using the location the API returns, not the current params.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Search } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import { cn } from '@/lib/utils';

/** The subset of the `by-ref` response this UI needs to navigate. */
interface ResolvedLocation {
  sessionId: string;
  questionnaireId: string;
  versionId: string;
}

export function SessionRefLookup({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [refInput, setRefInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup() {
    const ref = refInput.trim();
    if (!ref) return;
    setLoading(true);
    setError(null);
    try {
      const loc = await apiClient.get<ResolvedLocation>(API.APP.QUESTIONNAIRES.sessionByRef(ref));
      router.push(
        `${workspaceVersionBase(loc.questionnaireId, loc.versionId)}/sessions/${loc.sessionId}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No session found for that reference');
      setLoading(false);
    }
    // On success we navigate away, so we leave `loading` set (the button stays busy until unmount).
  }

  const form = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void lookup();
      }}
      className="flex items-center gap-2"
    >
      <input
        value={refInput}
        onChange={(e) => setRefInput(e.target.value)}
        placeholder="7F3K-9M2P"
        aria-label="Session reference"
        className={cn('rounded border px-2 py-1.5 font-mono text-sm', compact ? 'w-36' : 'w-48')}
      />
      <button
        type="submit"
        disabled={loading || !refInput.trim()}
        className="bg-muted hover:bg-muted/70 inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        {compact ? 'View' : 'View session'}
      </button>
    </form>
  );

  if (compact) {
    return (
      <div className="flex flex-col items-end gap-1">
        {form}
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>
    );
  }

  return (
    <div className="bg-card space-y-4 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">View a session</h2>
        <p className="text-muted-foreground text-xs">
          Paste the reference a respondent quoted (e.g. <span className="font-mono">7F3K-9M2P</span>
          ) to open their conversation. A respondent conversation opens read-only; a preview
          conversation you can continue.
        </p>
      </div>
      {form}
      {error && (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
