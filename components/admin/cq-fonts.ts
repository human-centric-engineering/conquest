/**
 * Display typeface for the ConQuest app admin surfaces (Questionnaires & Demo
 * clients). These two subtrees get a distinct editorial identity from the rest
 * of the admin — a characterful serif for headings paired with the platform's
 * system sans for body copy.
 *
 * Loaded once here and exposed as the `--font-display` CSS variable via the
 * `.variable` class, which the `app/admin/questionnaires` and
 * `app/admin/demo-clients` layout wrappers apply alongside `.cq-surface`. Scoped
 * deliberately: orchestration and the rest of `/admin` keep the default stack.
 *
 * Lives in `components/` (not `lib/app/**`) because `next/font/google` is a
 * runtime `next/*` import, which the `lib/app/**` framework-agnostic boundary
 * forbids.
 */
import { Fraunces } from 'next/font/google';

export const displaySerif = Fraunces({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display',
  // Variable `wght` axis (next/font includes it automatically); optical sizing
  // is driven via CSS `font-optical-sizing: auto` in the `.cq-display` rule.
  weight: ['400', '500', '600', '700'],
});
