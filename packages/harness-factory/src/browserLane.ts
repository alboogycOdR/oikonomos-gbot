export const OFFICE_BROWSER_IMAGE = "oikonomos-office-browser";

export interface BrowserLaneSteelConfig {
  readonly profileDirectory: string;
  readonly browserBaseUrl: string;
  readonly stealth: false;
  readonly antiDetection: false;
}

export interface BrowserLane {
  readonly image: typeof OFFICE_BROWSER_IMAGE;
  readonly steel: BrowserLaneSteelConfig;
}

/**
 * The browser lane is intentionally a separate configuration from ordinary
 * harness composition.  TASK-204 selects this image and mounts the resulting
 * MCP config only for a role with granted `browser.*` capabilities.
 */
export function createBrowserLane(steel: BrowserLaneSteelConfig): BrowserLane {
  if (!steel.profileDirectory.startsWith("/oikonomos/secrets/browser-profiles/")) {
    throw new Error("browser lane requires a bot-private D3 profile directory");
  }
  if (steel.stealth || steel.antiDetection) {
    throw new Error("browser lane forbids stealth and anti-detection features");
  }
  return Object.freeze({
    image: OFFICE_BROWSER_IMAGE,
    steel: Object.freeze({ ...steel }),
  });
}
