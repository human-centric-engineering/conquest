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
} from '@react-email/components';
import { BRAND } from '@/lib/brand';

interface ChangeEmailApprovalProps {
  userName: string;
  /** The address this email is sent to — the one currently on the account. */
  currentEmail: string;
  /** The address the account would move to if this is approved. */
  newEmail: string;
  approvalUrl: string;
  expiresAt: Date;
}

/**
 * Sent to the CURRENT (old) address when someone asks to move the account to a
 * new one. Nothing changes until this link is clicked.
 *
 * This is the control that makes a stolen session insufficient for account
 * takeover: whoever holds the session can request the change, but only someone
 * who can read the original inbox can complete it. That is why the copy leads
 * with the "didn't do this?" path rather than burying it — for the recipient
 * who did not initiate this, the email is a compromise alert, not a receipt.
 */
export default function ChangeEmailApproval({
  userName,
  currentEmail,
  newEmail,
  approvalUrl,
  expiresAt,
}: ChangeEmailApprovalProps): React.ReactElement {
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
      <Preview>Approve the email change on your {BRAND.name} account</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>Approve Your Email Change</Text>
            <Text style={text}>Hi {userName},</Text>
            <Text style={text}>
              Someone asked to change the email address on your {BRAND.name} account from{' '}
              <strong>{currentEmail}</strong> to <strong>{newEmail}</strong>.
            </Text>
            <Text style={text}>
              Your address has not changed yet. Click the button below to approve it. We will then
              send a verification email to {newEmail} to finish the change.
            </Text>
            <Button href={approvalUrl} style={button}>
              Approve Email Change
            </Button>
            <Text style={expiryNotice}>This approval link will expire on {expirationTime}</Text>
            <Section style={warningSection}>
              <Text style={warningHeading}>If you didn&apos;t request this</Text>
              <Text style={warningText}>
                Do not click the button. Someone else may have access to your account.
              </Text>
              <Text style={warningText}>
                Sign in and change your password now. That signs out every other device. If you
                cannot sign in, contact support.
              </Text>
            </Section>
            <Text style={footerSmall}>
              If the button doesn&apos;t work, copy and paste this link into your browser:
            </Text>
            <Text style={link}>{approvalUrl}</Text>
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
  fontSize: '28px',
  fontWeight: 'bold',
  color: '#1a1a1a',
  marginBottom: '24px',
  marginTop: '0',
};

const text: React.CSSProperties = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#333333',
  marginBottom: '16px',
};

const button: React.CSSProperties = {
  backgroundColor: '#000000',
  borderRadius: '6px',
  color: '#ffffff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'block',
  padding: '12px 24px',
  marginTop: '24px',
  marginBottom: '24px',
};

const expiryNotice: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '20px',
  color: '#666666',
  backgroundColor: '#fef3cd',
  padding: '12px 16px',
  borderRadius: '6px',
  marginTop: '16px',
  marginBottom: '24px',
  border: '1px solid #ffc107',
};

// Red rather than the neutral grey used by the other templates' "security note"
// blocks: for a recipient who did not initiate this, this section is the alert.
const warningSection: React.CSSProperties = {
  backgroundColor: '#fdf2f2',
  borderRadius: '6px',
  padding: '20px',
  marginTop: '24px',
  marginBottom: '24px',
  border: '1px solid #f5c2c7',
};

const warningHeading: React.CSSProperties = {
  fontSize: '16px',
  fontWeight: '600',
  color: '#842029',
  marginTop: '0',
  marginBottom: '12px',
};

const warningText: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '20px',
  color: '#842029',
  marginBottom: '12px',
};

const footerSmall: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: '#999999',
  marginTop: '16px',
  marginBottom: '8px',
};

const link: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: '#0066cc',
  wordBreak: 'break-all' as const,
  marginTop: '4px',
};
