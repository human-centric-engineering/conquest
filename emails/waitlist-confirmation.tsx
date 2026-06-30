import * as React from 'react';
import { Html, Head, Preview, Body, Container, Section, Text, Hr } from '@react-email/components';

interface WaitlistConfirmationEmailProps {
  name: string;
}

/**
 * "You're on the list" confirmation sent to a ConQuest waitlist sign-up. Light
 * brand touch (two-tone ConQuest wordmark + marigold accent) over robust inline
 * styles so it renders reliably across mail clients.
 */
export default function WaitlistConfirmationEmail({
  name,
}: WaitlistConfirmationEmailProps): React.ReactElement {
  return (
    <Html lang="en">
      <Head />
      <Preview>You’re on the ConQuest waitlist</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={brand}>
              <span style={brandCon}>Con</span>
              <span style={brandQ}>Quest</span>
            </Text>

            <Text style={heading}>You’re on the list.</Text>
            <Text style={text}>Hi {name},</Text>
            <Text style={text}>
              Thanks for joining the ConQuest waitlist. We’re building a small founding cohort while
              the self-serve platform takes shape, and you’re now among the first we’ll contact as
              soon as there’s something to try.
            </Text>
            <Text style={text}>
              We read every sign-up ourselves. If you told us what you’d use ConQuest for, that goes
              straight into how we prioritise — and we may reach out to learn more.
            </Text>

            <Hr style={divider} />

            <Text style={footerSmall}>
              You’re receiving this because you joined the waitlist at our website. If that wasn’t
              you, you can ignore this email and you won’t hear from us again.
            </Text>
            <Text style={signoff}>— Simon &amp; John, Human-Centric Engineering</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// Styles
const main: React.CSSProperties = {
  backgroundColor: '#f6f9fc',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

const container: React.CSSProperties = {
  margin: '0 auto',
  padding: '20px 0 48px',
  maxWidth: '580px',
};

const section: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  padding: '40px',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.05)',
};

const brand: React.CSSProperties = {
  fontSize: '22px',
  fontWeight: 'bold',
  letterSpacing: '-0.01em',
  marginTop: '0',
  marginBottom: '24px',
};

const brandCon: React.CSSProperties = {
  color: '#0a1a3a',
};

const brandQ: React.CSSProperties = {
  color: '#ffb300',
};

const heading: React.CSSProperties = {
  fontSize: '24px',
  fontWeight: 'bold',
  color: '#1a1a1a',
  marginBottom: '16px',
  marginTop: '0',
};

const text: React.CSSProperties = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#333333',
  marginBottom: '16px',
};

const divider: React.CSSProperties = {
  borderColor: '#e6e6e6',
  margin: '24px 0',
};

const footerSmall: React.CSSProperties = {
  fontSize: '13px',
  lineHeight: '20px',
  color: '#999999',
  marginTop: '0',
  marginBottom: '16px',
};

const signoff: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '20px',
  color: '#666666',
  marginTop: '0',
};
