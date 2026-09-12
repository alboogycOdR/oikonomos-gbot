/**
 * TASK-241 (spec §3.3) — dashboard-side Firebase Web SDK wiring. This is
 * the counterpart to the Android app's Firebase config (TASK-173,
 * `docs/runbooks/firebase-android-setup.md`), against the same project
 * (`basileia-oikonomos-gmail`) and the same server-side verification
 * (`POST /auth/google`, `app.ts:967-978`, TASK-172) — sharing one Firebase
 * UID means one tenant, so the dashboard and the Android app see the same
 * data for the same signed-in Google account.
 *
 * Config is read entirely from `VITE_FIREBASE_*` env at build time — no
 * value is hardcoded here. Every field Firebase's web SDK needs to
 * initialize (`apiKey`, `authDomain`, `projectId`, `appId`) is a *public*
 * client identifier, not a secret: Firebase's own docs are explicit that
 * these only tell the SDK which project to talk to, and do not by
 * themselves authorize anything — real trust is established server-side,
 * in `verifyFirebaseIdToken` (TASK-172), which independently checks the ID
 * token's signature against Google's real public keys. No server secret
 * (service-account key, admin SDK credential) is read or referenced here,
 * or anywhere in this file.
 *
 * The env var *names* are declared ambient-locally to this module rather
 * than added to `vite-env.d.ts` (outside this task's `Owned_Paths`) —
 * mirrors `api.ts`'s own `__OIKONOMOS_BUILD_SHA__` convention.
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import { GoogleAuthProvider, getAuth, signInWithPopup, type Auth } from "firebase/auth";

interface FirebaseWebEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}

interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** Thrown when the build's environment is missing one or more of the
 * required `VITE_FIREBASE_*` variables — a real, distinguishable failure
 * mode (misconfigured deployment) rather than a generic crash, so callers
 * (LoginPage) can show a specific, actionable message instead of a
 * fabricated success or a silent no-op. */
export class FirebaseConfigError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `Firebase web config incomplete: set ${missing.join(", ")} (see apps/dashboard/.env.example).`,
    );
    this.name = "FirebaseConfigError";
  }
}

function readConfig(): FirebaseWebConfig {
  const env = import.meta.env as unknown as FirebaseWebEnv;
  const missing: string[] = [];
  if (!env.VITE_FIREBASE_API_KEY) missing.push("VITE_FIREBASE_API_KEY");
  if (!env.VITE_FIREBASE_AUTH_DOMAIN) missing.push("VITE_FIREBASE_AUTH_DOMAIN");
  if (!env.VITE_FIREBASE_PROJECT_ID) missing.push("VITE_FIREBASE_PROJECT_ID");
  if (!env.VITE_FIREBASE_APP_ID) missing.push("VITE_FIREBASE_APP_ID");
  if (missing.length > 0) {
    throw new FirebaseConfigError(missing);
  }
  return {
    apiKey: env.VITE_FIREBASE_API_KEY as string,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string,
    projectId: env.VITE_FIREBASE_PROJECT_ID as string,
    appId: env.VITE_FIREBASE_APP_ID as string,
  };
}

let cachedApp: FirebaseApp | undefined;
let cachedAuth: Auth | undefined;

function getFirebaseApp(): FirebaseApp {
  if (cachedApp === undefined) {
    cachedApp = initializeApp(readConfig());
  }
  return cachedApp;
}

/** Lazily-initialised singleton `Auth` instance, matching this module's
 * lazy `FirebaseApp` — nothing touches `import.meta.env` or calls
 * `initializeApp` until the first real sign-in attempt, so a build/test
 * environment with no Firebase env set never fails just from importing
 * this module. */
export function getFirebaseAuth(): Auth {
  if (cachedAuth === undefined) {
    cachedAuth = getAuth(getFirebaseApp());
  }
  return cachedAuth;
}

/**
 * Opens the real Google account picker via a popup and resolves the
 * signed-in account's Firebase ID token. Rejects on cancellation, popup
 * blocking, or any other real Firebase Auth failure — callers are
 * responsible for surfacing that as a real, specific error (never a
 * silent failure or a fabricated success), matching TASK-173's Flutter
 * `FirebaseGoogleAuthPort` convention on the mobile side.
 */
export async function signInWithGooglePopup(): Promise<string> {
  const provider = new GoogleAuthProvider();
  const credential = await signInWithPopup(getFirebaseAuth(), provider);
  return credential.user.getIdToken();
}
