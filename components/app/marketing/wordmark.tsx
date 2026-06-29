import styles from '@/components/app/marketing/conquest-marketing.module.css';

/**
 * ConQuest wordmark for the marketing pages — an inline, surface-adaptive brand
 * lockup: white "Con" + bright marigold "Quest" on the dark bands (hero / ink /
 * final-CTA / ink panels), ink + gold on the light cream surfaces. The colour
 * shift is driven entirely by the marketing CSS module's context selectors
 * (`.ink .brandCon`, `.hero .brandQ`, …), so it can sit inline within body copy
 * on any marketing section and adapt to whatever background it lands on.
 *
 * For the in-app brand lockup (sidebar / page signature, with size variants and
 * the release-stage pill) use `ConquestWordmark` instead — it is a fixed-colour
 * standalone lockup, not a surface-adaptive inline mark.
 */
export function Wordmark() {
  return (
    <span className={styles.brand}>
      <span className={styles.brandCon}>Con</span>
      <span className={styles.brandQ}>Quest</span>
    </span>
  );
}
