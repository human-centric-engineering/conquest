/**
 * App-owned (ConQuest F3.2) invitation email — a respondent is invited to complete
 * a questionnaire. Distinct from the platform's onboarding `invitation.tsx`: the
 * copy is about completing a questionnaire, not joining the product.
 *
 * F3.4 (DEMO-ONLY) themes this per demo client — CTA colour, logo, welcome copy
 * from a resolved theme. F3.2 ships the plain, Sunrise-default version; the props
 * surface is the seam those theme values slot into.
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
  Hr,
  Heading,
} from '@react-email/components';

export interface QuestionnaireInvitationEmailProps {
  /** Recipient display name, when known. */
  inviteeName?: string | null;
  /** Title of the questionnaire they're invited to complete. */
  questionnaireTitle: string;
  /** Tokenised acceptance URL (opaque token; email derived server-side). */
  invitationUrl: string;
  /** When the invitation link stops working. */
  expiresAt: Date;
}

export default function QuestionnaireInvitationEmail({
  inviteeName,
  questionnaireTitle,
  invitationUrl,
  expiresAt,
}: QuestionnaireInvitationEmailProps): React.ReactElement {
  const previewText = `You've been invited to complete ${questionnaireTitle}`;
  const greetingName = inviteeName?.trim() ? inviteeName.trim() : 'there';

  const expirationTime = new Date(expiresAt).toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return (
    <Html lang="en">
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>You&apos;re invited</Heading>

          <Text style={text}>Hi {greetingName},</Text>

          <Text style={text}>
            You&apos;ve been invited to complete <strong>{questionnaireTitle}</strong>. It&apos;s a
            short conversation — answer in your own words and we&apos;ll take care of the rest.
          </Text>

          <Section style={buttonContainer}>
            <Button href={invitationUrl} style={button}>
              Start the questionnaire
            </Button>
          </Section>

          <Text style={text}>This invitation link expires on {expirationTime}.</Text>

          <Hr style={hr} />

          <Text style={footer}>
            If you weren&apos;t expecting this invitation, you can safely ignore this email.
          </Text>

          <Text style={footer}>
            If the button doesn&apos;t work, copy and paste this link into your browser:
            <br />
            <a href={invitationUrl} style={link}>
              {invitationUrl}
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
