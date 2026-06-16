import { cn } from '@/lib/utils';

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
 */
export function ConquestWordmark({
  size = 'page',
  showSubtitle = false,
  className,
}: {
  size?: 'nav' | 'page';
  showSubtitle?: boolean;
  className?: string;
}) {
  return (
    <span className={cn(styles.lockup, styles[size], className)} aria-label="ConQuest">
      <span className={styles.brand}>
        <span className={styles.con}>Con</span>
        <span className={styles.q}>Quest</span>
      </span>
      {showSubtitle && (
        <span className={styles.tagline} aria-hidden>
          Conversational Questionnaires
        </span>
      )}
    </span>
  );
}
