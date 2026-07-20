'use client';

/**
 * Authoring a breakout's rooms (P15.5b).
 *
 * Deliberately inline and minimal — a name and a mode. Rooms are usually decided in the hour before
 * a meeting ("four tables, one each"), so this is add-a-row-and-type rather than a dialog per room.
 *
 * Most breakouts have NO rooms, and the empty state says so plainly rather than implying the author
 * has forgotten something: everyone answering the same questionnaire individually is the normal
 * shape, not an unconfigured one.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Trash2 } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import {
  BREAKOUT_ROOM_MODE_LABELS,
  BREAKOUT_ROOM_MODES,
  type BreakoutRoomMode,
} from '@/lib/app/questionnaire/experiences/meeting/types';

export interface EditableRoom {
  id: string;
  name: string;
  mode: string;
  ordinal: number;
}

export interface BreakoutRoomsEditorProps {
  experienceId: string;
  stepId: string;
  rooms: EditableRoom[];
}

export function BreakoutRoomsEditor({ experienceId, stepId, rooms }: BreakoutRoomsEditorProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<BreakoutRoomMode>('individual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(API.APP.EXPERIENCES.stepRooms(experienceId, stepId), {
        body: { name: name.trim(), mode },
      });
      setName('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that room.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (roomId: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.delete(API.APP.EXPERIENCES.stepRoom(experienceId, stepId, roomId));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that room.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Label className="flex items-center gap-1">
        Rooms
        <FieldHelp title="Breakout rooms">
          <p>
            Optional. Leave this empty and everyone answers the same questionnaire individually,
            which is the usual shape.
          </p>
          <p className="mt-2">
            Add rooms when the group splits — each room can run its own questionnaire, and can
            either have everyone answer their own copy or have one person write for the room.
          </p>
          <p className="text-muted-foreground mt-2">
            Rooms are analysed separately, because they may have answered different questions.
          </p>
        </FieldHelp>
      </Label>

      {rooms.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No rooms — everyone will answer the same questionnaire individually.
        </p>
      ) : (
        <ul className="space-y-2">
          {rooms.map((room) => (
            <li
              key={room.id}
              className="bg-card flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{room.name}</p>
                <p className="text-muted-foreground text-xs">
                  {
                    BREAKOUT_ROOM_MODE_LABELS[
                      (BREAKOUT_ROOM_MODES as readonly string[]).includes(room.mode)
                        ? (room.mode as BreakoutRoomMode)
                        : 'individual'
                    ]
                  }
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${room.name}`}
                disabled={busy}
                onClick={() => void remove(room.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Table 3"
          disabled={busy}
          aria-label="Room name"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
        <Select value={mode} onValueChange={(v) => setMode(v as BreakoutRoomMode)} disabled={busy}>
          <SelectTrigger className="w-56" aria-label="How the room works">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BREAKOUT_ROOM_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {BREAKOUT_ROOM_MODE_LABELS[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" disabled={busy || !name.trim()} onClick={() => void add()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
