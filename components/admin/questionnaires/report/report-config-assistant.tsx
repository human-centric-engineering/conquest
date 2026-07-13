'use client';

/**
 * ReportConfigAssistant — the Generation-tab chat that helps an admin craft report config (Phase 4b).
 *
 * A lightweight conversational panel: the admin chats, each turn POSTs the transcript + the editor's
 * current generation values to the craft route, and the assistant replies — proposing full field text
 * the admin applies wholesale via per-field "Apply" buttons. Stateless server-side (the transcript
 * lives here); applying calls back into the editor, which still saves through the normal config PATCH.
 *
 * It drafts exactly the three free-text generation fields it can propose text for — Style & voice,
 * Structure, and Background context — not every control on the tab. The UI wears the house "AI panel"
 * accent chrome (see EditAgentPanel) so it reads as an assistant, not another form input, and its Apply
 * buttons name the destination field so the mapping to the form below is unambiguous.
 */

import { useState } from 'react';
import { ArrowDownToLine, Loader2, Sparkles, Send } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { CraftMessage, ReportConfigSuggestions } from '@/lib/app/questionnaire/report/craft';

interface TurnMessage extends CraftMessage {
  /** Suggestions attached to an assistant turn (empty for user turns / no proposal). */
  suggestions?: ReportConfigSuggestions;
}

/** Apply-button labels — kept in step with the visible field labels in the editor below. */
const FIELD_LABELS: Record<keyof ReportConfigSuggestions, string> = {
  instructions: 'Style & voice',
  structure: 'Structure',
  backgroundContext: 'Background context',
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

  // Collapsed: an accent CTA whose label states what it does — drafts the three fields below.
  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="group flex w-full items-center gap-3 rounded-xl border border-[var(--cq-accent)]/40 bg-[var(--cq-accent-muted)] p-3 text-left transition hover:border-[var(--cq-accent)]/60 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)]">
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold tracking-tight">
            Draft these fields with AI
          </span>
          <span className="text-muted-foreground block text-xs">
            Chat about your questionnaire and the assistant writes the Style &amp; voice, Structure,
            and Background context fields below — you review and apply each.
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className="bg-card/60 overflow-hidden rounded-xl border border-[var(--cq-accent)]/40">
      {/* Header — accent chrome + explicit scope so it never reads as another form field. */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--cq-accent)]/20 bg-[var(--cq-accent-muted)] p-3">
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)]">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-tight">Report design assistant</p>
            <p className="text-muted-foreground text-xs">
              Drafts the three fields below —{' '}
              <span className="text-foreground font-medium">Style &amp; voice</span>,{' '}
              <span className="text-foreground font-medium">Structure</span>, and{' '}
              <span className="text-foreground font-medium">Background context</span>. Review each
              draft, then apply it into the field.
            </p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      <div className="space-y-3 p-3">
        <div className="max-h-80 space-y-3 overflow-y-auto" aria-live="polite">
          {messages.length === 0 && (
            <p className="text-muted-foreground text-sm">
              Tell me about your questionnaire and what a useful report looks like. I&rsquo;ll
              propose text for the three fields above &mdash; and may ask a question or two first.
              Nothing changes until you apply a draft.
            </p>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="bg-muted max-w-[85%] rounded-lg px-3 py-1.5 text-sm">
                  <p className="whitespace-pre-wrap">{m.content}</p>
                </div>
              </div>
            ) : (
              <div key={i} className="flex gap-2">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--cq-accent)]/15 text-[var(--cq-accent)]">
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1 text-sm">
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
                            className="border-[var(--cq-accent)]/40 text-[var(--cq-accent)] hover:bg-[var(--cq-accent-muted)] hover:text-[var(--cq-accent)]"
                            onClick={() => onApply({ [field]: m.suggestions![field] })}
                          >
                            <ArrowDownToLine className="mr-1.5 h-3.5 w-3.5" />
                            Apply to {FIELD_LABELS[field]}
                          </Button>
                        )
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          )}
          {busy && (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
            </div>
          )}
        </div>

        {error && <p className="text-destructive text-xs">{error}</p>}

        {/* Composer — accent-ringed so it's clearly the assistant's input, not a form textarea. */}
        <div>
          <div className="bg-background flex items-end gap-2 rounded-lg border border-[var(--cq-accent)]/30 p-1.5 focus-within:border-[var(--cq-accent)]/60 focus-within:ring-2 focus-within:ring-[var(--cq-accent-ring)]">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={2}
              disabled={busy}
              className="min-h-0 resize-none border-0 bg-transparent p-1.5 shadow-none focus-visible:ring-0"
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
              className="bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)] hover:bg-[var(--cq-accent)]/90"
              onClick={() => void send()}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-muted-foreground mt-1 text-[0.7rem]">⌘/Ctrl + Enter to send</p>
        </div>
      </div>
    </div>
  );
}
