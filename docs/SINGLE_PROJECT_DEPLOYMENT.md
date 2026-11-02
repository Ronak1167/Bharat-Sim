# Single-project Vercel deployment

BharatSim's customer-facing Vercel project is the only project that should serve the product.

## Deployment shape

- Vercel project root: repository root.
- Framework: FastAPI.
- Entrypoint: `backend.app.main:app`.
- Frontend: Vite build from `frontend/`, served at `/` by FastAPI's `app.frontend()` integration and promoted to Vercel's CDN.
- API, auth, health and docs: the same FastAPI app and origin; no cross-project rewrite is required.
- Python dependencies: root `requirements.txt`, which includes `backend/requirements.txt`.
- Build: `python build_frontend.py`, which runs `npm ci` and `npm run build`.

## Cutover sequence

1. Merge and pass CI for the unified app.
2. Change only the existing frontend project's root directory to the repository root, framework to FastAPI, and build command to `python build_frontend.py`.
3. Copy the backend's required server-only environment variables into the frontend Vercel project's Production and Preview environments. Never copy secrets into Vite-prefixed variables.
4. Deploy a production candidate and verify SPA deep links, assets, health, auth, personas, planning, analysis, protected database endpoints, upload-signing and OpenAPI.
5. Keep the old backend project untouched until the candidate has passed the complete acceptance test and the old API is no longer receiving traffic.
6. Only then detach/delete the old backend Vercel project.

## Important runtime limits

This consolidates the HTTP application, not the stateful infrastructure:

- PostgreSQL and private Supabase Storage remain external services and still need server-side credentials.
- The Android emulator worker must remain on a dedicated isolated host/microVM. A Vercel request function cannot safely run a persistent ADB worker or be treated as the untrusted-APK sandbox.
- Direct signed TUS uploads remain the correct path for large APK files; do not proxy 150 MiB APK bodies through a Vercel Function.
- Public APK execution must remain disabled until the per-job isolation and egress acceptance gates pass.

## Rollback

If the unified deployment fails, restore the frontend project's prior root directory `frontend` and prior Vite framework setting. The previous backend project and its deployment remain available as a rollback target until cutover is accepted.

## Current cutover state — 2 November 2026

- PR #120 is merged as `fb1504d9e8954a2f3b5d467a2ace81ad03417a5c`.
- The existing frontend Vercel project has been changed to repository-root / FastAPI / Python 3.12 / `python build_frontend.py`.
- The same project's Production and Preview environments now require Supabase JWT authentication and use production fail-closed mode. The three public APK execution/isolation flags are explicitly false.
- Unified build smoke tests, backend, frontend, Playwright, PostgreSQL integration and container/Compose CI passed; dependency audit passed.
- Vercel rejected the production deployment because the team exceeded the free-plan API deployment limit (more than 100 deployments; retry-after 24 hours). The current public URL is still serving its previous ready deployment until the new unified build is published.
- The old backend project remains online as a rollback target. Do not delete it before the new deployment passes live endpoint, auth, database, upload and browser acceptance checks.
- The frontend project still lacks `BHARATSIM_DATABASE_URL` and a server-only `SUPABASE_SECRET_KEY`. The database-backed and private-storage features cannot pass readiness until these are supplied.
