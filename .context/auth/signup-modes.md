# Signup Modes — running a fork invite-only

How to close public signup, and what "closed" actually covers.

**Config:** `SIGNUP_MODE` (`open` | `invite_only`, default `open`)
**Code:** `lib/auth/signup-mode.ts`, `lib/auth/config.ts`, `proxy.ts`

---

## The problem this solves

Sunrise ships a complete invitation system — hashed single-use tokens
(`lib/utils/invitation-token.ts`), an admin invite page, an invitation email,
and `POST /api/auth/accept-invite` — whose entire premise is that access is
_granted_ rather than taken. Beside it, public email/password signup used to be
unconditionally on, with no config to close it.

A fork whose product is invite-gated could only edit a core auth file (a merge
conflict on every upgrade) or leave the front door open. The second is easy not
to notice: the admin invite flow works, invitation emails go out, and the product
_looks_ gated — the open door is silent, and accounts accumulate.

## Turning it on

```bash
# .env.local
SIGNUP_MODE=invite_only
```

`open` is the default and changes nothing. It stays the right default for a
starter template.

## What `invite_only` closes

| Door                                     | Closed in                                     | Behaviour            |
| ---------------------------------------- | --------------------------------------------- | -------------------- |
| `POST /api/auth/sign-up/email`           | `signupModeBeforeHook` (`lib/auth/config.ts`) | `403 FORBIDDEN`      |
| **Any** other un-invited account created | `userCreateBeforeHook` (`lib/auth/config.ts`) | `403 FORBIDDEN`      |
| The `/signup` page                       | `proxy.ts`                                    | Redirect to `/login` |
| The "Sign up" link on `/login`           | `app/(auth)/login/page.tsx`                   | Not rendered         |

**Gating the route is the part that matters.** `POST /api/auth/sign-up/email` is
reachable regardless of what the UI renders, so hiding the page alone is
cosmetic — that is exactly the gap this feature exists to close.

**The second layer is default-deny, and deliberately path-independent.**
Account creation arrives by more paths than the obvious two: a Google signup via
`/callback/:id`, an ID-token sign-in via `POST /sign-in/social`, and whatever a
plugin a fork enables later (magic-link, email-OTP, passkey) uses. Every one of
them ends in a `user` insert, and every insert passes through
`userCreateBeforeHook` — so under `invite_only` that hook refuses anything not
explicitly authorised, rather than testing endpoint paths it would have to keep
in sync forever.

The two authorised paths are `isInvitedSignup()` (accept-invite, holding a
validated token) and an OAuth signup that presented a valid invitation token.

> An earlier version of this gate tested `ctx.path.includes('/callback/')` and
> so missed `/sign-in/social`, which better-auth also creates accounts from.
> If you extend this, do not reintroduce a path allowlist — the failure is
> silent, which is the whole thing `invite_only` exists to prevent.

**Only new accounts are refused.** `userCreateBeforeHook` does not run when an
existing user signs in, so established accounts are unaffected.
`invite_only` closes account _creation_, not sign-in, password reset, or any
other auth endpoint.

## What stays open

- `/login`, `/reset-password`, and every non-signup better-auth endpoint.
- `/accept-invite` and `POST /api/auth/accept-invite` — the invitation flow is
  the whole point.
- The admin invite page (`/admin/users/invite`) and `POST /api/v1/users/invite`.

## The two exemptions

### 1. Invitation acceptance

`accept-invite` creates the invited user by calling `auth.api.signUpEmail()`
server-side. **That is not exempt by virtue of being a server call.** better-auth
routes `auth.api.*` through the same dispatcher as HTTP requests, so it reaches
`hooks.before` with `ctx.path === '/sign-up/email'` — a naive gate would refuse
the one flow invite-only exists to serve.

So the exemption is explicit:

```typescript
import { runInvitedSignup } from '@/lib/auth/signup-mode';

const signupResult = await runInvitedSignup(() => auth.api.signUpEmail({ body }));
```

It is an `AsyncLocalStorage`, **not a header or a body field**. A header can be
set by anyone who can reach the endpoint, which would turn the exemption into a
one-line bypass of the gate. The store is process-internal and only ever set by
server-side code that has already validated an invitation token.

**If you add another server-side account-creation path**, wrap it the same way —
and only after validating whatever authorises it. Keep the callback tight around
the account-creation call; the exemption covers the whole async subtree.

### 2. The first human on an empty database

`invite_only` would otherwise be an unrecoverable lockout on a fresh deployment:
`npm run db:seed` creates only the SERVICE config-owner, which cannot log in, so
there would be no admin to send the first invitation.

So the first human signup on an empty database is admitted, and the existing
first-human-is-admin bootstrap promotes it to ADMIN. Sign up, then invite
everyone else.

The predicate (`isFirstHumanBootstrap()`) is deliberately identical to the role
bootstrap's — the `AuthBootstrap` singleton is absent **and** no human user
exists — so the account it admits is exactly the account that would be promoted
to ADMIN. The gate can never admit a plain USER, and the window closes
permanently once any human exists (it is the marker, not the count, that keeps it
shut — see issue #278). This adds no exposure beyond the bootstrap window that
already exists in `open` mode.

**It fails closed.** The role bootstrap fails _open_ because it is a convenience
— a DB fault there just means the first user is a USER instead of an ADMIN. This
one authorises account creation, so a DB fault refuses the signup instead.

## Anti-patterns

**❌ Hiding the signup UI and calling it gated.** The API route stays reachable.
This is the exact failure the feature exists to prevent — enforce at the route.

**❌ Exempting a signup path with a header or request flag.** Anything the caller
can set, an attacker can set. Use `runInvitedSignup()`.

**❌ Wrapping a whole request handler in `runInvitedSignup()`.** The exemption
covers the entire async subtree, so a broad wrapper exempts more than intended.
Wrap only the account-creation call, after validating the invitation.

**❌ Expecting marketing CTAs to disappear.** Buttons that point at `/signup` in
`app/(public)/**` and `components/marketing/**` are fork-owned copy. Under
`invite_only` they redirect to `/login` rather than 404, but you should edit them
to say what your product actually offers. Same for the unauthenticated
`components/auth/user-button.tsx` menu, which is a client component and cannot
read server config.

## Testing

- `tests/unit/lib/auth/signup-mode.test.ts` — the seam itself, including that the
  `AsyncLocalStorage` exemption survives an await boundary, does not leak after
  resolve/throw, and does not bleed into concurrent unwrapped work.
- `tests/unit/lib/auth/config-signup-mode.test.ts` — both gates' branching.
- `tests/unit/lib/security/proxy.test.ts` — the `/signup` redirect.

Note for test authors: `lib/auth/config.ts` calls `createAuthMiddleware` at
module load, so any test that mocks `better-auth/api` must include it —
`createAuthMiddleware: vi.fn((fn: unknown) => fn)` — or the import throws.

## Related

- [`.context/auth/overview.md`](./overview.md) — better-auth configuration
- [`.context/auth/user-creation.md`](./user-creation.md) — the create hooks and
  the first-admin bootstrap
- [`.context/environment/auth-env.md`](../environment/auth-env.md) — the variable
  reference
