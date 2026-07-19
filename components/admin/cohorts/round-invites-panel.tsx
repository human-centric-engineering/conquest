'use client';

/**
 * Generate per-member invitations for a round (the grant mechanism). One button POSTs to the
 * round invitations endpoint, which mints a server-trusted invitation per active member ×
 * bundled questionnaire-version; the response carries the freshly-minted frictionless links the
 * admin copies/sends. Idempotent — re-running tops up newly added members.
 *
 * The links are shown once (the plaintext token only exists at generation time); re-generating
 * returns only links for members not yet invited.
 */

import { useState } from 'react';
import { Loader2, Mail, Copy, Check, QrCode } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { LinkQrCode } from '@/components/app/qr/link-qr-code';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';

interface MintedLink {
  memberId: string;
  email: string;
  name: string;
  versionId: string;
  url: string;
}

interface GenerateResult {
  created: number;
  skipped: number;
  unlaunchedQuestionnaires: number;
  activeMembers: number;
  links: MintedLink[];
}

export interface RoundInvitesPanelProps {
  roundId: string;
  /** Disabled with a hint when the round has no bundled questionnaires yet. */
  questionnaireCount: number;
}

export function RoundInvitesPanel({ roundId, questionnaireCount }: RoundInvitesPanelProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);

  const generate = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const data = await apiClient.post<GenerateResult>(API.APP.ROUNDS.invitations(roundId));
      setResult(data);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not generate invitations.');
    } finally {
      setIsGenerating(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
    } catch {
      // Clipboard unavailable — the URL is selectable in the row regardless.
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 text-sm font-medium">
          Invite cohort members
          <FieldHelp title="Round invitations">
            Generates one secure, no-login link per <strong>active</strong> cohort member for each
            bundled questionnaire. The link carries the round membership, so the respondent&rsquo;s
            session is bound to this round and enforced against its window and their membership.
            Re-running only invites members added since.
          </FieldHelp>
        </div>
        <Button
          onClick={() => void generate()}
          disabled={isGenerating || questionnaireCount === 0}
          title={questionnaireCount === 0 ? 'Attach a questionnaire to the round first' : undefined}
        >
          {isGenerating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Mail className="mr-2 h-4 w-4" />
          )}
          Generate invitations
        </Button>
      </div>

      {questionnaireCount === 0 && (
        <p className="text-muted-foreground text-xs">
          Attach at least one questionnaire to the round before generating invitations.
        </p>
      )}

      {result && (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm">
            Created <strong>{result.created}</strong> · skipped <strong>{result.skipped}</strong>{' '}
            (already invited) · <strong>{result.activeMembers}</strong> active{' '}
            {result.activeMembers === 1 ? 'member' : 'members'}
            {result.unlaunchedQuestionnaires > 0 && (
              <>
                {' '}
                · <strong>{result.unlaunchedQuestionnaires}</strong> skipped (no launched version)
              </>
            )}
          </p>
          {result.links.length > 0 && (
            <ul className="divide-y rounded-md border">
              {result.links.map((link) => {
                const key = `${link.memberId}-${link.versionId}`;
                return (
                  <li key={key} className="px-3 py-2">
                    <div className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        <span className="font-medium">{link.name}</span>{' '}
                        <span className="text-muted-foreground">{link.email}</span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => void copy(link.url)}
                      >
                        {copied === link.url ? (
                          <Check className="mr-2 h-4 w-4" />
                        ) : (
                          <Copy className="mr-2 h-4 w-4" />
                        )}
                        {copied === link.url ? 'Copied' : 'Copy link'}
                      </Button>
                      {/* One QR open at a time — these lists run to a full cohort, and rendering
                          a code per row would bury the names the admin is scanning for. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        aria-expanded={qrFor === key}
                        onClick={() => setQrFor((current) => (current === key ? null : key))}
                      >
                        <QrCode className="mr-2 h-4 w-4" />
                        {qrFor === key ? 'Hide QR' : 'QR'}
                      </Button>
                    </div>
                    {qrFor === key && (
                      <LinkQrCode
                        url={link.url}
                        label={`invite-${link.name}`}
                        className="pt-3 pb-1"
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
