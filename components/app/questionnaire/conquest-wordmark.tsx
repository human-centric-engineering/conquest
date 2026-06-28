import { cn } from '@/lib/utils';
import { IS_PRERELEASE, RELEASE_STAGE, type ReleaseStage } from '@/lib/app/release-stage';

import styles from '@/components/app/questionnaire/conquest-wordmark.module.css';

/**
 * ConQuest wordmark + optional "CONVERSATIONAL QUESTIONNAIRES" tagline.
 *
 * The single source of the ConQuest brand lockup on the admin app surface,
 * matching the marketing Pricing / About-ConQuest pages (Fraunces serif,
 * two-tone marigold). Presentational only — safe in server or client trees.
 *
 * Rendered in two places today: the Questionnaires sidebar section header
 * (`size="nav"`) and the top-right signature on every Questionnaires admin
 * page (`size="page"`, via the subtree layout).
 *
 * While the product is pre-release a small uppercase stage pill (`ALPHA` /
 * `BETA`) rides beside the brand, driven by the release-stage seam. Pass
 * `stage` to override (e.g. tests / Storybook); it defaults to the env-derived
 * stage, and a `stable`/unset stage renders no pill.
 */
export function ConquestWordmark({
  size = 'page',
  showSubtitle = false,
  stage = IS_PRERELEASE ? RELEASE_STAGE : null,
  className,
}: {
  size?: 'nav' | 'page';
  showSubtitle?: boolean;
  /** Override the stage pill; defaults to the live release stage (null/`stable` ⇒ no pill). */
  stage?: ReleaseStage | null;
  className?: string;
}) {
  const showStage = stage === 'alpha' || stage === 'beta';
  return (
    <span
      className={cn(styles.lockup, styles[size], className)}
      aria-label={showStage ? `ConQuest (${stage})` : 'ConQuest'}
    >
      <span className={styles.brandRow}>
        <span className={styles.brand}>
          <span className={styles.con}>Con</span>
          <span className={styles.q}>Quest</span>
        </span>
        {showStage && (
          <span className={styles.stage} aria-hidden>
            {stage}
          </span>
        )}
      </span>
      {showSubtitle && (
        <span className={styles.tagline} aria-hidden>
          Conversational Questionnaires
        </span>
      )}
    </span>
  );
}
