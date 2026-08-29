/**
 * ExtractionFidelityBand — what the fidelity critic concluded about this version's extraction,
 * above the change log it concerns.
 *
 * ## Why it lives here and not on its own tab
 *
 * Two of its three findings are about edits MISSING from the table below it. "This question was
 * reworded and no change record says so" is only legible next to the log that would have recorded
 * it — on its own page it is a sentence about nothing.
 *
 * ## Read-only, and quiet by default
 *
 * Nothing here is a setting and nothing here blocks anything: by the time any of it is knowable
 * the questions already exist, and refusing an upload over a fidelity nicety is worse than
 * persisting it with the discrepancy on record. The band renders **only when there is something to
 * say** (`hasFidelityFindings`) — a clean extraction shows nothing at all, because a panel that
 * always appears saying "all good" is a panel people stop reading.
 *
 * `disallowedEditCount` is deliberately not shown. It answers "is the extractor's do-not-split
 * instruction landing?", which is a question about the build rather than about this questionnaire,
 * and there is no action an admin could take on it. It stays in the logs and on the provenance row.
 */

import { AlertTriangle, ScanSearch } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  hasFidelityFindings,
  type VersionFidelityView,
} from '@/lib/app/questionnaire/ingestion/fidelity-detail';

/** Plain-English line for the critic's coverage read. Null when there is nothing worth saying. */
function coverageLine(view: VersionFidelityView): string | null {
  const coverage = view.coverage;
  if (!coverage) return null;
  // `uncountable` is the common, correct answer — most instruments do not number their questions —
  // and `matches` is the good one. Neither is a finding, so neither gets a line.
  if (coverage.assessment === 'uncountable' || coverage.assessment === 'matches') return null;

  const claimed = coverage.sourceQuestionCount;
  const said =
    claimed === null
      ? 'The document appears to contain a different number of questions than were extracted.'
      : coverage.assessment === 'missing_questions'
        ? `The document looks like it contains ${claimed} questions, but only ${view.totalCount} were extracted.`
        : `The document looks like it contains ${claimed} questions, but ${view.totalCount} were extracted.`;
  return said;
}

/** What happened to the flagged questions, in words an admin can act on. */
function repairLine(view: VersionFidelityView): string | null {
  if (view.flaggedCount === 0) return null;
  const n = view.flaggedCount;
  const subject = `${n} question${n === 1 ? '' : 's'}`;
  switch (view.repairOutcome) {
    case 'repaired':
      return `${subject} looked unfaithful to the document and ${n === 1 ? 'was' : 'were'} re-read and corrected.`;
    case 'repair_failed':
      return `${subject} looked unfaithful to the document and could not be corrected — ${n === 1 ? 'it is' : 'they are'} saved exactly as first extracted.`;
    case 'skipped_systemic':
      return `${subject} looked unfaithful to the document. So many were flagged that the correction pass was skipped, so ${n === 1 ? 'it is' : 'they are'} saved exactly as first extracted.`;
    default:
      return `${subject} looked unfaithful to the document.`;
  }
}

interface ExtractionFidelityBandProps {
  fidelity: VersionFidelityView | null;
}

export function ExtractionFidelityBand({ fidelity }: ExtractionFidelityBandProps) {
  if (!fidelity || !hasFidelityFindings(fidelity)) return null;

  const coverage = coverageLine(fidelity);
  const repair = repairLine(fidelity);
  const unattributed = fidelity.unattributedPromptCount;

  return (
    <section
      aria-labelledby="extraction-fidelity-heading"
      className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-400">
          <ScanSearch className="h-4 w-4" />
        </span>
        <div className="min-w-0 space-y-3">
          <div className="space-y-1">
            <h3 id="extraction-fidelity-heading" className="text-sm font-semibold tracking-tight">
              Worth checking against the document
            </h3>
            <p className="text-muted-foreground max-w-3xl text-sm">
              After the extractor built this structure, a second agent re-read it against{' '}
              {fidelity.fileName ? (
                <span className="text-foreground font-medium">{fidelity.fileName}</span>
              ) : (
                'the source document'
              )}
              . Nothing here was blocked or changed — it is what the check noticed.
            </p>
          </div>

          {/* The critic never reached a provider. Said first and plainly, because every other
              reassuring thing on this panel would otherwise be vacuous: "nothing was flagged" is
              not a finding when nothing looked. */}
          {fidelity.verifierUnavailable && (
            <p className="flex items-start gap-2 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>
                The check did not run for this version, so this structure has not been re-read
                against the document at all.
              </span>
            </p>
          )}

          {coverage && (
            <div className="space-y-1">
              <p className="text-sm">{coverage}</p>
              {fidelity.coverage?.detail && (
                <p className="text-muted-foreground max-w-3xl text-xs">
                  {fidelity.coverage.detail}
                </p>
              )}
            </div>
          )}

          {repair && <p className="text-sm">{repair}</p>}

          {/* The flagged questions themselves, when the run's snapshot still carries them. The
              count above is authoritative — a long questionnaire's snapshot is capped — so this
              list is an aid to finding them, never the statement of how many there are. */}
          {fidelity.flagged.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {fidelity.flagged.map((q) => (
                <li key={q.key}>
                  <Badge variant="outline" className="font-mono text-xs" title={q.detail ?? ''}>
                    {q.key}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {unattributed > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm">
                {unattributed === 1
                  ? 'One question’s wording matches neither the document nor any change below.'
                  : `${unattributed} questions’ wording matches neither the document nor any change below.`}{' '}
                <span className="text-muted-foreground">
                  The extractor may reword a question — it is delivered in conversation, away from
                  its section heading — but it is supposed to record it here so you can see and undo
                  it. {unattributed === 1 ? 'This one' : 'These'} arrived with no record, so{' '}
                  {unattributed === 1 ? 'it reads' : 'they read'} in the editor as your own words.
                </span>
              </p>
              {/* Named when the row carries them. A row written before this check reported keys
                  still reports its number above — silently reading as clean would be worse. */}
              {fidelity.unattributedPromptKeys.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {fidelity.unattributedPromptKeys.map((key) => (
                    <li key={key}>
                      <Badge variant="outline" className="font-mono text-xs">
                        {key}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
