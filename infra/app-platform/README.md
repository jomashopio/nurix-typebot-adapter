# DigitalOcean App Platform deployment

This is the canonical hosted topology for the Nurix Typebot adapter:

- `gateway` is the only public component. It terminates HTTPS, exposes only the
  supported routes, overwrites `X-Adapter-Gateway-Secret`, and forwards requests.
- `adapter` is a one-instance internal service that owns persistent Nurix WebSocket
  sessions and process-local idempotency records.

Both components must remain in the same DigitalOcean app and must deploy the same
reviewed repository commit. Do not autoscale or deploy during a live conversation
test.

## Render the template

Copy `app.template.yaml` to the ignored `app.yaml`, then replace only:

- `__SOURCE_BRANCH__` with the reviewed branch (`main` after the adapter PR merges).
- `__GATEWAY_SHARED_SECRET__` with a 43–128 character base64url secret.
- `__NURIX_WIDGET_ORIGIN__` with the exact origin allowlisted by Nurix.

The App Platform source is branch-based. Record the resolved commit reported for
both components before each E2E run; `deploy_on_push: false` does not make a branch
immutable.

Never print, upload, or commit the rendered specification. Nurix Data and Gateway
API keys do not belong in App Platform; Typebot stores them as encrypted credentials
and supplies them per request.

Validate and review cost before creating or updating a billable app:

```sh
doctl apps spec validate infra/app-platform/app.yaml
doctl apps propose --spec infra/app-platform/app.yaml
```

The included Caddy gateway is a minimal staging ingress. It disables access logging
and enforces routes, body size, and private-header injection, but it does not provide
distributed rate limiting. Put an authenticated rate limiter or WAF in front before
describing the deployment as production-ready.

After deployment, confirm `/health/live` and `/health/ready` return `200`, unknown
routes return `404`, wrong methods return `405`, and DigitalOcean exposes no public
route for the `adapter` component.
