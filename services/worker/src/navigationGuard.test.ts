import { describe, expect, it } from "vitest";

import { guardNavigationTarget, type NavigationDenialCategory } from "./navigationGuard.js";

describe("guardNavigationTarget (TASK-325)", () => {
  it.each<[string, NavigationDenialCategory]>([
    ["http://169.254.169.254/latest/meta-data", "metadata"],
    ["http://169.254.170.2/v2/metadata", "metadata"],
    ["http://100.100.100.200/latest/meta-data", "metadata"],
    ["http://metadata.google.internal/computeMetadata/v1", "metadata"],
    ["http://[fd00:ec2::254]/", "metadata"],
    ["http://127.0.0.1/", "loopback"],
    ["http://[::1]/", "loopback"],
    ["http://10.1.2.3/", "private_network"],
    ["http://172.16.0.1/", "private_network"],
    ["http://192.168.1.1/", "private_network"],
    ["http://[fc00::1]/", "private_network"],
    ["http://169.254.1.1/", "link_local"],
    ["http://[fe80::1]/", "link_local"],
    ["http://[::ffff:127.0.0.1]/", "loopback"],
    ["http://[::ffff:10.0.0.1]/", "private_network"],
    ["http://2130706433/", "loopback"],
    ["http://0177.0.0.1/", "loopback"],
    ["http://0x7f.0x0.0x0.0x1/", "loopback"],
    ["https://user:password@example.com/", "credentials"],
    ["file:///etc/passwd", "non_http_scheme"],
    ["not a url", "malformed_url"],
  ])("refuses %s as %s", (url, category) => {
    expect(guardNavigationTarget(url)).toEqual({ decision: "deny", category });
  });

  it("allows an ordinary public HTTPS URL", () => {
    expect(guardNavigationTarget("https://example.com/path?q=public")).toMatchObject({ decision: "allow" });
  });
});
