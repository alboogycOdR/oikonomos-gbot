# TASK-241 — Workspace-1 — dashboard Google sign-in via Firebase web SDK against POST /auth/google (shared web/mobile identity)

**Unit:** S5 · **Priority:** medium · **Depends_On:** TASK-239

## Brief
The server side exists (`POST /auth/google` verifies a Firebase ID token and mints a UID-tenant session, `app.ts:947-961`, TASK-172); the dashboard has zero Firebase code and logs in with the shared `CONTROL_API_TOKEN`, landing in the `basileia` service tenant — so web and Android see different data. Add the Firebase web SDK (pin exact version), a `lib/firebase.ts` initialised from `VITE_FIREBASE_*` env (public web config only — no server secrets), a "Sign in with Google" button on `LoginPage` that obtains the ID token and calls a new `loginWithGoogle(idToken)` in `api.ts`. Keep the token login available behind an "operator" toggle. `AuthContext` from TASK-239 already bootstraps from `/auth/me`. This task alone may touch `pnpm-lock.yaml` and `apps/dashboard/package.json` in this wave. Acceptance case A20 becomes runnable when this merges.

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §3.3; TASK-172 and TASK-173 Progress_Notes; docs/runbooks/firebase-android-setup.md

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
The server side exists (`POST /auth/google` verifies a Firebase ID token and mints a UID-tenant session, `app.ts:947-961`, TASK-172); the dashboard has zero Firebase code and logs in with the shared `CONTROL_API_TOKEN`, landing in the `basileia` service tenant — so web and Android see different data. Add the Firebase web SDK (pin exact version), a `lib/firebase.ts` initialised from `VITE_FIREBASE_*` env (public web config only — no server secrets), a "Sign in with Google" button on `LoginPage` that obtains the ID token and calls a new `loginWithGoogle(idToken)` in `api.ts`. Keep the token login available behind an "operator" toggle. `AuthContext` from TASK-239 already bootstraps from `/auth/me`. This task alone may touch `pnpm-lock.yaml` and `apps/dashboard/package.json` in this wave. Acceptance case A20 becomes runnable when this merges.

## Owned_Paths
apps/dashboard/src/lib/AuthContext.tsx, apps/dashboard/src/pages/LoginPage.tsx, apps/dashboard/src/pages/LoginPage.test.tsx, apps/dashboard/src/lib/firebase.ts, apps/dashboard/src/lib/firebase.test.ts, apps/dashboard/src/lib/api.ts, apps/dashboard/package.json, pnpm-lock.yaml, apps/dashboard/.env.example

## Work Log
