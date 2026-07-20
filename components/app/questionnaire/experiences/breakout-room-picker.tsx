'use client';

/**
 * Choosing a breakout room (P15.5b).
 *
 * Shown only when the running breakout actually has rooms — most do not. The facilitator has just
 * said "table three, pick the third one", so this is a list of names and nothing else: no search,
 * no filtering, no confirmation step. Anything more is friction between a room of people and the
 * eight minutes they have.
 *
 * ## Scribe rooms say plainly what will happen
 *
 * In a `scribe` room the first person in writes for everybody and the rest watch. That is a real
 * commitment, so the button says which one they are getting — "Take the pen" versus "Join and
 * watch" — rather than discovering it after the fact.
 */

import { useState } from 'react';
import { Loader2, PenLine, Users } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import type { BreakoutRoomView } from '@/lib/app/questionnaire/experiences/meeting/types';

export interface BreakoutRoomPickerProps {
  meetingId: string;
  runId: string;
  rooms: BreakoutRoomView[];
  /** Called with the session for this participant — null in a scribe room they are watching. */
  onChosen: (result: { sessionId: string | null; sessionToken?: string }) => void;
}

export function BreakoutRoomPicker({ meetingId, runId, rooms, onChosen }: BreakoutRoomPickerProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (roomId: string) => {
    setBusyId(roomId);
    setError(null);
    try {
      const result = await apiClient.post<{ sessionId: string | null; sessionToken?: string }>(
        API.APP.EXPERIENCES.meetingRooms(meetingId),
        { body: { runId, roomId } }
      );
      onChosen(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join that room.');
      setBusyId(null);
    }
  };

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center px-4">
      <div className="w-full">
        <h1 className="text-center font-medium">Which room are you in?</h1>
        <p className="text-muted-foreground mt-1 mb-4 text-center text-sm">
          Pick the one the facilitator sent you to.
        </p>

        <ul className="space-y-2">
          {rooms.map((room) => {
            // In a scribe room, the pen is first-come. Someone arriving second joins to watch —
            // said up front, because two people writing the same answer would overwrite each other.
            const watching = room.mode === 'scribe' && room.scribeTaken;
            return (
              <li key={room.id}>
                <Button
                  variant="outline"
                  className="h-auto w-full justify-between py-3"
                  disabled={busyId !== null}
                  onClick={() => void choose(room.id)}
                >
                  <span className="text-left">
                    <span className="block font-medium">{room.name}</span>
                    <span className="text-muted-foreground block text-xs">
                      {room.occupancy} here
                      {room.mode === 'scribe' &&
                        (watching ? ' · someone is writing' : ' · you write')}
                    </span>
                  </span>
                  {busyId === room.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : room.mode === 'scribe' ? (
                    watching ? (
                      <Users className="h-4 w-4" />
                    ) : (
                      <PenLine className="h-4 w-4" />
                    )
                  ) : null}
                </Button>
              </li>
            );
          })}
        </ul>

        {error && <p className="text-destructive mt-3 text-center text-sm">{error}</p>}
      </div>
    </main>
  );
}
