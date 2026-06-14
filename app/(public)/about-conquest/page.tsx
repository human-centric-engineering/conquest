import type { Metadata } from 'next';
import { Fraunces, Hanken_Grotesk } from 'next/font/google';
import Link from 'next/link';
import {
  ArrowRight,
  Hourglass,
  ListChecks,
  MessageCircle,
  Scale,
  HelpCircle,
  Users,
  Megaphone,
  MessageSquare,
  Mic,
  FileUp,
  GitCompare,
  BarChart3,
  ShieldCheck,
  FileText,
  FlaskConical,
  Star,
  Compass,
  ClipboardCheck,
  FileSearch,
  HeartPulse,
  GraduationCap,
  Database,
  Ear,
  Pencil,
  Clock,
  Heart,
  TrendingUp,
  Target,
  Plug,
  Check,
  Quote,
} from 'lucide-react';
import styles from '@/app/(public)/about-conquest/about-conquest.module.css';

const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});
const sans = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--font-sans-cq',
  display: 'swap',
});

const metaDescription =
  'ConQuest turns any questionnaire, survey or assessment into a natural conversation: the structure of a form with the depth of a conversation. Higher completion, richer data, less bias.';

export const metadata: Metadata = {
  title: 'About ConQuest',
  description: metaDescription,
  openGraph: {
    title: 'ConQuest: The structure of a form. The depth of a conversation.',
    description: metaDescription,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ConQuest: The structure of a form. The depth of a conversation.',
    description: metaDescription,
  },
};

/** Reusable ConQuest wordmark: white "Con" + yellow "Quest" on dark, ink + gold on light. */
function Wordmark() {
  return (
    <span className={styles.brand}>
      <span className={styles.brandCon}>Con</span>
      <span className={styles.brandQ}>Quest</span>
    </span>
  );
}

const failures = [
  {
    icon: Hourglass,
    title: 'Rushed and abandoned',
    body: 'The longer the form, the worse the data. People skim, satisfice, or never reach the end.',
  },
  {
    icon: ListChecks,
    title: 'Flattened to a checkbox',
    body: 'Real situations don’t fit a five-point scale. Nuance is rounded away the moment someone clicks “somewhat agree”.',
  },
  {
    icon: MessageCircle,
    title: 'No room to explain',
    body: 'A form can’t ask “why”, and it can’t follow up. The most important answer is the one it never thought to ask for.',
  },
  {
    icon: Megaphone,
    title: 'Built-in bias',
    body: 'Leading questions, fixed options and survey fatigue shape the answers as much as the truth does.',
  },
  {
    icon: HelpCircle,
    title: 'Context-free',
    body: 'You get the what, never the why. Numbers with no story behind them are hard to act on with confidence.',
  },
  {
    icon: Users,
    title: 'One size fits no one',
    body: 'A form treats a new hire and a ten-year veteran exactly the same. People aren’t the same.',
  },
];

const steps = [
  {
    icon: FileUp,
    kicker: 'Bring what you already use',
    title: 'Ingest',
    body: (
      <>
        Upload any existing questionnaire, survey, assessment or audit, in PDF, Word or text.{' '}
        <Wordmark /> reads it and maps every field into structured data slots, showing its reasoning
        for you to review.
      </>
    ),
  },
  {
    icon: MessageSquare,
    kicker: 'People have a conversation',
    title: 'Converse',
    body: 'Your respondents never see a form. They talk, typed or spoken, with an AI guide that asks, listens, follows up and adapts, like a skilled interviewer who has read the brief.',
  },
  {
    icon: Database,
    kicker: 'You get structured answers',
    title: 'Understand',
    body: 'Behind the scenes every answer is inferred and filled into the right slot, with confidence scores, context and provenance. The rigour of a questionnaire, the richness of a transcript.',
  },
];

const respondentBenefits = [
  {
    icon: Ear,
    title: 'It feels like being listened to',
    body: 'Not processed. A patient, human-paced conversation that respects your time and your words.',
  },
  {
    icon: Pencil,
    title: 'Answer in your own words',
    body: 'Type or talk. Say it how you’d actually say it, without translating yourself into someone else’s categories.',
  },
  {
    icon: Clock,
    title: 'Faster than it looks',
    body: 'No scrolling through dozens of fields. The conversation only asks for what it still needs.',
  },
  {
    icon: Heart,
    title: 'Space to say what matters',
    body: 'Go deeper where it counts, skip what doesn’t apply. The conversation flexes around you.',
  },
];

const orgBenefits = [
  {
    icon: TrendingUp,
    title: 'Higher completion, better data',
    body: 'More people finish, and what they leave behind is richer, more honest and more complete.',
  },
  {
    icon: Target,
    title: 'Answers you can act on',
    body: 'Structured fields and confidence scores sitting on top of real context. Analysis-ready, with the story still attached.',
  },
  {
    icon: Scale,
    title: 'Less bias, more signal',
    body: 'Neutral phrasing, adaptive follow-ups and contradiction checks lift the quality of every response.',
  },
  {
    icon: Plug,
    title: 'Keep your methodology',
    body: (
      <>
        Your instrument, your scoring, your reporting, all unchanged. <Wordmark /> transforms the
        experience, not your method.
      </>
    ),
  },
];

const features = [
  {
    icon: MessageSquare,
    title: 'Conversational data collection',
    body: 'Fields become data slots, and conversational agents gather exactly what each one needs through dialogue. Nothing required is missed; nothing is asked twice.',
  },
  {
    icon: Mic,
    title: 'Voice or text',
    body: 'Respondents speak or type, whichever suits them. Spoken answers are transcribed and understood just like typed ones, accessible by default.',
  },
  {
    icon: FileUp,
    title: 'Questionnaire ingestion',
    body: (
      <>
        Bring almost any instrument: surveys, assessments, audits, diagnostics, onboarding and
        research forms. <Wordmark /> maps it into a conversation automatically.
      </>
    ),
  },
  {
    icon: Scale,
    title: 'Bias reduction',
    body: 'Neutral phrasing, adaptive ordering and patient follow-up reduce leading questions, fatigue and the rounding that distorts results.',
  },
  {
    icon: GitCompare,
    title: 'Contradiction detection',
    body: (
      <>
        When answers don’t line up, <Wordmark /> notices, and gently explores the inconsistency in
        the moment, instead of leaving you to find it later.
      </>
    ),
  },
  {
    icon: BarChart3,
    title: 'AI-powered analysis',
    body: 'Go beyond counts. Summarise themes, surface what’s driving the numbers, and generate insight across every conversation.',
  },
  {
    icon: ShieldCheck,
    title: 'Safeguarding support',
    body: 'Conversations can be configured to recognise sensitive disclosures and respond with appropriate care and escalation, which is vital in health, education and wellbeing.',
  },
  {
    icon: FileText,
    title: 'Reporting and insights',
    body: 'Turn thousands of conversations into clear, structured reports covering completion, themes, outliers, and the context behind every score.',
  },
];

const comparison = [
  { label: 'The experience', old: 'A wall of fields', neo: 'A guided conversation' },
  { label: 'Input', old: 'Click the closest option', neo: 'Say it in your own words' },
  { label: 'Follow-up', old: 'One size fits all', neo: 'Adapts and digs deeper' },
  { label: 'What you capture', old: 'The what', neo: 'The what and the why' },
  { label: 'Missing answers', old: 'Submitted half-empty', neo: 'Gathered through dialogue' },
  { label: 'Contradictions', old: 'Found later, if ever', neo: 'Explored in the moment' },
  { label: 'Accessibility', old: 'Reading and typing', neo: 'Speak or type, your pace' },
  { label: 'Completion', old: 'Drops with every field', neo: 'Stays high to the end' },
];

const useCases = [
  {
    icon: Users,
    title: 'Employee engagement',
    body: 'Surveys people actually finish, and answer honestly. Hear what’s really going on, not just where the slider landed.',
  },
  {
    icon: FlaskConical,
    title: 'Research',
    body: 'Structured interviews at survey scale. Open-ended depth, with data you can still analyse.',
  },
  {
    icon: Star,
    title: 'Customer feedback',
    body: 'Move past the star rating to the reason behind it, at a volume no human team could interview.',
  },
  {
    icon: Compass,
    title: 'Coaching',
    body: 'Intake and reflection that feels like a session, capturing the nuance a form would flatten.',
  },
  {
    icon: ClipboardCheck,
    title: 'Assessments',
    body: 'Diagnostics and self-assessments that adapt to each person, with your scoring intact.',
  },
  {
    icon: FileSearch,
    title: 'Audits',
    body: 'Walk people through compliance and risk questions conversationally, with a clear structured trail.',
  },
  {
    icon: HeartPulse,
    title: 'Healthcare',
    body: 'Patient intake and wellbeing check-ins that are patient, accessible and sensitive to what’s disclosed.',
  },
  {
    icon: GraduationCap,
    title: 'Education',
    body: 'Student voice, admissions and learning reviews that invite real reflection, not box-ticking.',
  },
];

const faqs = [
  {
    q: 'Do I have to rebuild my questionnaire?',
    a: (
      <>
        No. Bring what you already use. <Wordmark /> ingests your existing instrument and maps it
        into a conversation, while your questions, your scoring and your methodology stay intact.
      </>
    ),
  },
  {
    q: 'Is it still structured data at the end?',
    a: 'Yes, and that’s the whole point. Every conversation produces the same structured fields a form would, plus a confidence score, context and provenance for each one.',
  },
  {
    q: 'Can people answer by voice?',
    a: 'Yes. Respondents can speak or type at any time. Spoken answers are transcribed and understood exactly like text, which also makes questionnaires far more accessible.',
  },
  {
    q: 'What kinds of questionnaires work?',
    a: 'Almost any: surveys, assessments, audits, diagnostics, onboarding, employee and customer feedback, research instruments, health and coaching questionnaires, and compliance processes.',
  },
  {
    q: 'Won’t an AI conversation introduce its own bias?',
    a: 'It’s designed to reduce it, with neutral phrasing, a consistent intent behind every question, and contradiction checks. You review the extracted structure and the reasoning before anything goes live.',
  },
  {
    q: 'Which AI provider do you use?',
    a: (
      <>
        <Wordmark /> is provider-agnostic. It runs on the model and provider you choose, so you stay
        in control of cost, data residency and vendor.
      </>
    ),
  },
  {
    q: 'How do we get started?',
    a: 'Bring one questionnaire you already run. We’ll turn it into a conversation and show you the difference on your own content.',
  },
];

/**
 * About ConQuest
 *
 * Public marketing page for ConQuest (Conversational Questionnaires).
 * Self-contained bespoke design (own palette + Fraunces/Hanken type), kept
 * deliberately separate from the inherited Sunrise /about page.
 */
export default function AboutConquestPage() {
  return (
    <div className={`${display.variable} ${sans.variable} ${styles.page}`}>
      {/* ---------------- Hero ---------------- */}
      <header className={styles.hero}>
        <div className={`${styles.brandLockup} ${styles.rise}`}>
          <Wordmark />
        </div>
        <p className={`${styles.brandTagline} ${styles.rise}`} style={{ animationDelay: '0.06s' }}>
          Conversational Questionnaires
        </p>
        <div className={styles.heroGrid}>
          <div>
            <h1
              className={`${styles.heroTitle} ${styles.rise}`}
              style={{ animationDelay: '0.08s' }}
            >
              The structure of a&nbsp;form.
              <br />
              The depth of a&nbsp;<em>conversation.</em>
            </h1>
            <p className={`${styles.heroSub} ${styles.rise}`} style={{ animationDelay: '0.16s' }}>
              Nobody enjoys filling in forms, so we replaced them. <Wordmark /> turns any
              questionnaire, survey or assessment into a natural conversation, guided by AI that
              listens like your best interviewer and records like your most meticulous analyst.
            </p>
            <div className={`${styles.ctaRow} ${styles.rise}`} style={{ animationDelay: '0.24s' }}>
              <Link href="/contact" className={`${styles.btn} ${styles.btnPrimary}`}>
                Request a demo <ArrowRight />
              </Link>
              <a href="#how" className={`${styles.btn} ${styles.btnGhost}`}>
                See how it works
              </a>
            </div>
            <p className={`${styles.heroTrust} ${styles.rise}`} style={{ animationDelay: '0.32s' }}>
              <b>Higher completion.</b> <span className={styles.dotSep} /> Richer data.{' '}
              <span className={styles.dotSep} /> Less bias.
            </p>
          </div>

          {/* Hero art: a live conversation filling structured slots */}
          <div className={styles.heroArt} aria-hidden="true">
            <div className={styles.chatPanel}>
              <div className={styles.chatHead}>
                <span className={styles.chatAvatar}>C</span>
                Engagement check-in
              </div>
              <div className={`${styles.bubble} ${styles.bAgent}`}>
                What made you stay with the team this year?
              </div>
              <div className={`${styles.bubble} ${styles.bUser}`}>
                Honestly? The people. My manager actually listens when something’s wrong.
              </div>
              <div className={`${styles.bubble} ${styles.bAgent}`}>
                That matters. How supported do you feel day&#8209;to&#8209;day?
              </div>
              <div className={`${styles.bubble} ${styles.bUser}`} style={{ width: '54%' }}>
                <span className={styles.typing}>
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>

            <div className={styles.slotPanel}>
              <div className={styles.slotLabel}>
                <span className={styles.livedot} /> Captured live
              </div>
              <div className={styles.slot}>
                <span className={styles.slotName}>
                  <span className={styles.slotCheck}>
                    <Check strokeWidth={3} />
                  </span>
                  Belonging
                </span>
                <span className={`${styles.conf} ${styles.confHi}`}>0.92</span>
              </div>
              <div className={styles.slot}>
                <span className={styles.slotName}>
                  <span className={styles.slotCheck}>
                    <Check strokeWidth={3} />
                  </span>
                  Manager support
                </span>
                <span className={`${styles.conf} ${styles.confHi}`}>0.88</span>
              </div>
              <div className={styles.slot}>
                <span className={styles.slotName}>
                  <span className={styles.slotSpin} />
                  Engagement
                </span>
                <span className={styles.conf}>…</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ---------------- Problem ---------------- */}
      <section className={styles.section}>
        <div className={styles.inner}>
          <div className={`${styles.sectionHead} ${styles.reveal}`}>
            <span className={styles.eyebrow}>The problem</span>
            <h2 className={styles.h2}>Forms were never the point. Understanding people was.</h2>
            <p className={styles.lead}>
              People are tired of boring forms. They don’t trust where the answers go, they’re worn
              down by survey after survey, and they’ve learned that nothing usually changes as a
              result. So they rush, round to the nearest acceptable answer, and tick “neutral” just
              to reach the end. We collect the data and miss the person.
            </p>
          </div>

          <div className={styles.failGrid}>
            {failures.map((f, i) => {
              const Icon = f.icon;
              return (
                <div key={f.title} className={`${styles.failCard} ${styles.reveal}`}>
                  <div className={`${styles.chip} ${i % 2 === 1 ? styles.chipYellow : ''}`}>
                    <Icon />
                  </div>
                  <h3 className={styles.cardTitle}>{f.title}</h3>
                  <p className={styles.cardBody}>{f.body}</p>
                </div>
              );
            })}
          </div>

          <p className={`${styles.pullquote} ${styles.reveal}`}>
            “Finally, there’s a better way to understand people.”
          </p>
        </div>
      </section>

      {/* ---------------- How it works ---------------- */}
      <section id="how" className={`${styles.section} ${styles.ink}`}>
        <div className={styles.inner}>
          <div className={`${styles.sectionHead} ${styles.reveal}`}>
            <span className={`${styles.eyebrow} ${styles.eyebrowLight}`}>How it works</span>
            <h2 className={styles.h2}>Bring the questionnaire you already have.</h2>
            <p className={styles.lead}>
              No rebuild, no new methodology. Three steps from a static form to a conversation that
              understands.
            </p>
          </div>

          <div className={styles.steps}>
            {steps.map((s) => {
              const Icon = s.icon;
              return (
                <div key={s.title} className={`${styles.step} ${styles.reveal}`}>
                  <div className={styles.stepNum}>{steps.indexOf(s) + 1}</div>
                  <div className={styles.stepTitle}>
                    <Icon /> {s.title}
                  </div>
                  <p className={styles.stepBody}>
                    <strong style={{ color: 'var(--t-cream)' }}>{s.kicker}.</strong> {s.body}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------- Benefits split ---------------- */}
      <section className={`${styles.section} ${styles.cream2}`}>
        <div className={styles.inner}>
          <div className={`${styles.sectionHead} ${styles.reveal}`}>
            <span className={styles.eyebrow}>Who it’s for</span>
            <h2 className={styles.h2}>
              Better for the people answering.
              <br />
              Better for the people asking.
            </h2>
          </div>

          <div className={styles.split}>
            <div className={`${styles.panel} ${styles.panelLight} ${styles.reveal}`}>
              <span className={styles.panelKicker}>For respondents</span>
              <h3 className={styles.panelTitle}>An experience worth finishing</h3>
              <div className={styles.bList}>
                {respondentBenefits.map((b) => {
                  const Icon = b.icon;
                  return (
                    <div key={b.title} className={styles.bItem}>
                      <span className={styles.bIcon}>
                        <Icon />
                      </span>
                      <div>
                        <h4>{b.title}</h4>
                        <p>{b.body}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={`${styles.panel} ${styles.panelInk} ${styles.reveal}`}>
              <span className={styles.panelKicker}>For organisations</span>
              <h3 className={styles.panelTitle}>Data you can finally trust</h3>
              <div className={styles.bList}>
                {orgBenefits.map((b) => {
                  const Icon = b.icon;
                  return (
                    <div key={b.title} className={styles.bItem}>
                      <span className={styles.bIcon}>
                        <Icon />
                      </span>
                      <div>
                        <h4>{b.title}</h4>
                        <p>{b.body}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- Features ---------------- */}
      <section className={styles.section}>
        <div className={styles.inner}>
          <div className={`${styles.sectionHead} ${styles.reveal}`}>
            <span className={styles.eyebrow}>The platform</span>
            <h2 className={styles.h2}>Everything you need to turn questions into understanding.</h2>
            <p className={styles.lead}>
              <Wordmark /> doesn’t just digitise questionnaires. It transforms them into intelligent
              conversations, and gives you the tools to make them sharper over time.
            </p>
          </div>

          <div className={styles.featGrid}>
            {features.map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.title} className={`${styles.featCard} ${styles.reveal}`}>
                  <div className={styles.featIcon}>
                    <Icon />
                  </div>
                  <h3 className={styles.featTitle}>{f.title}</h3>
                  <p className={styles.featBody}>{f.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------- Comparison ---------------- */}
      <section className={`${styles.section} ${styles.cream2}`}>
        <div className={styles.inner}>
          <div
            className={`${styles.sectionHead} ${styles.reveal}`}
            style={{ textAlign: 'center', marginInline: 'auto' }}
          >
            <span className={styles.eyebrow} style={{ justifyContent: 'center' }}>
              The difference
            </span>
            <h2 className={styles.h2}>From form filling to meaningful conversations.</h2>
          </div>

          <div className={`${styles.compare} ${styles.reveal}`}>
            <div className={styles.compareHead}>
              <div></div>
              <div className={styles.chOld}>Traditional forms</div>
              <div className={styles.chNew}>
                <Wordmark />
              </div>
            </div>
            {comparison.map((row) => (
              <div key={row.label} className={styles.cRow}>
                <div className={styles.cLabel}>{row.label}</div>
                <div className={styles.cOld}>{row.old}</div>
                <div className={styles.cNew}>
                  <Check strokeWidth={3} />
                  {row.neo}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- Use cases ---------------- */}
      <section className={styles.section}>
        <div className={styles.inner}>
          <div className={`${styles.sectionHead} ${styles.reveal}`}>
            <span className={styles.eyebrow}>Where it works</span>
            <h2 className={styles.h2}>One platform. Every kind of question worth asking well.</h2>
            <p className={styles.lead}>
              If you’re trying to understand people, their experience, their needs, their truth,
              then <Wordmark /> fits.
            </p>
          </div>

          <div className={styles.useGrid}>
            {useCases.map((u) => {
              const Icon = u.icon;
              return (
                <div key={u.title} className={`${styles.useCard} ${styles.reveal}`}>
                  <div className={styles.useIcon}>
                    <Icon />
                  </div>
                  <h3 className={styles.useTitle}>{u.title}</h3>
                  <p className={styles.useBody}>{u.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------- Social proof ---------------- */}
      <section className={`${styles.section} ${styles.ink}`}>
        <div className={styles.inner}>
          <p className={styles.proofNote}>Trusted by teams who’d rather understand than tally</p>
          <div className={styles.logoRow}>
            {['Your logo', 'Your logo', 'Your logo', 'Your logo', 'Your logo'].map((l, i) => (
              <div key={i} className={styles.logo}>
                {l}
              </div>
            ))}
          </div>

          <div className={styles.quoteCard}>
            <Quote className={styles.quoteMark} />
            <p className={styles.quoteText}>
              We replaced a 40-question survey with a single conversation. Completion went up, and
              for the first time we understood <span>why</span> behind the numbers.
            </p>
            <p className={styles.quoteAttr}>
              <b>[ Name, Role ]</b>, [ Organisation ]
            </p>
          </div>

          <div className={styles.stats}>
            <div className={styles.stat}>
              <div className={styles.statNum}>[ xx% ]</div>
              <div className={styles.statLabel}>higher completion rate</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statNum}>[ x.x× ]</div>
              <div className={styles.statLabel}>more context per response</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statNum}>[ xx% ]</div>
              <div className={styles.statLabel}>faster to actionable insight</div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- FAQ ---------------- */}
      <section className={styles.section}>
        <div className={styles.inner}>
          <div
            className={`${styles.sectionHead} ${styles.reveal}`}
            style={{ textAlign: 'center', marginInline: 'auto' }}
          >
            <span className={styles.eyebrow} style={{ justifyContent: 'center' }}>
              Questions
            </span>
            <h2 className={styles.h2}>The things people ask first.</h2>
          </div>

          <div className={styles.faqWrap}>
            {faqs.map((item) => (
              <details key={item.q} className={styles.faq}>
                <summary>
                  {item.q}
                  <span className={styles.faqIcon} aria-hidden="true" />
                </summary>
                <p className={styles.faqBody}>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- Final CTA ---------------- */}
      <section className={`${styles.section} ${styles.finalCta}`}>
        <div className={styles.finalInner}>
          <h2 className={styles.finalTitle}>
            Stop collecting answers.
            <br />
            Start <em>understanding people.</em>
          </h2>
          <p className={styles.finalSub}>
            Give us one questionnaire you already use. <Wordmark /> will turn it into a
            conversation, and show you the depth you’ve been missing.
          </p>
          <div className={styles.ctaRow}>
            <Link href="/contact" className={`${styles.btn} ${styles.btnPrimary}`}>
              Request a demo <ArrowRight />
            </Link>
            <Link href="/signup" className={`${styles.btn} ${styles.btnGhost}`}>
              Get started
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
