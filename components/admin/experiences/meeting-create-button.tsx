'use client';

/**
 * Create one occurrence of a facilitated experience (P15.5).
 *
 * Deliberately a single button with no form. A facilitator creating a meeting is usually minutes
 * from running it, and the only field worth asking for — a title telling this occurrence apart
 * from last month's — is optional and editable later. Anything more is a form standing between
 * someone and a room that is already sitting down.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';

export function MeetingCreateButton({ experienceId }: { experienceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const meeting = await apiClient.post<{ id: string; joinRef: string }>(
        API.APP.EXPERIENCES.meetings(experienceId),
        { body: { title: null } }
      );
      // Straight into the console: the next thing they need is the join link on screen.
      router.push(`/admin/experiences/${experienceId}/meetings/${meeting.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the meeting.');
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-destructive text-sm">{error}</span>}
      <Button onClick={() => void create()} disabled={busy}>
        {busy ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Plus className="mr-2 h-4 w-4" />
        )}
        New meeting
      </Button>
    </div>
  );
}
