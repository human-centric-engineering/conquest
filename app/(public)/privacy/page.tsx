import type { Metadata } from 'next';

const metaDescription =
  'How ConQuest collects, uses, shares and protects your personal data, and the rights you have under UK data protection law.';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: metaDescription,
  openGraph: {
    title: 'Privacy Policy - ConQuest',
    description: metaDescription,
  },
  twitter: {
    card: 'summary',
    title: 'Privacy Policy - ConQuest',
    description: metaDescription,
  },
};

// ---------------------------------------------------------------------------
// Company details — FILL THESE IN before publishing, and have a solicitor
// review the full policy. These are the only facts this page can't derive
// from the codebase. (Set NEXT_PUBLIC_APP_NAME to control the brand name.)
// ---------------------------------------------------------------------------
const COMPANY = {
  legalName: 'All Too Human Ltd', // e.g. "Human Centric Engineering Ltd"
  registeredAddress: '15 Hawkins Grove, Church Crookham, Fleet, GU51 5TX',
  companyNumber: '15336127', // remove the line below if not a registered company
  privacyEmail: 'privacy@humancentricengineering.com', // confirm this mailbox exists
} as const;

const LAST_UPDATED = '29 June 2026';

/**
 * Privacy Policy Page
 *
 * UK GDPR / PECR-oriented privacy policy for ConQuest, grounded in what the
 * app actually collects (waitlist sign-ups, accounts, questionnaire responses,
 * cookies). Pre-launch state: the public surface is primarily the waitlist.
 *
 * Not legal advice — review with a solicitor before relying on it.
 */
export default function PrivacyPolicyPage() {
  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-8 text-4xl font-bold tracking-tight">Privacy Policy</h1>

        <div className="prose prose-neutral dark:prose-invert max-w-none">
          <p className="text-muted-foreground lead">Last updated: {LAST_UPDATED}</p>

          <section className="mt-8">
            <h2>Who we are</h2>
            <p>
              ConQuest is a conversational questionnaire platform operated by {COMPANY.legalName}{' '}
              (&ldquo;ConQuest&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo; or &ldquo;our&rdquo;), a
              company registered in England &amp; Wales (company number {COMPANY.companyNumber})
              with its registered office at {COMPANY.registeredAddress}.
            </p>
            <p>
              For the purposes of UK data protection law — the UK General Data Protection Regulation
              (&ldquo;UK GDPR&rdquo;) and the Data Protection Act 2018 — we are the &ldquo;data
              controller&rdquo; for the personal data described in this policy, except where we
              process questionnaire responses on behalf of a customer (see{' '}
              <a href="#questionnaire" className="text-primary hover:underline">
                Questionnaire data
              </a>
              ).
            </p>
            <p>
              ConQuest is currently in a pre-launch phase. Our public website primarily offers a
              waitlist, while the questionnaire product is being made available to early users. This
              policy covers all of these activities.
            </p>
          </section>

          <section className="mt-8">
            <h2>The personal data we collect</h2>

            <h3>Waitlist sign-ups</h3>
            <p>
              When you join our waitlist we collect your name, email address, an optional
              description of your intended use case, and a record of which part of the site you
              signed up from. We use this to contact you about access and to understand demand.
            </p>

            <h3>Account information</h3>
            <p>
              If you create an account, we collect your name, email address and an encrypted
              (hashed) password. If you sign in through a third-party provider, we receive basic
              profile information from that provider. We also keep records relating to your account,
              such as authentication sessions and security events.
            </p>

            <h3 id="questionnaire">Questionnaire data</h3>
            <p>
              ConQuest lets organisations turn a questionnaire into a streaming conversation.
              Depending on your role:
            </p>
            <ul>
              <li>
                <strong>As an author/administrator</strong>, we process the questionnaire documents
                and configuration you upload to build and run a questionnaire.
              </li>
              <li>
                <strong>As a respondent</strong>, we process the responses you give during the
                conversation. These responses, and any profile information captured during a
                session, may contain personal — and potentially sensitive — information, depending
                on the questions asked by the organisation running the questionnaire. Where a
                questionnaire is offered in anonymous mode, we limit the identifying information
                associated with your responses.
              </li>
            </ul>
            <p>
              Where an organisation uses ConQuest to collect responses from its own respondents, we
              generally act as a &ldquo;data processor&rdquo; and that organisation is the
              controller responsible for deciding what is asked and why.
            </p>

            <h3>Messages you send us</h3>
            <p>
              If you contact us — for example through our contact form or by email — we process the
              information you choose to provide so we can respond.
            </p>

            <h3>Technical and usage data</h3>
            <p>
              Like most online services, our servers automatically record technical information such
              as a timestamp, the pages requested, a signed visitor identifier (see{' '}
              <a href="#cookies" className="text-primary hover:underline">
                Cookies
              </a>
              ), and diagnostic logs. We use this for security, to keep the service running, and to
              understand usage in aggregate.
            </p>
          </section>

          <section className="mt-8">
            <h2>How we use your data and our lawful bases</h2>
            <p>Under UK GDPR we must have a lawful basis for processing your personal data:</p>
            <ul>
              <li>
                <strong>Consent</strong> — joining the waitlist, sending you marketing
                communications, and setting non-essential cookies. You can withdraw consent at any
                time.
              </li>
              <li>
                <strong>Performance of a contract</strong> — creating and managing your account and
                providing the questionnaire service to you.
              </li>
              <li>
                <strong>Legitimate interests</strong> — securing the service, preventing fraud and
                abuse, maintaining essential cookies, and improving and developing ConQuest, where
                these interests are not overridden by your rights.
              </li>
              <li>
                <strong>Legal obligation</strong> — complying with the law, including responding to
                lawful requests and meeting our accountability duties.
              </li>
            </ul>
          </section>

          <section className="mt-8">
            <h2>Who we share your data with</h2>
            <p>
              We do not sell your personal data. We share it only with the categories of recipient
              needed to run the service:
            </p>
            <ul>
              <li>
                <strong>Cloud hosting and infrastructure providers</strong> who store and serve the
                application and its database.
              </li>
              <li>
                <strong>Email delivery providers</strong> who send transactional and waitlist emails
                on our behalf.
              </li>
              <li>
                <strong>AI / large language model (LLM) providers</strong> who process questionnaire
                conversations to power the conversational experience (see{' '}
                <a href="#ai" className="text-primary hover:underline">
                  AI processing
                </a>
                ).
              </li>
              <li>
                <strong>Analytics or product-measurement providers</strong>, where you have
                consented to non-essential analytics.
              </li>
              <li>
                <strong>Professional advisers, authorities and acquirers</strong> — where required
                by law, to enforce our terms, or in connection with a business sale or
                reorganisation.
              </li>
            </ul>
            <p>
              We require our service providers to process personal data only on our instructions and
              to keep it secure. A current list of the specific providers we use is available on
              request from {contactLink(COMPANY.privacyEmail)}.
            </p>
          </section>

          <section className="mt-8" id="ai">
            <h2>AI processing</h2>
            <p>
              ConQuest&rsquo;s conversational experience is powered by third-party AI / LLM
              providers. To run a questionnaire as a conversation, the relevant questionnaire
              content and your responses are sent to these providers to generate the next part of
              the conversation. Because AI-generated output can be inaccurate or incomplete, it
              should not be relied on as professional advice. We choose providers that commit not to
              use data submitted through their APIs to train their general models, but you should
              not include information in a response that you would not want processed in this way.
            </p>
          </section>

          <section className="mt-8">
            <h2>International transfers</h2>
            <p>
              Some of our service providers may process personal data outside the UK. Where they do,
              we rely on appropriate safeguards recognised under UK data protection law — such as UK
              adequacy regulations or the International Data Transfer Agreement / Addendum to the EU
              Standard Contractual Clauses — so that your data remains protected.
            </p>
          </section>

          <section className="mt-8" id="cookies">
            <h2>Cookies and similar technologies</h2>
            <p>We use two categories of cookie and similar technology:</p>
            <ul>
              <li>
                <strong>Essential</strong> (always active) — needed for the site to work, including
                authentication, security, and remembering your theme preference. This includes a
                signed visitor identifier cookie used for security and aggregated, non-identifying
                analytics in our server logs; it contains no personal data and lasts around 180
                days.
              </li>
              <li>
                <strong>Optional</strong> (consent required) — analytics, marketing, and other
                non-essential cookies, set only if you agree.
              </li>
            </ul>
            <p>
              You can review and change your choices at any time using the{' '}
              <strong>Cookie Preferences</strong> link in the site footer.
            </p>
          </section>

          <section className="mt-8">
            <h2>How long we keep your data</h2>
            <p>
              We keep personal data only for as long as we need it for the purposes set out in this
              policy. Waitlist details are retained until we have triaged your interest or you ask
              us to remove them. Account and questionnaire data is retained for the life of your
              account and deleted (or anonymised) when you delete your account or when an
              organisation closes its questionnaire, subject to any legal retention obligations.
              Diagnostic logs are kept for a limited period and then purged.
            </p>
          </section>

          <section className="mt-8">
            <h2>Your rights</h2>
            <p>Under UK GDPR you have the right to:</p>
            <ul>
              <li>access a copy of the personal data we hold about you;</li>
              <li>have inaccurate data corrected;</li>
              <li>have your data erased in certain circumstances;</li>
              <li>restrict or object to our processing in certain circumstances;</li>
              <li>receive certain data in a portable format;</li>
              <li>withdraw consent where we rely on it; and</li>
              <li>opt out of marketing at any time.</li>
            </ul>
            <p>
              If you have an account, you can delete it — and the personal data associated with it —
              from your account settings. To remove yourself from the waitlist, or to exercise any
              other right, contact us at {contactLink(COMPANY.privacyEmail)}. We will respond within
              the time limits required by law.
            </p>
            <p>
              If you are unhappy with how we have handled your data, you can complain to the
              Information Commissioner&rsquo;s Office (ICO) at{' '}
              <a
                href="https://ico.org.uk"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                ico.org.uk
              </a>
              . We would, however, appreciate the chance to address your concerns first.
            </p>
          </section>

          <section className="mt-8">
            <h2>Children</h2>
            <p>
              ConQuest is not directed to children under 16, and we do not knowingly collect their
              personal data. If you believe a child has provided us with personal data, please
              contact us so we can remove it. Where an organisation uses ConQuest to collect
              responses from children, that organisation is responsible for obtaining any consent
              required.
            </p>
          </section>

          <section className="mt-8">
            <h2>Changes to this policy</h2>
            <p>
              We may update this policy from time to time. When we do, we will revise the
              &ldquo;Last updated&rdquo; date above and, where the changes are significant, take
              reasonable steps to let you know.
            </p>
          </section>

          <section className="mt-8">
            <h2>Contact us</h2>
            <p>
              If you have any questions about this Privacy Policy or how we handle your data,
              contact us at {contactLink(COMPANY.privacyEmail)}, or write to us at{' '}
              {COMPANY.legalName}, {COMPANY.registeredAddress}.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function contactLink(email: string) {
  return (
    <a href={`mailto:${email}`} className="text-primary hover:underline">
      {email}
    </a>
  );
}
