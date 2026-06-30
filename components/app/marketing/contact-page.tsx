import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, MessageCircle, Users } from 'lucide-react';
import { ContactForm } from '@/components/forms/contact-form';
import { Wordmark } from '@/components/app/marketing/wordmark';
import shared from '@/components/app/marketing/conquest-marketing.module.css';
import styles from '@/components/app/marketing/contact.module.css';

const metaDescription =
  'Get in touch with the ConQuest team. Whether you want to turn a questionnaire into a conversation, have a question about how it works, or just want to say hello. We read every message and a real person will reply.';

export const metadata: Metadata = {
  title: 'Contact',
  description: metaDescription,
  openGraph: {
    title: 'Contact ConQuest',
    description: metaDescription,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Contact ConQuest',
    description: metaDescription,
  },
};

const nextSteps = [
  {
    title: 'A real person reads it',
    body: 'Every message lands with our team, not a ticketing bot. Nothing gets lost in a queue.',
  },
  {
    title: 'We reply with something useful',
    body: 'Usually within a couple of working days, with a real answer rather than a holding note.',
  },
  {
    title: 'We move at your pace',
    body: 'If it’s a fit, we’ll offer to show you ConQuest on a questionnaire you already run. No pressure, no hard sell.',
  },
];

const audiences = [
  'Teams running surveys',
  'Researchers & analysts',
  'A questionnaire to convert',
  'People & culture teams',
  'Coaches & educators',
  'Just curious',
];

/**
 * Contact Page
 *
 * ConQuest "get in touch" page, built on the shared bespoke marketing system
 * (conquest-marketing.module.css) so it reads as the same site as the home and
 * pricing pages. A centred ink hero introduces the page; a cream section pairs
 * Sunrise's <ContactForm> (validation / rate-limit / DB write / admin email
 * unchanged) with a right rail explaining what happens after you send.
 */
export default function ContactPage() {
  return (
    <div className={shared.page}>
      {/* ---------------- Hero ---------------- */}
      <header className={shared.hero}>
        <div className={`${shared.brandLockup} ${shared.rise}`}>
          <Wordmark />
        </div>
        <p className={`${shared.brandTagline} ${shared.rise}`} style={{ animationDelay: '0.06s' }}>
          Get in touch
        </p>
        <div className={`${styles.heroIntro} ${shared.rise}`} style={{ animationDelay: '0.08s' }}>
          <h1 className={shared.heroTitle}>
            Let’s start a&nbsp;<em>conversation.</em>
          </h1>
          <p className={`${shared.heroSub} ${styles.heroSub}`}>
            Whether you’ve got a questionnaire you’d love to bring to life, a question about how{' '}
            <Wordmark /> works, or you simply want to say hello. There’s a real person at the other
            end, and we read every message.
          </p>
          <div className={shared.ctaRow} style={{ justifyContent: 'center' }}>
            <a href="#message" className={`${shared.btn} ${shared.btnPrimary}`}>
              Send a message <ArrowRight />
            </a>
            <Link href="/#how" className={`${shared.btn} ${shared.btnGhost}`}>
              See how it works
            </Link>
          </div>
        </div>
      </header>

      {/* ---------------- Form + rail ---------------- */}
      <section id="message" className={`${shared.section} ${shared.cream2}`}>
        <div className={shared.inner}>
          <div className={`${shared.sectionHead} ${shared.reveal}`}>
            <span className={shared.eyebrow}>Send a message</span>
            <h2 className={shared.h2}>Tell us what’s on your mind.</h2>
            <p className={shared.lead}>
              The more you can tell us about what you’re trying to understand, the more useful our
              first reply will be. No question too small.
            </p>
          </div>

          <div className={styles.contactGrid}>
            {/* Form */}
            <div className={`${styles.formCard} ${shared.reveal}`}>
              <p className={styles.formKicker}>Contact form</p>
              <p className={styles.formTitle}>Drop us a line</p>
              <ContactForm />
            </div>

            {/* Rail */}
            <div className={styles.rail}>
              <div className={`${styles.railCard} ${shared.reveal}`}>
                <div className={styles.railIcon}>
                  <MessageCircle />
                </div>
                <h3 className={styles.railTitle}>What happens next</h3>
                <p className={styles.railLead}>
                  No autoresponders, no black hole. Here’s what to expect after you hit send.
                </p>
                <div className={styles.next}>
                  {nextSteps.map((s, i) => (
                    <div key={s.title} className={styles.nextItem}>
                      <span className={styles.nextNum}>{i + 1}</span>
                      <div>
                        <h4>{s.title}</h4>
                        <p>{s.body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className={`${styles.railCard} ${shared.reveal}`}>
                <div className={styles.railIcon}>
                  <Users />
                </div>
                <h3 className={styles.railTitle}>Who gets in touch</h3>
                <p className={styles.railLead}>
                  All sorts. If you’re trying to understand people better, you’re in the right
                  place.
                </p>
                <div className={styles.tags}>
                  {audiences.map((a) => (
                    <span key={a} className={styles.tag}>
                      {a}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- Closing CTA ---------------- */}
      <section className={`${shared.section} ${shared.finalCta}`}>
        <div className={shared.finalInner}>
          <h2 className={shared.finalTitle}>
            Rather explore <em>first?</em>
          </h2>
          <p className={shared.finalSub}>
            Have a look around before you reach out. See how <Wordmark /> turns a form into a
            conversation, and what it costs.
          </p>
          <div className={shared.ctaRow}>
            <Link href="/#how" className={`${shared.btn} ${shared.btnPrimary}`}>
              See how it works <ArrowRight />
            </Link>
            <Link href="/pricing" className={`${shared.btn} ${shared.btnGhost}`}>
              View pricing
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
