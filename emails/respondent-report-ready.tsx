/**
 * App-owned (ConQuest) report-ready email — the respondent asked to be emailed when their
 * personalised report finished generating. Sent best-effort by the report worker on status→ready
 * (`lib/app/questionnaire/report/worker.ts`). Themed per demo client like the invitation email:
 * the `theme` prop defaults to the all-Sunrise theme so a generic (unattributed) report — and the
 * email-preview tooling — render exactly as the default.
 */

import * as React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Button,
  Img,
  Hr,
  Heading,
} from '@react-email/components';

import { resolveTheme, type ResolvedTheme } from '@/lib/app/questionnaire/theming';

export interface RespondentReportReadyEmailProps {
  /** Title of the questionnaire they completed. */
  questionnaireTitle: string;
  /** Absolute URL back to the completion / report screen. */
  reportUrl: string;
  /** DEMO-ONLY: resolved brand theme. Defaults to the all-Sunrise theme. */
  theme?: ResolvedTheme;
}

export default function RespondentReportReadyEmail({
  questionnaireTitle,
  reportUrl,
  theme = resolveTheme(null),
}: RespondentReportReadyEmailProps): React.ReactElement {
  const previewText = `Your personalised report for ${questionnaireTitle} is ready`;

  const themedButton: React.CSSProperties = { ...button, backgroundColor: theme.ctaColor };
  const themedLink: React.CSSProperties = { ...link, color: theme.accentColor };

  return (
    <Html lang="en">
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          {theme.logoUrl ? (
            <Section
              style={
                theme.logoBackgroundColor
                  ? {
                      ...logoContainer,
                      backgroundColor: theme.logoBackgroundColor,
                      padding: '16px 48px',
                    }
                  : logoContainer
              }
            >
              <Img src={theme.logoUrl} alt={questionnaireTitle} height={40} style={logo} />
            </Section>
          ) : null}

          <Heading style={h1}>Your report is ready</Heading>

          <Text style={text}>
            Thanks for completing <strong>{questionnaireTitle}</strong>. Your personalised report
            has finished generating and is ready to view.
          </Text>

          <Section style={buttonContainer}>
            <Button href={reportUrl} style={themedButton}>
              View your report
            </Button>
          </Section>

          <Hr style={hr} />

          <Text style={footer}>
            You&apos;re receiving this because you asked to be emailed when your report was ready.
          </Text>

          <Text style={footer}>
            If the button doesn&apos;t work, copy and paste this link into your browser:
            <br />
            <a href={reportUrl} style={themedLink}>
              {reportUrl}
            </a>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const main: React.CSSProperties = {
  backgroundColor: '#f6f9fc',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
};

const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  maxWidth: '580px',
};

const logoContainer: React.CSSProperties = {
  padding: '0 48px',
  textAlign: 'center' as const,
  margin: '0 0 16px',
};

const logo: React.CSSProperties = {
  height: '40px',
  margin: '0 auto',
};

const h1: React.CSSProperties = {
  color: '#333',
  fontSize: '28px',
  fontWeight: '700',
  lineHeight: '40px',
  margin: '0 0 24px',
  padding: '0 48px',
  textAlign: 'center' as const,
};

const text: React.CSSProperties = {
  color: '#333',
  fontSize: '16px',
  lineHeight: '26px',
  margin: '16px 0',
  padding: '0 48px',
};

const buttonContainer: React.CSSProperties = {
  padding: '27px 48px',
  textAlign: 'center' as const,
};

const button: React.CSSProperties = {
  backgroundColor: '#5469d4',
  borderRadius: '5px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '14px 32px',
};

const hr: React.CSSProperties = {
  borderColor: '#e6ebf1',
  margin: '32px 0',
};

const footer: React.CSSProperties = {
  color: '#8898aa',
  fontSize: '14px',
  lineHeight: '24px',
  margin: '16px 0',
  padding: '0 48px',
};

const link: React.CSSProperties = {
  color: '#5469d4',
  textDecoration: 'underline',
  wordBreak: 'break-all' as const,
};
