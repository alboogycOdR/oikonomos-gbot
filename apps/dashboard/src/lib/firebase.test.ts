import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInitializeApp = vi.fn();
const mockGetAuth = vi.fn();
const mockSignInWithPopup = vi.fn();
const mockGoogleAuthProvider = vi.fn();

vi.mock("firebase/app", () => ({
  initializeApp: (...args: unknown[]) => mockInitializeApp(...args),
}));

vi.mock("firebase/auth", () => ({
  getAuth: (...args: unknown[]) => mockGetAuth(...args),
  signInWithPopup: (...args: unknown[]) => mockSignInWithPopup(...args),
  GoogleAuthProvider: class {
    constructor(...args: unknown[]) {
      mockGoogleAuthProvider(...args);
    }
  },
}));

// Non-secret placeholder — a real Firebase Web `apiKey` is a public client
// identifier (see firebase.ts's own doc comment), not a credential; this
// value is a deliberately fake, short placeholder for these tests either way.
const FAKE_API_KEY = "fake-key";
const FAKE_AUTH_DOMAIN = "basileia-oikonomos-gmail.firebaseapp.com";
const FAKE_PROJECT_ID = "basileia-oikonomos-gmail";
const FAKE_APP_ID = "1:461377597606:web:abc123";

const ORIGINAL_ENV = { ...import.meta.env };

function setEnv(overrides: Record<string, string | undefined>) {
  const env = import.meta.env as Record<string, string | undefined>;
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) {
      delete env[key];
    } else {
      env[key] = overrides[key];
    }
  }
}

function setFakeConfigEnv() {
  setEnv({
    VITE_FIREBASE_API_KEY: FAKE_API_KEY,
    VITE_FIREBASE_AUTH_DOMAIN: FAKE_AUTH_DOMAIN,
    VITE_FIREBASE_PROJECT_ID: FAKE_PROJECT_ID,
    VITE_FIREBASE_APP_ID: FAKE_APP_ID,
  });
}

describe("lib/firebase", () => {
  beforeEach(() => {
    vi.resetModules();
    mockInitializeApp.mockReset();
    mockGetAuth.mockReset();
    mockSignInWithPopup.mockReset();
    mockGoogleAuthProvider.mockReset();
    setEnv({
      VITE_FIREBASE_API_KEY: undefined,
      VITE_FIREBASE_AUTH_DOMAIN: undefined,
      VITE_FIREBASE_PROJECT_ID: undefined,
      VITE_FIREBASE_APP_ID: undefined,
    });
  });

  afterEach(() => {
    setEnv(ORIGINAL_ENV as Record<string, string | undefined>);
  });

  it("throws FirebaseConfigError naming every missing VITE_FIREBASE_* variable, without calling initializeApp", async () => {
    const { getFirebaseAuth, FirebaseConfigError } = await import("./firebase");

    try {
      getFirebaseAuth();
      throw new Error("expected getFirebaseAuth to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FirebaseConfigError);
      expect((err as Error).message).toContain("VITE_FIREBASE_API_KEY");
      expect((err as Error).message).toContain("VITE_FIREBASE_AUTH_DOMAIN");
      expect((err as Error).message).toContain("VITE_FIREBASE_PROJECT_ID");
      expect((err as Error).message).toContain("VITE_FIREBASE_APP_ID");
    }
    expect(mockInitializeApp).not.toHaveBeenCalled();
  });

  it("initializes the Firebase app from VITE_FIREBASE_* env, containing only public client fields", async () => {
    setFakeConfigEnv();
    mockInitializeApp.mockReturnValue({ name: "fake-app" });
    mockGetAuth.mockReturnValue({ name: "fake-auth" });

    const { getFirebaseAuth } = await import("./firebase");
    const auth = getFirebaseAuth();

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    const [config] = mockInitializeApp.mock.calls[0] as [Record<string, unknown>];
    expect(config).toEqual({
      apiKey: FAKE_API_KEY,
      authDomain: FAKE_AUTH_DOMAIN,
      projectId: FAKE_PROJECT_ID,
      appId: FAKE_APP_ID,
    });
    expect(Object.keys(config).sort()).toEqual(["apiKey", "appId", "authDomain", "projectId"]);
    expect(mockGetAuth).toHaveBeenCalledWith({ name: "fake-app" });
    expect(auth).toEqual({ name: "fake-auth" });
  });

  it("caches the app/auth instance across repeated calls (does not re-initialize)", async () => {
    setFakeConfigEnv();
    mockInitializeApp.mockReturnValue({ name: "fake-app" });
    mockGetAuth.mockReturnValue({ name: "fake-auth" });

    const { getFirebaseAuth } = await import("./firebase");
    getFirebaseAuth();
    getFirebaseAuth();
    getFirebaseAuth();

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    expect(mockGetAuth).toHaveBeenCalledTimes(1);
  });

  it("signInWithGooglePopup resolves the signed-in user's real ID token", async () => {
    setFakeConfigEnv();
    mockInitializeApp.mockReturnValue({ name: "fake-app" });
    mockGetAuth.mockReturnValue({ name: "fake-auth" });
    const getIdToken = vi.fn().mockResolvedValue("real-id-token");
    mockSignInWithPopup.mockResolvedValue({ user: { getIdToken } });

    const { signInWithGooglePopup } = await import("./firebase");
    const idToken = await signInWithGooglePopup();

    expect(idToken).toBe("real-id-token");
    expect(mockGoogleAuthProvider).toHaveBeenCalledTimes(1);
    expect(mockSignInWithPopup).toHaveBeenCalledWith({ name: "fake-auth" }, expect.anything());
  });

  it("signInWithGooglePopup rejects (never fabricates a token) when the popup fails", async () => {
    setFakeConfigEnv();
    mockInitializeApp.mockReturnValue({ name: "fake-app" });
    mockGetAuth.mockReturnValue({ name: "fake-auth" });
    mockSignInWithPopup.mockRejectedValue(new Error("auth/popup-closed-by-user"));

    const { signInWithGooglePopup } = await import("./firebase");

    await expect(signInWithGooglePopup()).rejects.toThrow("auth/popup-closed-by-user");
  });
});
