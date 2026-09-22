import { isIP } from "node:net";

export type NavigationDenialCategory =
  | "malformed_url"
  | "non_http_scheme"
  | "credentials"
  | "metadata"
  | "loopback"
  | "link_local"
  | "private_network";

export type NavigationGuardDecision =
  | { readonly decision: "allow"; readonly url: string }
  | { readonly decision: "deny"; readonly category: NavigationDenialCategory };

const METADATA_HOSTS = new Set(["metadata.google.internal"]);
const METADATA_IPV4 = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200"]);
const METADATA_IPV6 = new Set(["fd00:ec2::254"]);

function ipv4Category(address: string): NavigationDenialCategory | undefined {
  if (METADATA_IPV4.has(address)) return "metadata";
  const octets = address.split(".").map(Number);
  if (octets[0] === 127) return "loopback";
  if (octets[0] === 169 && octets[1] === 254) return "link_local";
  if (octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168)) {
    return "private_network";
  }
  return undefined;
}

function expandedIpv6(address: string): readonly number[] | undefined {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  if (left.length + right.length > 8) return undefined;
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return undefined;
  return words.map((word) => Number.parseInt(word, 16));
}

function ipv6Category(address: string): NavigationDenialCategory | undefined {
  if (METADATA_IPV6.has(address)) return "metadata";
  const words = expandedIpv6(address);
  if (words === undefined) return "malformed_url";
  if (words.every((word, index) => index === 7 ? word === 1 : word === 0)) return "loopback";
  if ((words[0]! & 0xffc0) === 0xfe80) return "link_local";
  if ((words[0]! & 0xfe00) === 0xfc00) return "private_network";

  // IPv4-compatible and IPv4-mapped IPv6 forms must not bypass IPv4 policy.
  const compatible = words.slice(0, 6).every((word) => word === 0);
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (compatible || mapped) {
    const embedded = `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`;
    return ipv4Category(embedded);
  }
  return undefined;
}

/**
 * Validates a model-supplied navigation target before it reaches CDP.
 * The decision deliberately contains only a category: callers must not put
 * the original URL (which can carry credentials or query secrets) in logs or
 * audit payloads.
 */
export function guardNavigationTarget(rawUrl: string): NavigationGuardDecision {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { decision: "deny", category: "malformed_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { decision: "deny", category: "non_http_scheme" };
  if (parsed.username !== "" || parsed.password !== "") return { decision: "deny", category: "credentials" };

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA_HOSTS.has(host)) return { decision: "deny", category: "metadata" };
  const family = isIP(host);
  const category = family === 4 ? ipv4Category(host) : family === 6 ? ipv6Category(host) : undefined;
  // Preserve the caller's harmless spelling (notably a trailing slash) for
  // Steel's response. `parsed.hostname` above is still the canonical host
  // used for the security decision.
  return category === undefined ? { decision: "allow", url: rawUrl } : { decision: "deny", category };
}
