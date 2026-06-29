import * as React from 'react';
import { Html, Head, Preview, Body, Container, Section, Text, Hr } from '@react-email/components';

interface WaitlistNotificationEmailProps {
  name: string;
  email: string;
  useCase?: string;
  source?: string;
  submittedAt: Date;
}

/**
 * Admin notification for a new ConQuest waitlist sign-up. Plain, robust inline
 * styles (same approach as the contact notification) so it renders reliably in
 * any mail client.
 */
export default function WaitlistNotificationEmail({
  name,
  email,
  useCase,
  source,
  submittedAt,
}: WaitlistNotificationEmailProps): React.ReactElement {
  const formattedDate = submittedAt.toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Html lang="en">
      <Head />
      <Preview>New ConQuest waitlist sign-up from {name}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>New waitlist sign-up</Text>
            <Text style={text}>Someone just joined the ConQuest waitlist.</Text>

            <Hr style={divider} />

            <Text style={label}>Name</Text>
            <Text style={value}>
              {name} ({email})
            </Text>

            {useCase ? (
              <>
                <Text style={label}>What they’d use ConQuest for</Text>
                <Text style={messageStyle}>{useCase}</Text>
              </>
            ) : null}

            <Text style={label}>Source</Text>
            <Text style={value}>{source || 'waitlist page'}</Text>

            <Hr style={divider} />

            <Text style={footerSmall}>Joined on {formattedDate}</Text>
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

const label: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: '600',
  color: '#666666',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  marginBottom: '4px',
  marginTop: '16px',
};

const value: React.CSSProperties = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#1a1a1a',
  marginTop: '0',
  marginBottom: '0',
};

const messageStyle: React.CSSProperties = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#1a1a1a',
  marginTop: '0',
  marginBottom: '0',
  whiteSpace: 'pre-wrap',
  backgroundColor: '#f9fafb',
  padding: '16px',
  borderRadius: '6px',
};

const footerSmall: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: '#999999',
  marginTop: '16px',
};
