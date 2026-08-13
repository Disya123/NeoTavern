---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0005-remote-session-auth.md
---

# ADR-0005: Sessions for remote access

## Context

The spec requires loopback by default, explicit enablement of LAN/remote mode,
authentication, Origin checking and CSRF. The access token cannot be stored in
`localStorage`/`sessionStorage`, and a remote browser/PWA client must work
without a cloud identity provider.

## Decision

- Non-loopback bind is forbidden without `NEOTA_REMOTE_ACCESS=true`.
- Remote mode requires a bootstrap token of at least 32 characters and a
  trusted `NEOTA_PUBLIC_ORIGIN`; a production origin MUST use HTTPS.
- The bootstrap token is hashed with SHA-256 at config load; the plaintext is
  removed from the runtime config and never logged.
- The browser sends the token only to `POST /api/v2/auth/session`. The server
  issues a random opaque session ID in an `HttpOnly; Secure; SameSite=Strict`
  host-only cookie and returns a separate CSRF token in JSON.
- Sessions are stored in memory only: max 128, TTL 12 hours, logout and
  restart invalidate them. Login failures are limited to five attempts per
  15 minutes per IP; the failure cache is limited to 256 buckets.
- The browser keeps the CSRF token in memory only and sends it in
  `X-CSRF-Token`. State-changing cookie-auth requests require an exact match
  of `Origin`, CSRF and session.
- Explicit API/CLI clients may pass the bootstrap token via
  `Authorization: Bearer`; CORS does not allow arbitrary origins.
- `health`, `version` and the auth-session bootstrap remain public. The rest
  of `/api/v2` and `/api/plugins` is protected in remote mode.

## Alternatives

- JWT in Web Storage: rejected due to XSS exposure and the impossibility of
  proper logout/revocation.
- Basic Auth on every browser request: rejected, since the credential is
  re-sent and the browser manages the lifecycle poorly.
- Mandatory external OAuth/OIDC: rejected as a cloud and operational
  dependency for a local product.
- Third-party cookie/session plugin: not required; the narrow contract is
  implemented with Node.js `crypto` and Fastify hooks without a new
  supply-chain dependency.

## Consequences

- HTTPS termination is the responsibility of the local reverse proxy/home
  server; direct insecure HTTP is allowed only via a separate test flag with
  an explicit risk.
- After a server restart, the remote browser enters the bootstrap token again.
- The bootstrap token remains a long-lived administrative secret and must be
  conveyed to the owner outside the application.
- The decision follows the recommendations of
  [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
  and
  [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
