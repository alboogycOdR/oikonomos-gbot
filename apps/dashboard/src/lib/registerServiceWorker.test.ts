import { afterEach, describe, expect, it, vi } from "vitest";

import { registerServiceWorker } from "./registerServiceWorker";

describe("registerServiceWorker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers /sw.js on window load when the browser supports service workers", () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const addEventListener = vi.spyOn(window, "addEventListener");

    registerServiceWorker({ serviceWorker: { register } as unknown as ServiceWorkerContainer });

    expect(addEventListener).toHaveBeenCalledWith("load", expect.any(Function));
    const loadHandler = addEventListener.mock.calls.find(([event]) => event === "load")?.[1] as () => void;
    loadHandler();

    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("does nothing when the browser has no serviceWorker support", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");

    registerServiceWorker({} as Navigator);

    expect(addEventListener).not.toHaveBeenCalledWith("load", expect.any(Function));
  });
});
