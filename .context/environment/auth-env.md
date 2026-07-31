# Authentication Environment Variables

Configuration for better-auth and OAuth providers.

## Core Authentication

### `BETTER_AUTH_URL`

- **Purpose:** Base URL of the application for better-auth OAuth redirects and session management
- **Required:** ✅ Yes
- **Type:** URL
- **Format:** `http://` or `https://` followed by domain and optional port
- **Used By:**
  - `lib/auth/config.ts` - better-auth server configuration
  - OAuth redirect URI calculation
  - Session cookie domain

**Examples:**

```bash
# Local development
BETTER_AUTH_URL="http://localhost:3000"

# Production
BETTER_AUTH_URL="https://app.example.com"

# Custom port
BETTER_AUTH_URL="http://localhost:3001"
```

**Important Notes:**

- Must match the actual URL where your application is accessible
- Must match `NEXT_PUBLIC_APP_URL` for consistency
- Include port number if not using default (80/443)
- Use `https://` in production
- Used for OAuth redirect URIs: `{BETTER_AUTH_URL}/api/auth/callback/[provider]`

### `BETTER_AUTH_SECRET`

- **Purpose:** Secret key for signing JWT tokens and securing sessions
- **Required:** ✅ Yes
- **Type:** String (minimum 32 characters)
- **Format:** Base64-encoded random string (recommended)
- **Used By:**
  - `lib/auth/config.ts` - JWT signing and verification
  - Session encryption

**Generating a Secret:**

```bash
# Recommended: 32 bytes encoded in base64 (44 characters)
openssl rand -base64 32

# Alternative: 64 bytes for extra security
openssl rand -base64 64
```

**Example:**

```bash
BETTER_AUTH_SECRET="Ag8JfK3mN9pQr2StUv4WxY5zB7cD0eF1Gh2Ij3Kl4M="
```

**Security Notes:**

- ⚠️ **Never commit this to version control**
- ⚠️ **Use different secrets for each environment** (dev, staging, production)
- ⚠️ **Rotate quarterly or after suspected compromise**
- ⚠️ **Minimum 32 characters** (44 characters recommended from base64 encoding)
- ⚠️ **Store securely** in production secret management

## Signup Model

### `SIGNUP_MODE`

- **Purpose:** Whether anyone may create an account, or only invited people
- **Required:** ❌ No
- **Type:** Enum — `open` | `invite_only`
- **Default:** `open`
- **Used By:**
  - `lib/auth/config.ts` — the `hooks.before` signup gate, and the default-deny
    backstop in `userCreateBeforeHook` that covers every other creation path
  - `proxy.ts` — redirects `/signup` to `/login`
  - `app/(auth)/login/page.tsx` — omits the "Sign up" link

**Examples:**

```bash
# Default — anyone may sign up
SIGNUP_MODE="open"

# Invite-gated: closed beta, B2B-provisioned, internal tools
SIGNUP_MODE="invite_only"
```

**Important Notes:**

- `invite_only` closes `POST /api/auth/sign-up/email` **and** every other
  un-invited account creation — OAuth callbacks, ID-token social sign-in, and any
  auth plugin a fork adds later. The second gate is default-deny rather than a
  list of endpoint paths. Gating only the page would be cosmetic — the API route
  is reachable whatever the UI renders.
- Existing users are unaffected; sign-in, password reset and the invitation flow
  all keep working.
- On an empty database the first human may still sign up, and becomes ADMIN —
  otherwise there would be no operator to send invitations (`db:seed` creates
  only the non-login SERVICE account). That window closes permanently once any
  human exists.
- Marketing CTAs pointing at `/signup` are fork-owned copy. Under `invite_only`
  they redirect to `/login` rather than 404, but edit them to match what your
  product offers.

**Full guide:** [`.context/auth/signup-modes.md`](../auth/signup-modes.md)

## OAuth Providers

### `GOOGLE_CLIENT_ID`

- **Purpose:** Google OAuth 2.0 client ID for Google sign-in
- **Required:** ❌ No (Google OAuth disabled if not provided)
- **Type:** String
- **Format:** Google-issued client ID (ends with `.apps.googleusercontent.com`)

**Example:**

```bash
GOOGLE_CLIENT_ID="123456789-abc123def456.apps.googleusercontent.com"
```

**Setup:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable "Google+ API"
4. Create OAuth 2.0 credentials
5. Configure authorized redirect URIs:
   - Local: `http://localhost:3000/api/auth/callback/google`
   - Production: `https://yourdomain.com/api/auth/callback/google`

### `GOOGLE_CLIENT_SECRET`

- **Purpose:** Google OAuth 2.0 client secret for secure token exchange
- **Required:** ❌ No (Google OAuth disabled if not provided)
- **Type:** String
- **Format:** Google-issued client secret

**Example:**

```bash
GOOGLE_CLIENT_SECRET="GOCSPX-abcdefghijklmnopqrstuvwxyz"
```

**Security Notes:**

- ⚠️ **Keep this secret** - never expose in client-side code or version control
- ⚠️ **Server-only** - only used in backend OAuth flow
- ⚠️ **Rotate if compromised** - generate new credentials in Google Cloud Console

**Important:** Both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must be set to enable Google OAuth. If only one is set, Google OAuth will be disabled.

## Environment-Specific Values

| Environment | `BETTER_AUTH_URL`             | `BETTER_AUTH_SECRET`        |
| ----------- | ----------------------------- | --------------------------- |
| Development | `http://localhost:3000`       | Simple (32+ chars)          |
| Staging     | `https://staging.example.com` | Strong, unique              |
| Production  | `https://app.example.com`     | Strong, from secret manager |

## Troubleshooting

**OAuth fails:**

- Ensure `BETTER_AUTH_URL` matches OAuth provider configuration
- Check redirect URIs in Google Cloud Console

**Session issues:**

- Verify `BETTER_AUTH_URL` matches where app is accessed
- Check `BETTER_AUTH_SECRET` hasn't changed between restarts

**CORS errors:**

- Check URL includes correct protocol (http vs https)

**"Must be at least 32 characters" error:**

- Generate a longer secret: `openssl rand -base64 32`

## Related Documentation

- [Environment Overview](./overview.md) - Quick setup guide
- [Environment Reference](./reference.md) - All environment variables
- [OAuth Integration](../auth/oauth.md) - OAuth setup guide
