/**
 * ExtractionFidelityBand — what the fidelity critic concluded about this version's extraction,
 * above the change log it concerns.
 *
 * ## Why it lives here and not on its own tab
 *
 * Most of its findings are about the table below it. "This question was reworded and no change
 * record says so" is only legible next to the log that would have recorded it — on its own page it
 * is a sentence about nothing. The removed non-questions are the same: the change log is where
 * their content lives and where they are put back.
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
  return `${said}${retainedClause(view)}`;
}

/**
 * The second half of the coverage sentence, when the questionnaire no longer holds the number the
 * first half just quoted.
 *
 * The comparison the critic made is a comparison against what it was GIVEN, so the first half has
 * to keep quoting `totalCount` or the arithmetic stops being the arithmetic anyone performed.
 * Rewriting that number to the post-drop one would produce sentences like "the document looks like
 * it contains 9 questions, but 9 were extracted" on an `extra_questions` read, which says nothing
 * and reads as a bug.
 *
 * So the line names both: what was extracted and checked, then what survived. Without this an
 * admin reads "12 were extracted" on a panel whose own removal line sits above it and whose editor
 * lists 9, and has to work out for themselves which number describes the thing in front of them.
 */
function retainedClause(view: VersionFidelityView): string {
  if (view.retainedCount === view.totalCount) return '';
  const n = view.retainedCount;
  return ` The questionnaire now holds ${n} question${n === 1 ? '' : 's'}, after the changes below.`;
}

/**
 * The critic said some questions were not questions, and none of them were removed.
 *
 * This is the drop ceiling firing: past `max(3, 25%)` the pipeline removes nothing at all, on the
 * grounds that a critic calling a quarter of an instrument "script" has misread it. That bail-out
 * was a `log.warn` and nothing else, so the admin surface said only "N questions looked unfaithful
 * to the document" through {@link repairLine}'s default branch, which is true and tells them
 * nothing about the removal that was considered and abandoned.
 *
 * Read off the verdict snapshot rather than a stored count, so it stays a presentation decision.
 * The snapshot is capped on a long questionnaire, which is why the number is spoken only when the
 * snapshot is demonstrably whole; a partial list would understate it, and understating how much
 * the critic objected to is the wrong way to be wrong here.
 */
function abandonedDropLine(view: VersionFidelityView): string | null {
  if (view.droppedNonQuestionCount > 0) return null;
  const n = view.flagged.filter((f) => f.issue === 'not_a_question').length;
  if (n === 0) return null;
  const subject =
    view.flagged.length === view.flaggedCount ? `${n} line${n === 1 ? '' : 's'}` : 'Some lines';
  const they = subject === 'Some lines' || n !== 1 ? 'They are' : 'It is';
  return `${subject} looked like interviewer script rather than questions, but that is too many to remove safely, so none were removed. ${they} still in the questionnaire, listed below.`;
}

/**
 * What happened to the flagged questions that are STILL IN the questionnaire, in words an admin
 * can act on.
 *
 * The removed non-questions are flagged too, since `flaggedCount` is every `suspect` verdict and
 * that is the honest count of what the critic objected to. But they were deleted rather than
 * repaired, and the line above already says so. Counting them again here would tell an admin that
 * three questions "are saved exactly as first extracted" when only one of them is saved at all.
 *
 * Subtraction rather than a second stored count: the two can then never disagree, and a legacy row
 * with no drops subtracts zero and reads exactly as it always did.
 */
function repairLine(view: VersionFidelityView): string | null {
  const n = view.flaggedCount - view.droppedNonQuestionCount;
  if (n <= 0) return null;
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
  const dropped = fidelity.droppedNonQuestionCount;
  const abandonedDrop = abandonedDropLine(fidelity);
  // The flagged badges name questions to go and re-read. A removed one is not there to re-read,
  // and it is already named in its own list above, so listing it here sends the admin looking for
  // something that no longer exists.
  const removedKeys = new Set(fidelity.droppedNonQuestionKeys);
  const stillFlagged = fidelity.flagged.filter((q) => !removedKeys.has(q.key));

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
              .{' '}
              {fidelity.droppedNonQuestionCount > 0
                ? 'Nothing here was blocked, and everything it changed can be undone below.'
                : 'Nothing here was blocked or changed — it is what the check noticed.'}
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

          {/* The removal that was considered and abandoned. Sits where the removal itself would
              have, and is mutually exclusive with it: this renders only when nothing was dropped.
              Without it the ceiling bail-out reaches the admin as an ordinary "looked unfaithful"
              line, which is the one reading that leaves them thinking the critic had no opinion. */}
          {abandonedDrop && (
            <p className="text-sm">
              {abandonedDrop}{' '}
              <span className="text-muted-foreground">
                When that many are flagged at once it is usually the critic misreading the document,
                a page of statements to rate being the common way, so removing them is not safe
                enough to do without you. Delete any that really are script in the editor.
              </span>
            </p>
          )}

          {/* Said before anything else, because it is the only finding about something that is
              NOT in the editor. An admin reading the other lines is comparing what they can see
              against the document; this one tells them what they will not find. */}
          {dropped > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm">
                {dropped === 1
                  ? 'One line was removed because it is not a question.'
                  : `${dropped} lines were removed because they are not questions.`}{' '}
                <span className="text-muted-foreground">
                  Documents often carry lines written for whoever runs the interview rather than for
                  the person answering: a script the interviewer reads out, a move to the next
                  section, a note about how to answer. They read like sentences, so they can be
                  picked up as questions. {dropped === 1 ? 'It is' : 'They are'} listed in the
                  change log below and can be restored from there.
                </span>
              </p>
              {fidelity.droppedNonQuestionKeys.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {fidelity.droppedNonQuestionKeys.map((key) => (
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
          {stillFlagged.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {stillFlagged.map((q) => (
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
