import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  Sparkles,
  Megaphone,
  Users,
  FlaskConical,
  BarChart3,
  FileText,
  ShieldCheck,
  Repeat,
  CalendarClock,
  Rocket,
  Microscope,
  PenTool,
  LineChart,
  Workflow,
  Palette,
  HeartPulse,
  GitBranch,
  Layers,
  Compass,
  PencilRuler,
  Hammer,
  Sprout,
} from 'lucide-react';
import { Wordmark } from '@/components/app/marketing/wordmark';
import shared from '@/components/app/marketing/conquest-marketing.module.css';
import styles from '@/app/(public)/pricing/pricing.module.css';

const metaDescription =
  'ConQuest pricing: bespoke implementations that build deep analysis, narration, charting and reporting around the ConQuest core today, with a self-serve SaaS platform on the way. Join the waitlist to be first.';

export const metadata: Metadata = {
  title: 'Pricing',
  description: metaDescription,
  openGraph: {
    title: 'ConQuest Pricing: from a subscription to a build of your own.',
    description: metaDescription,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ConQuest Pricing: from a subscription to a build of your own.',
    description: metaDescription,
  },
};

const coreTags = [
  { icon: BarChart3, label: 'Deep analysis' },
  { icon: FileText, label: 'Narrative reports' },
  { icon: LineChart, label: 'Custom charts' },
  { icon: Repeat, label: 'Periodic surveys' },
  { icon: Workflow, label: 'Integrations' },
  { icon: Palette, label: 'White-label' },
];

const tiers = [
  {
    name: 'Explore',
    tagline:
      'Turn your first questionnaire into a conversation and see the difference on your own content.',
    currency: '',
    amount: 'Coming soon',
    unit: '',
    billing: 'Pricing confirmed at launch',
    featured: false,
    cta: { label: 'Join the waitlist', href: '/waitlist?from=pricing' },
    featuresLabel: "What's included",
    features: [
      <>
        <b>1</b> live questionnaire
      </>,
      'A monthly conversation allowance',
      'Text responses',
      'Automatic questionnaire ingestion',
      'Structured context extraction',
      'Completion analytics',
    ],
  },
  {
    name: 'Professional',
    tagline:
      'For teams running questionnaires regularly, who want depth, voice and analysis as standard.',
    currency: '',
    amount: 'Coming soon',
    unit: '',
    billing: 'Pricing confirmed at launch',
    featured: true,
    badge: 'Most popular',
    cta: { label: 'Request a demo', href: '/contact' },
    featuresLabel: 'Everything in Explore, plus',
    features: [
      'Multiple live questionnaires',
      'A higher monthly conversation volume',
      'Voice or text responses',
      'Adaptive follow-up & contradiction checks',
      'AI-powered analysis & themes',
      'Reporting & data exports',
      'Bring your own model & provider',
    ],
  },
  {
    name: 'Scale',
    tagline:
      'For high-volume, sensitive or regulated programmes that need control, assurance and support.',
    currency: '',
    amount: "Let's talk",
    unit: '',
    billing: 'tailored to volume & requirements',
    featured: false,
    cta: { label: 'Talk to us', href: '/contact' },
    featuresLabel: 'Everything in Professional, plus',
    features: [
      'Unlimited questionnaires & high volume',
      'Safeguarding & escalation workflows',
      'SSO & role-based access control',
      'Audit trail & data-residency controls',
      'Priority support with SLA',
      'Onboarding & a success manager',
    ],
  },
];

const includedEverywhere = [
  {
    text: (
      <>
        <b>Conversational</b>, not form-filling
      </>
    ),
  },
  {
    text: (
      <>
        <b>Structured data</b> out the other end
      </>
    ),
  },
  {
    text: (
      <>
        Confidence scores & <b>provenance</b>
      </>
    ),
  },
  {
    text: (
      <>
        Your <b>methodology</b>, kept intact
      </>
    ),
  },
  {
    text: (
      <>
        Neutral phrasing & <b>bias reduction</b>
      </>
    ),
  },
  {
    text: (
      <>
        Accessible by <b>voice or text</b>
      </>
    ),
  },
  {
    text: (
      <>
        <b>Provider-agnostic</b> model choice
      </>
    ),
  },
  {
    text: (
      <>
        Secure hosting & <b>GDPR erasure</b>
      </>
    ),
  },
  {
    text: (
      <>
        Review the <b>extraction</b> before you go live
      </>
    ),
  },
];

const paths = [
  {
    variant: 'light' as const,
    kicker: 'Self-serve · coming soon',
    title: 'SaaS subscription',
    lead: (
      <>
        Bring a questionnaire and go live in an afternoon, once it launches. The whole <Wordmark />{' '}
        platform, priced to scale with how much you run.
      </>
    ),
    points: [
      'You run standard questionnaires, surveys or assessments',
      'You want to be live this week, not next quarter',
      'Built-in analysis, themes and reporting are enough',
      'You’d rather a predictable monthly subscription',
    ],
    cta: { label: 'See what’s coming', href: '#plans' },
  },
  {
    variant: 'ink' as const,
    kicker: 'Bespoke · available now',
    title: 'Custom implementation',
    lead: (
      <>
        We build around the <Wordmark /> core, shaped to your domain: your analysis methodology,
        your narration, your charts, your reporting, your product.
      </>
    ),
    points: [
      'Your methodology needs bespoke scoring or models',
      'You want narrative reports and dashboards of your own',
      'It must live inside your product, brand and data stack',
      'You’re building something only you can offer',
    ],
    cta: { label: 'Explore custom builds', href: '#custom' },
  },
];

const useClusters = [
  {
    icon: Megaphone,
    title: 'Customers & market',
    tags: [
      'Discovery',
      'Customer feedback',
      'Market research',
      'Brand & concept testing',
      'Product feedback',
      'Win/loss interviews',
    ],
  },
  {
    icon: Users,
    title: 'People & culture',
    tags: [
      'Team sentiment',
      'Employee engagement',
      'Organisational alignment',
      'Onboarding',
      'Exit interviews',
      'Wellbeing check-ins',
    ],
  },
  {
    icon: FlaskConical,
    title: 'Research & insight',
    tags: [
      'Focus groups',
      'Research interviews',
      'Stakeholder consultation',
      'Pulse & longitudinal surveys',
      'Coaching & reflection',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Assurance & care',
    tags: [
      'Assessments & diagnostics',
      'Audits & compliance',
      'Patient intake',
      'Student voice & admissions',
    ],
  },
];

const beyond = [
  {
    icon: CalendarClock,
    title: 'Periodic & pulse surveys',
    body: 'Schedule a conversation to re-run weekly, monthly or quarterly. Track how sentiment, engagement or risk moves over time, automatically.',
  },
  {
    icon: GitBranch,
    title: 'Longitudinal programmes',
    body: 'Follow the same cohort across a season or a year. Compare answers conversation to conversation and watch the story develop, not just the snapshot.',
  },
  {
    icon: Layers,
    title: 'Question packs & templates',
    body: 'Drop in ready-made instruments for engagement, wellbeing, onboarding or research, and adapt them to your voice in minutes.',
  },
  {
    icon: Rocket,
    title: 'Special product developments',
    body: 'Need something the platform doesn’t do yet? We co-develop new capabilities with you, and the best of them become part of your plan.',
  },
];

const possibilities = [
  {
    icon: Microscope,
    title: 'Deep analysis methodology',
    body: 'Encode your scoring, statistical models and frameworks so every conversation is interpreted exactly the way your method demands.',
  },
  {
    icon: PenTool,
    title: 'Robust narration',
    body: 'Automated write-ups that read like your best analyst penned them: clear, careful and grounded in the actual words people used.',
  },
  {
    icon: LineChart,
    title: 'Custom charting & dashboards',
    body: 'Visualise what matters to you. Live dashboards, segment breakdowns and trends, designed around the decisions you need to make.',
  },
  {
    icon: FileText,
    title: 'Bespoke reporting',
    body: 'Board packs, regulator-ready summaries, per-respondent dossiers. Whatever shape your reporting takes, generated on demand.',
  },
  {
    icon: Repeat,
    title: 'Periodic & cohort programmes',
    body: 'Recurring surveys, benchmarks and longitudinal studies, wired into your calendar and your data warehouse.',
  },
  {
    icon: Workflow,
    title: 'Integrations & data pipelines',
    body: 'Push structured answers straight into your CRM, BI, LMS or data lake. ConQuest becomes one clean stage in your pipeline.',
  },
  {
    icon: HeartPulse,
    title: 'Domain-tuned safeguarding',
    body: 'Escalation paths and sensitivity shaped to your duty of care, vital in health, education and wellbeing settings.',
  },
  {
    icon: Palette,
    title: 'White-label & embedding',
    body: 'Your brand, your domain, embedded inside your own product. Respondents only ever see you.',
  },
];

const buildSteps = [
  {
    icon: Compass,
    kicker: 'Discover',
    title: 'Discover',
    body: 'We start with the questionnaire you already run and the decisions you’re trying to make. We map what “great” looks like for your data.',
  },
  {
    icon: PencilRuler,
    kicker: 'Design',
    title: 'Design',
    body: 'We design the conversation, the analysis methodology, the narration and the reporting together, on your content, until the output earns your trust.',
  },
  {
    icon: Hammer,
    kicker: 'Build',
    title: 'Build',
    body: 'We build on the ConQuest core: bespoke scoring, dashboards, integrations and branding, deployed into your stack.',
  },
  {
    icon: Sprout,
    kicker: 'Evolve',
    title: 'Evolve',
    body: 'It keeps improving. New question sets, fresh analyses and special developments land as your programme grows.',
  },
];

const faqs = [
  {
    q: 'Is the self-serve platform available yet?',
    a: (
      <>
        Not yet. Bespoke builds and guided demos are available today, and the self-serve platform is
        on its way. Join the waitlist and you’ll be among the first to use it, and help shape it.
      </>
    ),
  },
  {
    q: 'What counts as a “conversation”?',
    a: 'One respondent completing one questionnaire, however long the dialogue runs and whether they speak or type. When the platform launches you’ll be billed on completed conversations, not on messages or minutes.',
  },
  {
    q: 'Can we start now and move onto the platform later?',
    a: (
      <>
        Yes, and most will. Start today with a bespoke build or a guided demo on your own content.
        When the self-serve platform launches you can move onto it, and your questionnaires and data
        come with you.
      </>
    ),
  },
  {
    q: 'What does a custom implementation actually include?',
    a: 'Whatever your problem needs: bespoke scoring and analysis methodology, narrative reporting, custom dashboards and charting, integrations into your systems, domain-tuned safeguarding, and full white-labelling, all built on the same ConQuest core.',
  },
  {
    q: 'How is a custom build priced?',
    a: 'As a scoped engagement for the design and build, plus an ongoing platform licence sized to your volume and support needs. We’ll give you a clear, fixed proposal before any work starts.',
  },
  {
    q: 'Who owns the data and the responses?',
    a: (
      <>
        You do. <Wordmark /> is provider-agnostic, so you choose the model, the provider and where
        data lives. You can export everything, and account deletion erases personal data on request.
      </>
    ),
  },
  {
    q: 'Will you offer annual billing or non-profit pricing?',
    a: 'That’s the plan. We expect annual plans to come at a discount, with reduced pricing for education, healthcare and non-profit organisations. Tell us about your work via the waitlist and we’ll factor it in.',
  },
];

/**
 * Pricing
 *
 * Public marketing page for ConQuest pricing. Self-contained bespoke design; it
 * reuses the shared ConQuest marketing CSS module
 * (components/app/marketing/conquest-marketing.module.css) for the shared palette,
 * type and layout primitives, and adds pricing-specific components (tier cards,
 * included strip, dark glass cards, hero art) via pricing.module.css.
 */
export default function PricingPage() {
  return (
    <div className={shared.page}>
      {/* ---------------- Hero ---------------- */}
      <header className={shared.hero}>
        <div className={`${shared.brandLockup} ${shared.rise}`}>
          <Wordmark />
        </div>
        <p className={`${shared.brandTagline} ${shared.rise}`} style={{ animationDelay: '0.06s' }}>
          Pricing
        </p>
        <div className={shared.heroGrid}>
          <div>
            <h1
              className={`${shared.heroTitle} ${shared.rise}`}
              style={{ animationDelay: '0.08s' }}
            >
              Subscribe to the&nbsp;platform.
              <br />
              Or <em>build your&nbsp;own.</em>
            </h1>
            <p className={`${shared.heroSub} ${shared.rise}`} style={{ animationDelay: '0.16s' }}>
              Two ways to work with <Wordmark />. Today, we build a bespoke product around the core:
              deep analysis, robust narration, custom charting and reporting, shaped entirely to
              your organisation. A self-serve plan is on its way.
            </p>
            <div className={`${shared.ctaRow} ${shared.rise}`} style={{ animationDelay: '0.24s' }}>
              <a href="#plans" className={`${shared.btn} ${shared.btnPrimary}`}>
                See the plans <ArrowRight />
              </a>
              <Link href="/contact" className={`${shared.btn} ${shared.btnGhost}`}>
                Talk to us
              </Link>
            </div>
            <p className={`${shared.heroTrust} ${shared.rise}`} style={{ animationDelay: '0.32s' }}>
              <b>Bespoke builds today.</b> <span className={shared.dotSep} /> Self-serve soon.{' '}
              <span className={shared.dotSep} /> Own your data.
            </p>
          </div>

          {/* Hero art: the ConQuest core, ready to extend */}
          <div className={shared.heroArt} aria-hidden="true">
            <div className={styles.heroArt}>
              <div className={styles.coreCard}>
                <span className={styles.coreBadge}>The ConQuest core</span>
                <p className={styles.coreTitle}>One conversation engine</p>
                <p className={styles.coreSub}>Build on it today, subscribe soon.</p>
                <div className={styles.coreTags}>
                  {coreTags.map((t) => {
                    const Icon = t.icon;
                    return (
                      <span key={t.label} className={styles.coreTag}>
                        <Icon /> {t.label}
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className={styles.bespokeChip}>
                <Sparkles /> Built around you
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ---------------- Two paths ---------------- */}
      <section className={`${shared.section} ${shared.cream2}`}>
        <div className={shared.inner}>
          <div className={`${shared.sectionHead} ${shared.reveal}`}>
            <span className={shared.eyebrow}>Two ways in</span>
            <h2 className={shared.h2}>Build bespoke now, or subscribe to the platform soon.</h2>
            <p className={shared.lead}>
              The same conversation engine powers both. Pick the entry point that fits where you are
              today. You can always go deeper later.
            </p>
          </div>

          <div className={shared.split}>
            {paths.map((p) => (
              <div
                key={p.title}
                className={`${shared.panel} ${
                  p.variant === 'ink' ? shared.panelInk : shared.panelLight
                } ${shared.reveal}`}
              >
                <span className={shared.panelKicker}>{p.kicker}</span>
                <h3 className={shared.panelTitle}>{p.title}</h3>
                <p className={styles.panelLead}>{p.lead}</p>
                <ul className={styles.chooseList}>
                  {p.points.map((point, i) => (
                    <li key={i} className={styles.chooseItem}>
                      <Check strokeWidth={3} />
                      {point}
                    </li>
                  ))}
                </ul>
                <a
                  href={p.cta.href}
                  className={`${shared.btn} ${
                    p.variant === 'ink' ? shared.btnPrimary : shared.btnDark
                  }`}
                >
                  {p.cta.label} <ArrowRight />
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- Use cases ---------------- */}
      <section className={shared.section}>
        <div className={shared.inner}>
          <div className={`${shared.sectionHead} ${shared.reveal}`}>
            <span className={shared.eyebrow}>Use cases</span>
            <h2 className={shared.h2}>One subscription. Every kind of question worth asking.</h2>
            <p className={shared.lead}>
              From discovery to assurance, the same conversation engine adapts to whatever you need
              to understand. A sample of where teams point it:
            </p>
          </div>

          <div className={styles.useClusterGrid}>
            {useClusters.map((cluster) => {
              const Icon = cluster.icon;
              return (
                <div key={cluster.title} className={`${styles.useCluster} ${shared.reveal}`}>
                  <div className={styles.clusterHead}>
                    <span className={styles.clusterIcon}>
                      <Icon />
                    </span>
                    <h3 className={styles.clusterTitle}>{cluster.title}</h3>
                  </div>
                  <div className={styles.useTagRow}>
                    {cluster.tags.map((tag) => (
                      <span key={tag} className={styles.useTag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------- SaaS plans ---------------- */}
      <section id="plans" className={shared.section}>
        <div className={shared.inner}>
          <div className={`${shared.sectionHead} ${shared.reveal}`}>
            <span className={shared.eyebrow}>SaaS subscriptions · coming soon</span>
            <h2 className={shared.h2}>Plans that scale with how much you ask.</h2>
            <p className={shared.lead}>
              Every plan is the full conversational experience. The difference is volume, depth and
              support. We’re still setting prices, and founding users help shape them, so join the
              waitlist and you’ll hear first.
            </p>
          </div>

          <div className={styles.tierGrid}>
            {tiers.map((tier) => (
              <div
                key={tier.name}
                className={`${styles.tier} ${tier.featured ? styles.tierFeatured : ''} ${
                  shared.reveal
                }`}
              >
                {tier.badge ? <span className={styles.tierBadge}>{tier.badge}</span> : null}
                <h3 className={styles.tierName}>{tier.name}</h3>
                <p className={styles.tierTagline}>{tier.tagline}</p>
                <div className={styles.tierPrice}>
                  {tier.currency ? (
                    <span className={styles.tierCurrency}>{tier.currency}</span>
                  ) : null}
                  <span className={styles.tierAmount}>{tier.amount}</span>
                  {tier.unit ? <span className={styles.tierUnit}>{tier.unit}</span> : null}
                </div>
                <p className={styles.tierBilling}>{tier.billing}</p>
                <div className={styles.tierDivide} />
                <p className={styles.tierFeatLabel}>{tier.featuresLabel}</p>
                <ul className={styles.tierFeatures}>
                  {tier.features.map((f, i) => (
                    <li key={i} className={styles.tierFeat}>
                      <Check strokeWidth={3} />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <div className={styles.tierCta}>
                  <Link
                    href={tier.cta.href}
                    className={`${shared.btn} ${
                      tier.featured ? shared.btnPrimary : shared.btnDark
                    } ${styles.tierBtn}`}
                  >
                    {tier.cta.label} <ArrowRight />
                  </Link>
                </div>
              </div>
            ))}
          </div>

          <p className={`${styles.priceFoot} ${shared.reveal}`}>
            Don’t want to wait? A bespoke build is available today.{' '}
            <Link href="#custom" style={{ color: 'var(--blue)', fontWeight: 600 }}>
              See what a custom implementation can do
            </Link>
            .
          </p>

          <div className={`${styles.included} ${shared.reveal}`}>
            <div className={styles.includedHead}>
              <ShieldCheck /> In every plan
            </div>
            <div className={styles.includedGrid}>
              {includedEverywhere.map((item, i) => (
                <div key={i} className={styles.includedItem}>
                  <Check strokeWidth={3} />
                  <span>{item.text}</span>
                </div>
              ))}
            </div>
          </div>

          <p className={styles.priceFoot}>
            You bring your own AI provider, so you control the model, the cost and where data lives,
            and the usage-driven part of the bill is yours rather than marked up by us. Education,
            healthcare and non-profit pricing will be part of the mix at launch.{' '}
            <Link href="/waitlist?from=pricing" style={{ color: 'var(--blue)', fontWeight: 600 }}>
              Join the waitlist
            </Link>{' '}
            to help shape it.
          </p>
        </div>
      </section>

      {/* ---------------- Beyond the subscription ---------------- */}
      <section className={`${shared.section} ${shared.ink}`}>
        <div className={shared.inner}>
          <div className={`${shared.sectionHead} ${shared.reveal}`}>
            <span className={`${shared.eyebrow} ${shared.eyebrowLight}`}>In the SaaS model</span>
            <h2 className={shared.h2}>More than a one-off questionnaire.</h2>
            <p className={shared.lead}>
              A subscription isn’t just a single form online. Run programmes that repeat, track
              change over time, and grow new capabilities as you need them.
            </p>
          </div>

          <div className={styles.darkGrid}>
            {beyond.map((b) => {
              const Icon = b.icon;
              return (
                <div key={b.title} className={`${styles.darkCard} ${shared.reveal}`}>
                  <div className={styles.darkIcon}>
                    <Icon />
                  </div>
                  <h3 className={styles.darkTitle}>{b.title}</h3>
                  <p className={styles.darkBody}>{b.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------- Custom implementations ---------------- */}
      <section id="custom" className={`${shared.section} ${shared.cream2}`}>
        <div className={shared.inner}>
          <div className={`${shared.sectionHead} ${shared.reveal}`}>
            <span className={shared.eyebrow}>Custom implementations</span>
            <h2 className={shared.h2}>The core is the start. The build is yours.</h2>
            <p className={shared.lead}>
              <Wordmark /> turns questions into understanding. A bespoke implementation takes that
              understanding and builds an entire product around it: your methodology, your outputs,
              your brand. These are some of the directions teams take it.
            </p>
          </div>

          <div className={shared.featGrid}>
            {possibilities.map((p) => {
              const Icon = p.icon;
              return (
                <div key={p.title} className={`${shared.featCard} ${shared.reveal}`}>
                  <div className={shared.featIcon}>
                    <Icon />
                  </div>
                  <h3 className={shared.featTitle}>{p.title}</h3>
                  <p className={shared.featBody}>{p.body}</p>
                </div>
              );
            })}
          </div>

          <p className={`${shared.pullquote} ${shared.reveal}`}>
            “If you can describe it, we can build it on the core.”
          </p>
        </div>
      </section>

      {/* ---------------- How custom works ---------------- */}
      <section className={`${shared.section} ${shared.ink}`}>
        <div className={shared.inner}>
          <div className={`${shared.sectionHead} ${shared.reveal}`}>
            <span className={`${shared.eyebrow} ${shared.eyebrowLight}`}>How a build works</span>
            <h2 className={shared.h2}>From your questionnaire to a product of your own.</h2>
            <p className={shared.lead}>
              A guided engagement, not a black box. You see it take shape on your own content at
              every step.
            </p>
          </div>

          <div className={shared.steps}>
            {buildSteps.map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={s.title} className={`${shared.step} ${shared.reveal}`}>
                  <div className={shared.stepNum}>{i + 1}</div>
                  <div className={shared.stepTitle}>
                    <Icon /> {s.title}
                  </div>
                  <p className={shared.stepBody}>{s.body}</p>
                </div>
              );
            })}
          </div>

          <div
            className={`${shared.ctaRow} ${shared.reveal}`}
            style={{ justifyContent: 'center', marginTop: 'clamp(44px, 5vw, 60px)' }}
          >
            <Link href="/contact" className={`${shared.btn} ${shared.btnPrimary}`}>
              Request a demo <ArrowRight />
            </Link>
            <Link href="/#how" className={`${shared.btn} ${shared.btnGhost}`}>
              See how it works
            </Link>
          </div>
        </div>
      </section>

      {/* ---------------- FAQ ---------------- */}
      <section className={shared.section}>
        <div className={shared.inner}>
          <div
            className={`${shared.sectionHead} ${shared.reveal}`}
            style={{ textAlign: 'center', marginInline: 'auto' }}
          >
            <span className={shared.eyebrow} style={{ justifyContent: 'center' }}>
              Pricing questions
            </span>
            <h2 className={shared.h2}>The things people ask before they buy.</h2>
          </div>

          <div className={shared.faqWrap}>
            {faqs.map((item) => (
              <details key={item.q} className={shared.faq}>
                <summary>
                  {item.q}
                  <span className={shared.faqIcon} aria-hidden="true" />
                </summary>
                <p className={shared.faqBody}>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- Final CTA ---------------- */}
      <section className={`${shared.section} ${shared.finalCta}`}>
        <div className={shared.finalInner}>
          <h2 className={shared.finalTitle}>
            Find the fit.
            <br />
            Then <em>build past it.</em>
          </h2>
          <p className={shared.finalSub}>
            Tell us what you’re trying to build, or join the waitlist for the self-serve platform.
            Either way, <Wordmark /> grows with you.
          </p>
          <div className={shared.ctaRow}>
            <Link href="/contact" className={`${shared.btn} ${shared.btnPrimary}`}>
              Request a demo <ArrowRight />
            </Link>
            <Link href="/waitlist?from=pricing" className={`${shared.btn} ${shared.btnGhost}`}>
              Join the waitlist
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
