'use client';

/**
 * Human-review controls for one persisted turn evaluation.
 *
 * A comment box (free-text reviewer note) and the learning-flag workflow
 * (none → flagged → reviewed → actioned | dismissed). Actioning appends the evaluation to a
 * chosen eval dataset as a learning case via the action endpoint; the other transitions go
 * through the review PATCH. Used by the admin persisted-evaluation detail and the live inspector
 * drawer (once a verdict has persisted and carries an `evaluationId`).
 *
 * All mutations are scoped to `(sessionId, evaluationId)`; the component lifts its own optimistic
 * state and calls `onUpdated` so the parent list/row can reflect the new flag without a refetch.
 */

import { useState } from 'react';
import { Flag, Check, X, Loader2, Database } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

/** The flag states surfaced in the UI. `actioned` is terminal (reached only via the dataset action). */
export type ReviewFlagStatus = 'none' | 'flagged' | 'reviewed' | 'actioned' | 'dismissed';

interface DatasetOption {
  id: string;
  name: string;
}

export interface TurnEvaluationReviewProps {
  sessionId: string;
  evaluationId: string;
  initialFlagStatus: ReviewFlagStatus;
  initialComment: string | null;
  /** The dataset this row was actioned into, when already actioned. */
  datasetId?: string | null;
  /** Called after any successful mutation with the row's new review facets. */
  onUpdated?: (next: { flagStatus: ReviewFlagStatus; comment: string | null }) => void;
}

const FLAG_LABELS: Record<ReviewFlagStatus, string> = {
  none: 'Not flagged',
  flagged: 'Flagged for learning',
  reviewed: 'Reviewed',
  actioned: 'Actioned → dataset',
  dismissed: 'Dismissed',
};

export function TurnEvaluationReview({
  sessionId,
  evaluationId,
  initialFlagStatus,
  initialComment,
  datasetId: initialDatasetId,
  onUpdated,
}: TurnEvaluationReviewProps) {
  const [flagStatus, setFlagStatus] = useState<ReviewFlagStatus>(initialFlagStatus);
  const [comment, setComment] = useState(initialComment ?? '');
  const [savedComment, setSavedComment] = useState(initialComment ?? '');
  const [busy, setBusy] = useState<null | 'comment' | 'flag' | 'action'>(null);
  const [error, setError] = useState<string | null>(null);

  // Dataset picker (loaded lazily when the reviewer opens the action panel).
  const [showAction, setShowAction] = useState(false);
  const [datasets, setDatasets] = useState<DatasetOption[] | null>(null);
  const [datasetId, setDatasetId] = useState('');
  const actionedDatasetId = initialDatasetId ?? null;

  const locked = flagStatus === 'actioned';
  const commentDirty = comment.trim() !== savedComment.trim();

  async function saveComment() {
    setBusy('comment');
    setError(null);
    try {
      await apiClient.patch(
        API.APP.QUESTIONNAIRE_SESSIONS.evaluationReview(sessionId, evaluationId),
        {
          body: { comment },
        }
      );
      setSavedComment(comment);
      onUpdated?.({ flagStatus, comment: comment.trim() || null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the comment');
    } finally {
      setBusy(null);
    }
  }

  async function setFlag(next: Exclude<ReviewFlagStatus, 'actioned'>) {
    setBusy('flag');
    setError(null);
    try {
      await apiClient.patch(
        API.APP.QUESTIONNAIRE_SESSIONS.evaluationReview(sessionId, evaluationId),
        {
          body: { flagStatus: next },
        }
      );
      setFlagStatus(next);
      onUpdated?.({ flagStatus: next, comment: savedComment.trim() || null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the flag');
    } finally {
      setBusy(null);
    }
  }

  async function loadDatasets() {
    setShowAction(true);
    if (datasets) return;
    try {
      const data = await apiClient.get<DatasetOption[]>(
        `${API.ADMIN.ORCHESTRATION.EVAL_DATASETS}?limit=100`
      );
      setDatasets(data.map((d) => ({ id: d.id, name: d.name })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load datasets');
      setDatasets([]);
    }
  }

  async function actionToDataset() {
    if (!datasetId) return;
    setBusy('action');
    setError(null);
    try {
      await apiClient.post(
        API.APP.QUESTIONNAIRE_SESSIONS.evaluationActionLearning(sessionId, evaluationId),
        { body: { datasetId } }
      );
      setFlagStatus('actioned');
      setShowAction(false);
      onUpdated?.({ flagStatus: 'actioned', comment: savedComment.trim() || null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not append to the dataset');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-border bg-muted/40 text-foreground space-y-3 rounded border p-3">
      {/* Status line */}
      <div className="flex items-center gap-2 text-xs">
        <Flag className="h-3.5 w-3.5 text-[color:var(--cq-accent)]" aria-hidden />
        <span className="font-medium">{FLAG_LABELS[flagStatus]}</span>
        {actionedDatasetId && (
          <span className="text-muted-foreground font-mono text-[0.65rem]">
            ({actionedDatasetId.slice(0, 8)}…)
          </span>
        )}
      </div>

      {/* Comment */}
      <div className="space-y-1.5">
        <label
          htmlFor={`eval-comment-${evaluationId}`}
          className="text-muted-foreground block text-[0.7rem] font-medium tracking-wide uppercase"
        >
          Reviewer comment
        </label>
        <textarea
          id={`eval-comment-${evaluationId}`}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          maxLength={5000}
          placeholder="Why does this turn matter? What should the interviewer learn from it?"
          className="border-border bg-background text-foreground placeholder:text-muted-foreground w-full resize-y rounded border p-2 text-xs focus:border-[color:var(--cq-accent)] focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void saveComment()}
          disabled={busy !== null || !commentDirty}
          className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[0.7rem] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'comment' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          Save comment
        </button>
      </div>

      {/* Flag transitions */}
      {!locked && (
        <div className="flex flex-wrap gap-1.5">
          {(flagStatus === 'none' || flagStatus === 'dismissed') && (
            <FlagButton onClick={() => void setFlag('flagged')} busy={busy === 'flag'} icon={Flag}>
              Flag for learning
            </FlagButton>
          )}
          {flagStatus === 'flagged' && (
            <FlagButton
              onClick={() => void setFlag('reviewed')}
              busy={busy === 'flag'}
              icon={Check}
            >
              Mark reviewed
            </FlagButton>
          )}
          {(flagStatus === 'flagged' || flagStatus === 'reviewed') && (
            <FlagButton onClick={() => void setFlag('none')} busy={busy === 'flag'} icon={X}>
              Unflag
            </FlagButton>
          )}
          {flagStatus !== 'dismissed' && (
            <FlagButton onClick={() => void setFlag('dismissed')} busy={busy === 'flag'} icon={X}>
              Dismiss
            </FlagButton>
          )}
          {(flagStatus === 'flagged' || flagStatus === 'reviewed') && (
            <FlagButton onClick={() => void loadDatasets()} busy={false} icon={Database} accent>
              Send to dataset…
            </FlagButton>
          )}
        </div>
      )}

      {/* Dataset action panel */}
      {showAction && !locked && (
        <div className="border-border bg-background space-y-2 rounded border p-2.5">
          <label
            htmlFor={`eval-dataset-${evaluationId}`}
            className="text-muted-foreground block text-[0.7rem] font-medium tracking-wide uppercase"
          >
            Append to learning dataset
          </label>
          <select
            id={`eval-dataset-${evaluationId}`}
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            className="border-border bg-background text-foreground w-full rounded border p-1.5 text-xs focus:border-[color:var(--cq-accent)] focus:outline-none"
          >
            <option value="">{datasets === null ? 'Loading…' : 'Choose a dataset…'}</option>
            {(datasets ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => void actionToDataset()}
              disabled={busy !== null || !datasetId}
              className="inline-flex items-center gap-1.5 rounded bg-[color:var(--cq-accent)]/20 px-2.5 py-1 text-[0.7rem] font-semibold text-[color:var(--cq-accent)] transition-colors hover:bg-[color:var(--cq-accent)]/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'action' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
              Append &amp; action
            </button>
            <button
              type="button"
              onClick={() => setShowAction(false)}
              className="text-muted-foreground hover:text-foreground rounded px-2.5 py-1 text-[0.7rem] font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[0.7rem] text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function FlagButton({
  onClick,
  busy,
  icon: Icon,
  accent,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: typeof Flag;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={
        accent
          ? 'inline-flex items-center gap-1.5 rounded border border-[color:var(--cq-accent)]/40 bg-[color:var(--cq-accent)]/10 px-2.5 py-1 text-[0.7rem] font-semibold text-[color:var(--cq-accent)] transition-colors hover:bg-[color:var(--cq-accent)]/20 disabled:opacity-50'
          : 'border-border bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-[0.7rem] font-semibold transition-colors disabled:opacity-50'
      }
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : (
        <Icon className="h-3 w-3" aria-hidden />
      )}
      {children}
    </button>
  );
}
