import type { Metadata } from 'next';
import Link from 'next/link';
import { WaitlistForm } from '@/components/app/marketing/waitlist-form';
import { Wordmark } from '@/components/app/marketing/wordmark';
import shared from '@/components/app/marketing/conquest-marketing.module.css';
import styles from '@/components/app/marketing/waitlist.module.css';

const metaDescription =
  'Join the ConQuest waitlist. The self-serve platform is on its way. Leave your details and you will be among the first to turn questionnaires into conversations when it opens up.';

export const metadata: Metadata = {
  title: 'Join the waitlist',
  description: metaDescription,
  openGraph: {
    title: 'Join the ConQuest waitlist',
    description: metaDescription,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Join the ConQuest waitlist',
    description: metaDescription,
  },
};

/**
 * Waitlist page
 *
 * ConQuest pre-launch waitlist, built on the shared bespoke marketing system so
 * it reads as the same site as home / pricing / contact. A centred ink hero
 * introduces the page; a single cream form card carries the app-owned
 * <WaitlistForm>. The `?from=` query param (set on the marketing CTAs) is
 * recorded as the sign-up `source`.
 */
export default async function WaitlistPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const source = from && from.length <= 60 ? from : 'waitlist';

  return (
    <div className={shared.page}>
      {/* ---------------- Hero ---------------- */}
      <header className={shared.hero}>
        <div className={`${shared.brandLockup} ${shared.rise}`}>
          <Wordmark />
        </div>
        <p className={`${shared.brandTagline} ${shared.rise}`} style={{ animationDelay: '0.06s' }}>
          Join the waitlist
        </p>
        <div className={`${styles.heroIntro} ${shared.rise}`} style={{ animationDelay: '0.08s' }}>
          <h1 className={shared.heroTitle}>
            Be among the&nbsp;<em>first.</em>
          </h1>
          <p className={`${shared.heroSub} ${styles.heroSub}`}>
            The self-serve platform isn’t out yet. We’re building a small founding cohort while{' '}
            <Wordmark /> takes shape, and the people who join now help decide where it goes. Leave
            your details and you’ll be first through the door.
          </p>
        </div>
      </header>

      {/* ---------------- Form ---------------- */}
      <section className={`${shared.section} ${shared.cream2}`}>
        <div className={shared.inner}>
          <div className={styles.formWrap}>
            <div className={`${styles.formCard} ${shared.reveal}`}>
              <p className={styles.formKicker}>Early access</p>
              <p className={styles.formTitle}>Join the founding cohort</p>
              <WaitlistForm source={source} />
              <p className={styles.formNote}>
                No spam, ever. We’ll only email you about ConQuest, and you can ask us to remove
                your details at any time.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- Closing CTA ---------------- */}
      <section className={`${shared.section} ${shared.finalCta}`}>
        <div className={shared.finalInner}>
          <h2 className={shared.finalTitle}>
            Can’t wait to <em>see it?</em>
          </h2>
          <p className={shared.finalSub}>
            Have a look at how <Wordmark /> turns a form into a conversation, or talk to us about a
            bespoke build you don’t have to wait for.
          </p>
          <div className={shared.ctaRow}>
            <Link href="/#how" className={`${shared.btn} ${shared.btnPrimary}`}>
              See how it works
            </Link>
            <Link href="/contact" className={`${shared.btn} ${shared.btnGhost}`}>
              Talk to us
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
