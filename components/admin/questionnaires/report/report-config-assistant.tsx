'use client';

/**
 * ReportConfigAssistant — the Generation-tab chat that helps an admin craft report config (Phase 4b).
 *
 * A lightweight conversational panel: the admin chats, each turn POSTs the transcript + the editor's
 * current generation values to the craft route, and the assistant replies — proposing full field text
 * the admin applies wholesale via per-field "Apply" buttons. Stateless server-side (the transcript
 * lives here); applying calls back into the editor, which still saves through the normal config PATCH.
 */

import { useState } from 'react';
import { Loader2, Sparkles, Send } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { CraftMessage, ReportConfigSuggestions } from '@/lib/app/questionnaire/report/craft';

interface TurnMessage extends CraftMessage {
  /** Suggestions attached to an assistant turn (empty for user turns / no proposal). */
  suggestions?: ReportConfigSuggestions;
}

const FIELD_LABELS: Record<keyof ReportConfigSuggestions, string> = {
  instructions: 'instructions',
  structure: 'structure',
  backgroundContext: 'background context',
};

export interface ReportConfigAssistantProps {
  questionnaireId: string;
  versionId: string;
  /** The editor's live generation values — sent so the assistant builds on them. */
  current: { instructions: string; structure: string; backgroundContext: string };
  /** Apply a proposed field into the editor. */
  onApply: (patch: Partial<ReportConfigAssistantProps['current']>) => void;
  disabled?: boolean;
}

export function ReportConfigAssistant({
  questionnaireId,
  versionId,
  current,
  onApply,
  disabled,
}: ReportConfigAssistantProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<TurnMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    const nextMessages: TurnMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);
    setInput('');
    setBusy(true);
    try {
      const data = await apiClient.post<{ reply: string; suggestions: ReportConfigSuggestions }>(
        API.APP.QUESTIONNAIRES.reportCraft(questionnaireId, versionId),
        {
          body: {
            messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
            current,
          },
        }
      );
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.reply, suggestions: data.suggestions },
      ]);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'The assistant could not respond.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
        Craft with AI assistant
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-3.5 w-3.5" />
          Report design assistant
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      <div className="max-h-80 space-y-3 overflow-y-auto" aria-live="polite">
        {messages.length === 0 && (
          <p className="text-muted-foreground text-sm">
            Describe your questionnaire and what a useful report looks like, and I&rsquo;ll help
            craft the instructions, structure, and background context. I may ask a couple of
            questions first.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
            <div
              className={
                m.role === 'user'
                  ? 'bg-muted inline-block max-w-[85%] rounded-lg px-3 py-1.5 text-left text-sm'
                  : 'inline-block max-w-[95%] text-sm'
              }
            >
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.suggestions && Object.keys(m.suggestions).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {(Object.keys(m.suggestions) as (keyof ReportConfigSuggestions)[]).map(
                    (field) => (
                      <Button
                        key={field}
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onApply({ [field]: m.suggestions![field] })}
                      >
                        Apply {FIELD_LABELS[field]}
                      </Button>
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          disabled={busy}
          placeholder="e.g. This is a wellbeing pulse for managers — focus on practical, low-effort actions."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || !input.trim()}
          onClick={() => void send()}
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
