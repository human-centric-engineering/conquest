import type { Metadata } from 'next';

const metaDescription =
  'The terms and conditions for using ConQuest — eligibility, accounts, acceptable use, your content, and our liability.';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: metaDescription,
  openGraph: {
    title: 'Terms of Service - ConQuest',
    description: metaDescription,
  },
  twitter: {
    card: 'summary',
    title: 'Terms of Service - ConQuest',
    description: metaDescription,
  },
};

// ---------------------------------------------------------------------------
// Company details — FILL THESE IN before publishing, and have a solicitor
// review the full terms. These are the only facts this page can't derive
// from the codebase. (Set NEXT_PUBLIC_APP_NAME to control the brand name.)
// ---------------------------------------------------------------------------
const COMPANY = {
  legalName: 'All Too Human Ltd', // e.g. "Human Centric Engineering Ltd"
  registeredAddress: '15 Hawkins Grove, Church Crookham, Fleet, GU51 5TX',
  companyNumber: '15336127', // remove the line below if not a registered company
  legalEmail: 'legal@humancentricengineering.com', // confirm this mailbox exists
} as const;

const LAST_UPDATED = '29 June 2026';

/**
 * Terms of Service Page
 *
 * England & Wales terms for ConQuest, written for the pre-launch state
 * (waitlist + early questionnaire access, no paid billing yet). No payment
 * clauses — add them when billing goes live.
 *
 * Not legal advice — review with a solicitor before relying on it.
 */
export default function TermsOfServicePage() {
  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-8 text-4xl font-bold tracking-tight">Terms of Service</h1>

        <div className="prose prose-neutral dark:prose-invert max-w-none">
          <p className="text-muted-foreground lead">Last updated: {LAST_UPDATED}</p>

          <section className="mt-8">
            <h2>Agreement to these terms</h2>
            <p>
              These Terms of Service (&ldquo;Terms&rdquo;) are a legal agreement between you and{' '}
              {COMPANY.legalName}, a company registered in England &amp; Wales (company number{' '}
              {COMPANY.companyNumber}) with its registered office at {COMPANY.registeredAddress}{' '}
              (&ldquo;ConQuest&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo; or &ldquo;our&rdquo;). By
              joining our waitlist, creating an account, or otherwise using ConQuest (the
              &ldquo;Service&rdquo;), you agree to these Terms. If you do not agree, please do not
              use the Service.
            </p>
            <p>
              How we handle your personal data is explained in our{' '}
              <a href="/privacy" className="text-primary hover:underline">
                Privacy Policy
              </a>
              .
            </p>
          </section>

          <section className="mt-8">
            <h2>About the Service</h2>
            <p>
              ConQuest is a conversational questionnaire platform: it lets an organisation turn a
              questionnaire into a streaming conversation, and lets respondents complete it by
              talking with an AI-driven agent rather than filling in a form.
            </p>
            <p>
              The Service is in an early (pre-launch / beta) phase. It is provided on an evolving
              basis, features may change, be added or removed, and availability is not guaranteed.
              We may invite waitlist members to access the Service over time; joining the waitlist
              does not entitle you to access.
            </p>
          </section>

          <section className="mt-8">
            <h2>Eligibility and accounts</h2>
            <ul>
              <li>
                You must be at least 18 years old and able to enter into a binding contract to use
                the Service.
              </li>
              <li>
                If accounts are made available to you, you must provide accurate information, keep
                your login credentials confidential, and not share your account.
              </li>
              <li>
                You are responsible for activity that takes place under your account, and must tell
                us promptly if you suspect any unauthorised use.
              </li>
            </ul>
          </section>

          <section className="mt-8">
            <h2>Acceptable use</h2>
            <p>You agree not to:</p>
            <ul>
              <li>break the law, or infringe the rights of others, when using the Service;</li>
              <li>
                upload or collect content you have no right to use, or that is unlawful, harmful,
                defamatory, or infringing;
              </li>
              <li>
                attempt to gain unauthorised access to the Service, other accounts, or our systems,
                or interfere with their security or operation;
              </li>
              <li>
                introduce malware, scrape, overload, or place excessive automated demands on the
                Service;
              </li>
              <li>
                reverse engineer, copy, or resell the Service except to the extent the law does not
                allow this to be restricted; or
              </li>
              <li>
                use the Service to build or train a competing product, or to send spam or
                unsolicited communications.
              </li>
            </ul>
          </section>

          <section className="mt-8">
            <h2>Your content and questionnaire data</h2>
            <p>
              You keep ownership of the questionnaires, documents, configuration and responses you
              or your respondents provide (&ldquo;Your Content&rdquo;). You grant us a
              non-exclusive, worldwide licence to host, process and transmit Your Content for the
              purpose of operating and providing the Service to you — which includes sending
              relevant content to the AI providers that power the conversational experience.
            </p>
            <p>
              If you use ConQuest to collect responses from your own respondents, you are
              responsible for having a lawful basis to collect that information, for telling
              respondents how their data will be used, and for the content of the questions you ask.
              You must not use the Service to collect data in breach of data protection law or any
              other person&rsquo;s rights.
            </p>
          </section>

          <section className="mt-8">
            <h2>AI-generated output</h2>
            <p>
              The Service uses third-party AI / large language models to generate conversational
              responses. AI output can be inaccurate, incomplete or unexpected, and does not
              constitute professional, legal, medical, financial or other advice. You are
              responsible for reviewing and deciding how to rely on any output. We make no warranty
              that AI-generated content will be accurate or fit for a particular purpose.
            </p>
          </section>

          <section className="mt-8">
            <h2>Intellectual property</h2>
            <p>
              The Service, including its software, design, branding and content (excluding Your
              Content), is owned by us or our licensors and is protected by intellectual property
              laws. We grant you a limited, non-exclusive, non-transferable right to use the Service
              in accordance with these Terms. Third-party and open-source components within the
              Service are licensed under their own licence terms. The name &ldquo;ConQuest&rdquo;
              and our logos are our trade marks and may not be used without our permission.
            </p>
          </section>

          <section className="mt-8">
            <h2>Service availability and changes</h2>
            <p>
              We aim to keep the Service available but, particularly during this early phase, we do
              not guarantee that it will be uninterrupted, error-free or secure. We may modify,
              suspend or discontinue all or part of the Service, including during maintenance, and
              will try to give reasonable notice of material changes where we can.
            </p>
          </section>

          <section className="mt-8">
            <h2>Disclaimers</h2>
            <p>
              The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the
              fullest extent permitted by law, we exclude all implied warranties, conditions and
              terms. Nothing in these Terms affects your statutory rights as a consumer that cannot
              be excluded under the law of England &amp; Wales.
            </p>
          </section>

          <section className="mt-8">
            <h2>Limitation of liability</h2>
            <p>
              Nothing in these Terms limits or excludes our liability for death or personal injury
              caused by our negligence, for fraud or fraudulent misrepresentation, or for any other
              liability that cannot be limited or excluded by law.
            </p>
            <p>
              Subject to the above, we are not liable for loss of profits, loss of business, loss of
              goodwill, loss of data, or any indirect or consequential loss, and our total liability
              to you arising out of or in connection with the Service is limited to the greater of
              (a) the amount you have paid us for the Service in the 12 months before the claim, or
              (b) £100. Because the Service is currently provided free of charge during its
              pre-launch phase, the amount under (a) may be nil.
            </p>
          </section>

          <section className="mt-8">
            <h2>Indemnity</h2>
            <p>
              You agree to indemnify us against reasonable losses and costs arising from your breach
              of these Terms, your misuse of the Service, or your collection or use of respondent
              data in breach of applicable law.
            </p>
          </section>

          <section className="mt-8">
            <h2>Suspension and termination</h2>
            <p>
              You may stop using the Service and delete your account at any time. We may suspend or
              terminate your access if you breach these Terms, if we reasonably believe your use
              poses a risk to the Service or others, or if we discontinue the Service. On
              termination, the rights granted to you end, and we will handle your data as described
              in our{' '}
              <a href="/privacy" className="text-primary hover:underline">
                Privacy Policy
              </a>
              . Terms which by their nature should survive termination will continue to apply.
            </p>
          </section>

          <section className="mt-8">
            <h2>Changes to these terms</h2>
            <p>
              We may update these Terms from time to time. When we do, we will revise the
              &ldquo;Last updated&rdquo; date above and, where the changes are significant, take
              reasonable steps to notify you. Your continued use of the Service after changes take
              effect means you accept the updated Terms.
            </p>
          </section>

          <section className="mt-8">
            <h2>Governing law</h2>
            <p>
              These Terms, and any dispute arising out of or in connection with them or the Service,
              are governed by the law of England &amp; Wales, and are subject to the exclusive
              jurisdiction of the courts of England &amp; Wales. If you are a consumer, you may also
              benefit from any mandatory protections of the law of the country in which you live.
            </p>
          </section>

          <section className="mt-8">
            <h2>Contact us</h2>
            <p>
              If you have any questions about these Terms, contact us at{' '}
              <a href={`mailto:${COMPANY.legalEmail}`} className="text-primary hover:underline">
                {COMPANY.legalEmail}
              </a>
              , or write to us at {COMPANY.legalName}, {COMPANY.registeredAddress}.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
