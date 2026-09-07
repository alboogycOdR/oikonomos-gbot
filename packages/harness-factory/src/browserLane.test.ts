import { describe, expect, it } from "vitest";

import { createBrowserLane, OFFICE_BROWSER_IMAGE } from "./browserLane.js";

describe("browser lane", () => {
  const steel = {
    profileDirectory: "/oikonomos/secrets/browser-profiles/role-1",
    browserBaseUrl: "http://127.0.0.1:3000",
    stealth: false as const,
    antiDetection: false as const,
  };

  it("selects the browser image only with a sealed bot-private profile", () => {
    expect(createBrowserLane(steel)).toMatchObject({ image: OFFICE_BROWSER_IMAGE, steel });
  });

  it("rejects profiles outside D3 and any stealth setting", () => {
    expect(() => createBrowserLane({ ...steel, profileDirectory: "/workspace/profile" })).toThrow("D3");
    expect(() => createBrowserLane({ ...steel, stealth: true } as never)).toThrow("forbids");
  });
});
