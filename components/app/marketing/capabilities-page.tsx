import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  Layers,
  PenTool,
  MessagesSquare,
  Route,
  BarChart3,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Info,
} from 'lucide-react';
import { Wordmark } from '@/components/app/marketing/wordmark';
import shared from '@/components/app/marketing/conquest-marketing.module.css';
import styles from '@/components/app/marketing/capabilities.module.css';

/**
 * Capabilities — the public catalogue of what ConQuest does.
 *
 * Structure is an editorial index rather than another card grid: home already
 * owns split panels and pricing owns tier cards, so this page earns its own
 * shape (outlined chapter numerals, a sticky chapter rail, hairline-ruled
 * two-column entries). Palette, type and layout primitives are inherited from
 * the shared marketing module, so light/dark and the film-grain texture come
 * for free.
 *
 * Content rule: every entry below describes behaviour that exists today. Things
 * that are designed but unbuilt (external benchmarking, emailing the report
 * itself, OCR of scanned PDFs, a template library) are deliberately absent —
 * this page is read by prospects and has to stay true.
 *
 * Voice rule: factual, not promotional. Entry names are noun phrases naming the
 * thing the reader configures, because the commercial argument of this page is
 * that ConQuest is a configurable instrument rather than an opaque AI. Bodies
 * state what it does and what you set; the business consequence follows from
 * the fact rather than being announced after it. Concrete counts (eight
 * question types, seven judge agents, nine persona dials) carry more weight
 * than any adjective and belong in the copy.
 *
 * AI-disclosure rule: name it. Where an agent, model or LLM does the work, say
 * so in those words rather than hiding it behind "the platform" — a buyer
 * discovering undisclosed AI later is a worse outcome than one who declined
 * over disclosed AI. Equally, say where a model is deliberately NOT involved
 * (deterministic scoring, the keyword safety net, suppression thresholds, the
 * verbatim support message). The contrast is the credibility: a page that
 * claims AI everywhere is as untrustworthy as one that hides it. Claims here
 * are verified against the implementation, not assumed — the counts of signals,
 * judges and layers below were each read out of the code.
 *
 * Things to keep out: a benefit punchline on every entry (the formula is
 * visible by the fourth one and discounts the rest), "X, not Y" antitheses,
 * invented scenarios about the reader's own organisation, and admin mechanics
 * — progress indicators, panel layouts, which screen a control lives on.
 */

const metaDescription =
  'What ConQuest does: agentic extraction and authoring turn an existing form into a configurable conversational interview, run at scale or live with a room, producing scored, cited reporting you can edit and defend.';

export const metadata: Metadata = {
  title: 'Capabilities',
  description: metaDescription,
  openGraph: {
    title: 'ConQuest Capabilities: from a static form to a defensible report.',
    description: metaDescription,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ConQuest Capabilities: from a static form to a defensible report.',
    description: metaDescription,
  },
};

type Capability = { name: string; body: string };
type Chapter = {
  id: string;
  num: string;
  navLabel: string;
  icon: typeof PenTool;
  eyebrow: string;
  title: string;
  lead: string;
  items: Capability[];
  note?: string;
  dark: boolean;
};

const chapters: Chapter[] = [
  {
    id: 'build',
    num: '01',
    navLabel: 'Build',
    icon: PenTool,
    eyebrow: 'Authoring',
    title: 'Bring the instrument you already use, or draft a new one.',
    lead: 'Two ways in: upload the document your questionnaire lives in today, or describe what you need. Agents do the extraction and the drafting; you keep the editor, and every decision they made is recorded with its source quote, reasoning and confidence, and can be reverted individually.',
    dark: false,
    items: [
      {
        name: 'Agentic document extraction',
        body: 'An extraction agent reads PDF, Word, Markdown, plain text or Excel and returns structure: sections, questions and answer types, with rating grids and matrix tables detected and preserved as tables rather than flattened into prose. A maturity assessment, intake form, staff survey or patient questionnaire arrives intact rather than being rebuilt.',
      },
      {
        name: 'Check and repair pass',
        body: 'A second agent re-reads every extracted question and flags the suspect ones; a third re-reads only those against the source document and proposes corrections. A repair is applied only if it validates, and a rejected one leaves the original untouched, so the pass cannot make the extraction worse than the model left it.',
      },
      {
        name: 'Drafting from a brief',
        body: 'Describe the audience and what you need to learn and an authoring agent plans an outline, then composes each section. Refine it by instruction: shorten it, add a section, change the register. In the default mode the model only interprets your intent — the edits themselves execute as deterministic operations, so fields you did not mention cannot be silently rewritten, and every change previews before it is written.',
      },
      {
        name: 'Agentic review panel',
        body: 'Seven reviewer agents run in parallel, one per dimension: clarity, coverage, duplication, answer-type fit, ordering, fit to audience and fit to goal. Each returns a 0–1 score and specific findings, usually with a proposed edit you apply or ignore. Their rubrics live in version-controlled code rather than in an editable prompt, so a panel run is reproducible and tuning a judge is a reviewed change.',
      },
      {
        name: 'Question types and weighting',
        body: 'Eight types: free text, single and multi choice, Likert, matrix, numeric, date and yes/no. Set required flags, reorder across sections, apply a reusable tag vocabulary, and weight individual questions so the ones that matter take priority when interview time runs short.',
      },
      {
        name: 'Scoring schema',
        body: 'Define named scales, map questions to them with weights and reverse-scoring, choose how scales combine and set band thresholds. Upload an existing scoring document and an agent will propose a draft schema from it for you to edit. Applying the schema is deterministic; no model scores a respondent.',
      },
      {
        name: 'Pre-launch checks',
        body: 'A config advisor agent reads your whole setup and narrates, in plain language, the experience it will actually produce for a respondent, flagging settings that contradict one another. The readiness check that blocks an incomplete questionnaire from going live is ordinary server-side validation, not a model judgement.',
      },
      {
        name: 'Versioning and reuse',
        body: 'Editing a live questionnaire writes to a new draft, so a run in progress never changes underneath a respondent. Definitions export and import between environments, duplicate for the next engagement, and print as a paper questionnaire where a screen is not an option.',
      },
    ],
  },
  {
    id: 'interview',
    num: '02',
    navLabel: 'Interview',
    icon: MessagesSquare,
    eyebrow: 'The conversation',
    title: 'Agentic conversations, under configured control.',
    lead: 'Respondents answer in conversation rather than in fields: questions phrased in context, follow-ups where an answer is thin, choice and scale options held back unless someone is struggling. It reads naturally because of the mix. Agentic semantics interpret what was said and phrase what comes next; deterministic, logic-guided rules decide what may be asked, how a contradiction is handled, how disclosure is met and how much a session may spend.',
    dark: true,
    items: [
      {
        name: 'Question selection strategy',
        body: 'Four strategies, three of them deterministic: document order, weighted by the importance you set, or randomised. The fourth is agentic — the model reads what the respondent actually raised and follows it, leaning into areas where earlier answers were thin, so interview time goes where coverage is weakest.',
      },
      {
        name: 'Cross-question capture',
        body: 'An extraction step reads each reply against every open question and fills all of them it genuinely covers, including near-identical items requiring opposite polarity. Long instruments complete in materially fewer turns, which is usually what separates a submitted response from an abandoned one.',
      },
      {
        name: 'Confidence and provenance',
        body: 'The model grades its own confidence in each captured answer and records how it was obtained: quoted directly, inferred, synthesised, or refined from an earlier answer. Because that grade is the model’s own, low-confidence answers count for nothing towards completion until they are corroborated.',
      },
      {
        name: 'Contradiction handling',
        body: 'The model flags a reply that conflicts with an earlier answer; you choose whether it resolves the conflict in the same turn or confirms before overwriting anything. Its phrasing is graded by certainty, so a weak signal is raised tentatively. Revised answers are refined rather than replaced, and a conflict already raised is never raised twice.',
      },
      {
        name: 'Input modes',
        body: 'Chat, a classic form, or both with a mid-session switch. Respondents can speak instead of typing — audio is transcribed by a speech-to-text model and never stored — and attach images, PDFs and documents that the agent reads as part of the answer. The form view doubles as where a respondent checks and corrects what the model understood.',
      },
      {
        name: 'Interviewer persona',
        body: 'Ten built-in personas, or nine dials including empathy, warmth, curiosity, formality, verbosity and humour. These compile into the instructions the interviewing model runs under, so a redundancy consultation and a B2B pricing study do not sound alike. Respondents can optionally be allowed to switch persona mid-session.',
      },
      {
        name: 'Framing and profile capture',
        body: 'Set an intro screen with your own background copy and video, overridable per cohort. Collect profile fields as a form gate, conversationally within the interview, or a hybrid per field, with validation that is deterministic, AI-assisted, or both in combination.',
      },
      {
        name: 'Access modes',
        body: 'Invitation-only, open to walk-up respondents with no account at all, or both at once. A link on a conference slide and a named research panel can run against the same instrument.',
      },
      {
        name: 'Safeguarding response',
        body: 'Three independent signals run on a turn: two model-based, plus a deterministic keyword net that forces a high assessment regardless of what the model returned, so a failed, slow or over-cautious model call cannot drop a real disclosure. The interviewer then treads carefully for the rest of the session. The support message shown is your authored copy, or a fixed reviewed default, and is never model-generated or paraphrased.',
      },
      {
        name: 'Non-genuine answers',
        body: 'Two layers decide whether a turn is disregarded rather than recorded: a deterministic abuse floor that strikes plainly hostile messages without consulting a model, and an LLM judge for everything subtler. Warnings escalate to a clear final one. A change of mind is explicitly never treated as insincerity.',
      },
      {
        name: 'Session continuity',
        body: 'Sessions resume where they left off with the transcript intact, and carry a short reference a respondent can quote to continue on another device.',
      },
      {
        name: 'Turn-level trace',
        body: 'An optional respondent-safe trace shows what happened in each turn: what the model extracted, what it checked, and what it chose to ask next. It reuses work the turn already did, so it costs nothing extra to leave on.',
      },
    ],
    note: 'The interview runs on an LLM of your choosing. The parts that must not vary are deliberately not model calls: scoring, suppression thresholds, the safeguarding keyword net, the abuse floor, and the wording of the support message itself.',
  },
  {
    id: 'journeys',
    num: '03',
    navLabel: 'Journeys',
    icon: Route,
    eyebrow: 'Experiences and live sessions',
    title: 'Chain assessments into a journey, or run one live with a room.',
    lead: 'An Experience joins several questionnaires behind one address and decides where each respondent goes next, on your rules or on an agent’s reading of what came back. The same machinery runs facilitated sessions where a room answers at once on their own devices.',
    dark: false,
    items: [
      {
        name: 'Single stable address',
        body: 'One link resolves to whichever stage a respondent is on, whether that is stage one today or stage four next month, backed by a credential deliberately kept out of the URL because transcripts can contain sensitive disclosure. No re-invitation between stages.',
      },
      {
        name: 'Routing rules',
        body: 'Route on deterministic conditions against captured data, or hand the decision to an agentic selector that reads the run so far. A first-time applicant, a returning client and a high-risk case take different paths from the same entry point. Every dead end resolves to a conclusion rather than an error.',
      },
      {
        name: 'Context carried forward',
        body: 'Captured data, profile, scores and safeguarding state carry into the next stage, optionally compressed by a model into a briefing. Provisional answers are never carried. Respondents are not asked their circumstances a second time.',
      },
      {
        name: 'Handover style',
        body: 'Present an explicit checkpoint the respondent chooses to accept, or stitch stages into one continuous conversation with a labelled divider at the change of subject.',
      },
      {
        name: 'Facilitated sessions',
        body: 'Participants join from a short code on your slide and answer on their own devices in timed breakouts. Breakouts split into rooms, either one session per participant or scribe mode, where one person holds the pen and the room follows. Suited to board strategy days, staff consultations, patient participation groups and classroom research.',
      },
      {
        name: 'Breakout clock',
        body: 'Three phases: running, grace and closed, where grace means finish the answer in progress rather than begin a new one. The facilitator ends the breakout; the timer never does.',
      },
      {
        name: 'Live synthesis',
        body: 'Between rounds an LLM synthesises themes from de-identified captured data and reasoning, never from raw chat, with participants unnamed and local to their own room. It is asked which participants support each theme, and that support count is then recomputed on the server against material it can be checked against; the model’s own count is discarded.',
      },
      {
        name: 'Run-level budget',
        body: 'Model spend is capped across the whole journey rather than per stage, so a five-stage experience cannot cost five times a single one.',
      },
    ],
    note: 'Beneath the minimum contributor threshold no synthesis runs at all: not suppressed after generation, simply never sent to a model. The facilitator sees a count of what was withheld rather than the statements.',
  },
  {
    id: 'analysis',
    num: '04',
    navLabel: 'Analysis',
    icon: BarChart3,
    eyebrow: 'Reporting',
    title: 'Written by a model, scored by an engine, checked against the record.',
    lead: 'Reports for the individual and across the cohort: narrative generated by an LLM, scores computed deterministically from your schema, citations verified before storage, every revision kept and exportable under your brand.',
    dark: true,
    items: [
      {
        name: 'Respondent reports',
        body: 'Three depths: their answers as given with no model involved, answers plus AI insight, or a single narrative woven by a model. Generated in the background after submission with the respondent notified when ready. Returning something to the person who gave you twenty minutes changes what you can credibly ask of them next time.',
      },
      {
        name: 'Cohort reports',
        body: 'Distributions and response rates are computed, not written. A model then writes the thematic findings and recommendations from that evidence. Charts are proposed only against a catalogue of what the data can actually support, and one definition renders identically on screen and in the PDF; a suppressed or empty series renders as suppressed rather than as zero.',
      },
      {
        name: 'Deterministic scoring',
        body: 'Scores are computed by a pure engine from your schema — per scale, normalised, banded, and rolled up into cohort aggregates under the same suppression floor. No model writes a score, which is what makes the number reproducible and arguable.',
      },
      {
        name: 'Coverage and omission',
        body: 'The writing model is given the questions that went unanswered and explicitly fenced from implying a position on any of them. A report built on partial coverage carries a caveat naming the exact percentage, composed deterministically rather than by the model.',
      },
      {
        name: 'Provenance record',
        body: 'Each report keeps an observed record of its own run: answers read, documents in scope against those that actually contributed, every search query, sources kept, passes applied, and for admins the model, cost and duration. An explainer agent narrates it in plain English and is refused if it states any number the record does not contain. Citations the writer invents are stripped before storage.',
      },
      {
        name: 'Retrieval-augmented generation, scoped per client',
        body: 'Upload a client’s strategy documents, policies and prior reports and they are parsed, chunked and embedded into a knowledge base of their own. The writing model is then grounded by RAG: passages retrieved by vector search are put in front of it as evidence rather than left to recall. Retrieval is scoped to that one knowledge base, so one client’s material cannot ground another’s report.',
      },
      {
        name: 'External research',
        body: 'Optional rounds before writing, after, or both, where a research agent runs real searches in a tool loop and returns deduplicated, cited sources, so findings sit against current market conditions, published guidance or sector benchmarks.',
      },
      {
        name: 'Editing and revisions',
        body: 'A block editor with per-section AI assist, reordering and duplication. Every generation and edit appends a revision; history is never rewritten and any revision can be restored or published. Export any revision as a PDF carrying your logo and accent colour with charts drawn in.',
      },
      {
        name: 'Live analytics',
        body: 'A completion funnel from invited to completed with per-stage drop-off, per-question response rates and confidence, model spend split by design time and respondent runtime, and a safeguarding summary. Visible while fieldwork is still open.',
      },
      {
        name: 'Export',
        body: 'CSV and JSON export of results mirroring the filters on screen, plus downloadable transcripts.',
      },
    ],
  },
  {
    id: 'privacy',
    num: '05',
    navLabel: 'Privacy',
    icon: ShieldCheck,
    eyebrow: 'Privacy and defensibility',
    title: 'Limits that hold in the data, not in the prompt.',
    lead: 'What you can promise a respondent depends on where the protection sits. These apply at the point data is aggregated or loaded, before a model ever sees it, which is what stops them being undone by anything a model writes downstream.',
    dark: false,
    items: [
      {
        name: 'Suppression in the aggregate',
        body: 'Segments below the reporting threshold are suppressed during aggregation rather than hidden at render, so a suppressed figure is never in the material a writing model is given and cannot reappear in its narrative.',
      },
      {
        name: 'Free text excluded from distributions',
        body: 'Free-text questions contribute response rates, confidence and provenance to analytics. The values themselves are never serialised into distributions, where a distinctive phrase could identify its author.',
      },
      {
        name: 'Anonymous mode',
        body: 'Identity is dropped at the point data is loaded, not masked at render. The trade-off is enforced rather than optional: anonymous rounds cannot be segmented by demographics.',
      },
      {
        name: 'AI run records',
        body: 'Runs worth defending are stored with the model that actually ran after any fallback, prompt and output snapshots, tokens, cost, duration, and the prompt and application versions in force at the time. Enough to answer what the AI was given and what it returned, months later.',
      },
      {
        name: 'Reproducible reports',
        body: 'Every report revision carries the exact settings used to produce it, so a deliverable can be regenerated and accounted for long after the engagement closed.',
      },
      {
        name: 'Audit trail',
        body: 'Configuration changes are logged immutably, and each extraction decision an agent made stays individually revertible for the life of the draft.',
      },
      {
        name: 'Retention and erasure',
        body: 'Aged conversations, executions, evaluations and logs are pruned on a schedule you set, with in-flight work exempt regardless of age. Account deletion runs through a single erasure service that cascades across related records and writes a receipt.',
      },
    ],
    note: 'Two floors are deliberately not configurable: the live-session synthesis threshold refuses to drop below two whatever it is set to, and beneath the floor no model call is made at all.',
  },
  {
    id: 'platform',
    num: '06',
    navLabel: 'Platform',
    icon: SlidersHorizontal,
    eyebrow: 'Operating it',
    title: 'Your models, your budget, your brand.',
    lead: 'Every agent on this page runs on a provider you choose, on surfaces you place: hosted, embedded in your own product, white-labelled on your own domain, or driven entirely through the API.',
    dark: true,
    items: [
      {
        name: 'Model providers',
        body: 'Anthropic, any OpenAI-compatible host, or local models, with different jobs on different tiers so heavy reasoning and cheap formatting do not pay the same rate. The embedding model behind retrieval is chosen the same way, including local. Where your respondents’ data may go is usually a decision your policy has already made.',
      },
      {
        name: 'Cost estimation',
        body: 'A pre-launch estimate models likely spend per respondent and scales it to your cohort. Where it has no pricing for a model it says so rather than reporting zero.',
      },
      {
        name: 'Spend limits',
        body: 'Soft and hard caps per session, monthly budgets per agent and ceilings per execution, with spend visible by day, agent and model. A session approaching its cap biases towards concluding, and stops cleanly at it rather than overrunning.',
      },
      {
        name: 'Embedding and white-label',
        body: 'A drop-in chat widget authenticated by per-agent tokens with origin allow-listing, or the whole platform under your own brand on a subdomain of your own.',
      },
      {
        name: 'API and keys',
        body: 'Every capability is reachable over a versioned API with self-service scoped keys, so responses flow into a CRM, case management system or warehouse, and rounds can be launched by your own systems.',
      },
      {
        name: 'Operator consoles',
        body: 'Browse sessions across questionnaires, inspect per-turn diagnostics down to the individual model call, review the prompt library and tune agent settings without a developer or a release. Configuration also exports and imports for promoting or rebuilding an environment.',
      },
    ],
  },
];

export default function CapabilitiesPage() {
  return (
    <div className={shared.page}>
      {/* ---------------- Hero ---------------- */}
      <section className={`${shared.section} ${shared.hero}`}>
        <div className={shared.inner}>
          <div className={styles.heroIntro}>
            <span className={styles.heroKicker}>
              <Layers /> Capabilities
            </span>
            <h1 className={`${shared.heroTitle} ${shared.rise}`}>
              <Wordmark /> turns static forms into <em>engaging conversations.</em>
            </h1>
            <p className={styles.heroLede}>
              Convert any form, survey or questionnaire into a structured conversation. Build
              customised, engaging experiences that collect rich qualitative answers alongside the
              quantitative data you already rely on, with agentic orchestration adapting the path in
              real time so every respondent gets the questions that matter to them. Then turn what
              comes back into custom analysis and reporting: scored, cited and ready to share.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- Sticky chapter rail ---------------- */}
      <nav className={styles.railWrap} aria-label="Capability sections">
        <div className={styles.rail}>
          {chapters.map((c) => {
            const Icon = c.icon;
            return (
              <a key={c.id} href={`#${c.id}`} className={styles.railLink}>
                <Icon />
                <span className={styles.railNum}>{c.num}</span>
                {c.navLabel}
              </a>
            );
          })}
        </div>
      </nav>

      {/* ---------------- Chapters ---------------- */}
      {chapters.map((c) => (
        <section
          key={c.id}
          id={c.id}
          className={[
            shared.section,
            styles.chapter,
            c.dark ? shared.ink : shared.cream2,
            c.dark ? styles.onInk : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <div className={shared.inner}>
            <div className={`${styles.chapterHead} ${shared.reveal}`}>
              <div className={styles.chapterNum} aria-hidden="true">
                {c.num}
              </div>
              <div>
                <span
                  className={`${shared.eyebrow} ${c.dark ? shared.eyebrowLight : ''}`.trimEnd()}
                >
                  {c.eyebrow}
                </span>
                <h2 className={shared.h2}>{c.title}</h2>
                <p className={shared.lead}>{c.lead}</p>
              </div>
            </div>

            <div className={styles.capList}>
              {c.items.map((item) => (
                <div key={item.name} className={`${styles.capItem} ${shared.reveal}`}>
                  <h3 className={styles.capName}>
                    <span className={styles.capTick} aria-hidden="true" />
                    {item.name}
                  </h3>
                  <p className={styles.capBody}>{item.body}</p>
                </div>
              ))}
            </div>

            {c.note ? (
              <div className={`${styles.note} ${shared.reveal}`}>
                <Info />
                <span>{c.note}</span>
              </div>
            ) : null}
          </div>
        </section>
      ))}

      {/* ---------------- Final CTA ---------------- */}
      <section className={`${shared.section} ${shared.finalCta}`}>
        <div className={`${shared.inner} ${shared.finalInner}`}>
          <span className={`${shared.eyebrow} ${shared.eyebrowLight}`}>
            <Sparkles /> See it on your own content
          </span>
          <h2 className={shared.finalTitle}>
            The best way to understand it is <em>to be asked.</em>
          </h2>
          <p className={shared.finalSub}>
            Bring the questionnaire you run today and we will show you what it becomes as a
            conversation, and the calibre of the analysis it returns.
          </p>
          <div className={shared.ctaRow}>
            <Link href="/contact" className={`${shared.btn} ${shared.btnPrimary}`}>
              Request a demo <ArrowRight />
            </Link>
            <Link href="/pricing" className={`${shared.btn} ${shared.btnGhost}`}>
              See pricing
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
