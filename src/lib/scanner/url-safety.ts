/**
 * SSRF defence for the scanner.
 *
 * The scanner runs on a trusted Next.js server and fetches arbitrary,
 * user-supplied website URLs. Without safeguards, that makes the server a
 * proxy an attacker can point at internal infrastructure: cloud metadata
 * endpoints, private subnets, loopback services, and so on. Every URL that
 * reaches `fetch()` must first pass through `assertSafeUrl` (or its two
 * halves, for callers that need to split sync/async work).
 *
 * ## DNS rebinding
 *
 * This module's optional `resolveAndAssertSafeHost` helper is useful before a
 * row is written, but a preflight lookup alone is never enough for a network
 * fetch: a hostile DNS answer could change between that lookup and a later
 * socket connection. `fetch.ts` closes that gap for actual scanner requests
 * with an undici Agent whose `connect.lookup` validates the addresses returned
 * to the very connection that will use them. Redirects are manual and each
 * hop gets the same connection-time check.
 */

import { lookup as dnsLookup } from "dns/promises";

export type UrlRejectionReason =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "missing_hostname"
  | "blocked_hostname"
  | "blocked_ip"
  | "dns_failure"
  | "port_not_allowed";

export interface UrlSafetyResult {
  ok: boolean;
  reason?: UrlRejectionReason;
  /** User-safe message. Never includes internal details. */
  message?: string;
  /** Present when ok. */
  url?: URL;
  /** Present when ok and DNS resolution ran. */
  addresses?: string[];
}

interface ResolveDeps {
  lookup?: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: number }>>;
}

const TRACKING_PARAM_EXACT = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "_ga",
]);

function isTrackingParam(key: string): boolean {
  return key.startsWith("utm_") || TRACKING_PARAM_EXACT.has(key);
}

const SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

/**
 * Parses and canonicalizes a user-supplied URL string. Returns null when the
 * input cannot be parsed as a URL. Does not perform any safety checks —
 * callers must run the result through `assertSafeUrlSyntax` /
 * `assertSafeUrl` before using it for anything network-facing.
 */
export function normalizeUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hasScheme = SCHEME_PREFIX_RE.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  // Lowercase the hostname defensively. The WHATWG URL parser already does
  // this for special schemes (http/https included), but we don't want to
  // depend on that for correctness.
  if (url.hostname) {
    url.hostname = url.hostname.toLowerCase();
  }

  // Strip a trailing dot from the hostname (e.g. "example.com." ->
  // "example.com"), but leave bracketed IPv6 literals alone.
  if (
    url.hostname &&
    !url.hostname.startsWith("[") &&
    url.hostname.endsWith(".")
  ) {
    url.hostname = url.hostname.replace(/\.+$/, "");
  }

  // Drop the fragment; it never leaves the client and is never meaningful
  // for a server-side fetch.
  url.hash = "";

  // Collapse duplicate slashes and drop a trailing slash from non-root
  // paths, so that "/a//b/" and "/a/b" compare equal.
  let pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = pathname;

  // Sort query params for a stable representation and drop known tracking
  // params so cosmetically-different URLs compare and cache equal.
  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    if (isTrackingParam(key)) continue;
    kept.push([key, value]);
  }
  kept.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    if (aValue !== bValue) return aValue < bValue ? -1 : 1;
    return 0;
  });
  const newParams = new URLSearchParams();
  for (const [key, value] of kept) newParams.append(key, value);
  const newSearch = newParams.toString();
  url.search = newSearch ? `?${newSearch}` : "";

  return url;
}

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

const BLOCKED_HOSTNAME_EXACT = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "169.254.169.254",
]);

/**
 * Checks a hostname (not an IP) against the deny-list of local/internal/
 * cloud-metadata names. Does not perform DNS resolution or IP parsing.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTNAME_EXACT.has(host)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some(
    (suffix) => host.endsWith(suffix),
  );
}

// --- IPv4 helpers -----------------------------------------------------

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    // Reject leading zeros (e.g. "010") to avoid octal-style ambiguity,
    // except for "0" itself.
    if (part.length > 1 && part.startsWith("0")) return null;
    octets.push(n);
  }
  return octets;
}

function isBlockedIPv4(octets: number[]): boolean {
  const [a, b] = octets;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 (CGNAT)
  if (a === 127) return true; // 127/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254/16 (link-local)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0/24
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2/24 (TEST-NET-1)
  if (a === 192 && b === 88 && octets[2] === 99) return true; // 192.88.99/24 (6to4 relay)
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100/24 (TEST-NET-2)
  if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113/24 (TEST-NET-3)
  if (a >= 224 && a <= 239) return true; // 224/4 (multicast)
  if (a >= 240) return true; // 240/4 (reserved) incl. 255.255.255.255

  return false;
}

// --- IPv6 helpers -------------------------------------------------------

/**
 * Expands an IPv6 address string (no brackets, no zone id) into 8 16-bit
 * groups, or null if it cannot be parsed. Handles "::" compression and a
 * trailing IPv4-mapped/compatible dotted-quad tail.
 */
function parseIPv6Groups(input: string): number[] | null {
  let address = input;

  // Handle a trailing embedded IPv4 literal (e.g. "::ffff:1.2.3.4").
  const lastColon = address.lastIndexOf(":");
  if (lastColon !== -1 && address.includes(".")) {
    const tail = address.slice(lastColon + 1);
    const ipv4 = parseIPv4(tail);
    if (!ipv4) return null;
    const hi = (ipv4[0] << 8) | ipv4[1];
    const lo = (ipv4[2] << 8) | ipv4[3];
    address =
      address.slice(0, lastColon + 1) +
      hi.toString(16) +
      ":" +
      lo.toString(16);
  }

  if (address === "") return null;

  const doubleColonCount = (address.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let headPart = address;
  let tailPart = "";
  let hasDoubleColon = false;

  if (address.includes("::")) {
    hasDoubleColon = true;
    const idx = address.indexOf("::");
    headPart = address.slice(0, idx);
    tailPart = address.slice(idx + 2);
  }

  const headGroups = headPart === "" ? [] : headPart.split(":");
  const tailGroups = tailPart === "" ? [] : tailPart.split(":");

  if (!hasDoubleColon && headGroups.length !== 8) return null;
  if (hasDoubleColon && headGroups.length + tailGroups.length >= 8) return null;

  const allGroupStrings = [...headGroups, ...tailGroups];
  for (const g of allGroupStrings) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  }

  const missing = 8 - headGroups.length - tailGroups.length;
  const middleGroups = hasDoubleColon ? new Array(missing).fill(0) : [];

  const groups = [
    ...headGroups.map((g) => parseInt(g, 16)),
    ...middleGroups,
    ...tailGroups.map((g) => parseInt(g, 16)),
  ];

  if (groups.length !== 8) return null;
  return groups;
}

function isBlockedIPv6(groups: number[]): boolean {
  const allZero = groups.every((g) => g === 0);
  if (allZero) return true; // ::

  const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (isLoopback) return true; // ::1

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): unwrap and
  // re-check against the IPv4 rules.
  const isV4Mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff;
  const isV4Compatible =
    groups.slice(0, 5).every((g) => g === 0) &&
    groups[5] === 0 &&
    !allZero &&
    !isLoopback;

  if (isV4Mapped || isV4Compatible) {
    const hi = groups[6];
    const lo = groups[7];
    const octets = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
    return isBlockedIPv4(octets);
  }

  // fc00::/7 (Unique Local Address)
  if ((groups[0] & 0xfe00) === 0xfc00) return true;

  // fe80::/10 (link-local)
  if ((groups[0] & 0xffc0) === 0xfe80) return true;

  // ff00::/8 (multicast)
  if ((groups[0] & 0xff00) === 0xff00) return true;

  // 2001:db8::/32 (documentation)
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;

  // 100::/64 (discard-only)
  if (
    groups[0] === 0x0100 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0
  ) {
    return true;
  }

  return false;
}

/**
 * Checks a literal IP address string (IPv4 or IPv6, no brackets) against
 * the deny-list of private/reserved/special-purpose ranges. Anything that
 * fails to parse as an IP is treated as blocked (fail closed).
 */
export function isBlockedIp(ip: string): boolean {
  const trimmed = ip.trim();

  const v4 = parseIPv4(trimmed);
  if (v4) return isBlockedIPv4(v4);

  if (trimmed.includes(":")) {
    const groups = parseIPv6Groups(trimmed);
    if (groups) return isBlockedIPv6(groups);
    return true; // unparseable IPv6-looking string
  }

  // Doesn't look like a valid IPv4 or IPv6 literal at all.
  return true;
}

function stripBrackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function looksLikeIpLiteral(hostname: string): boolean {
  const bare = stripBrackets(hostname);
  return parseIPv4(bare) !== null || bare.includes(":");
}

const ALLOWED_PORTS_SPECIAL = new Set([80, 443]);

/**
 * Well-known non-HTTP service ports, blocked even though they are above 1024.
 *
 * The IP deny-list is the real SSRF defence; this is cheap defence in depth for
 * the case where an attacker controls a *public* address that happens to also
 * front an internal-style service. None of these speak HTTP, so nothing
 * legitimate is lost by refusing them.
 */
const BLOCKED_SERVICE_PORTS = new Set([
  1433, // MSSQL
  1521, // Oracle
  2049, // NFS
  2375, 2376, // Docker daemon
  3306, // MySQL
  3389, // RDP
  4444, // common reverse-shell default
  5432, // PostgreSQL
  5900, 5901, // VNC
  6379, // Redis
  7000, 7001, // Cassandra
  8086, // InfluxDB
  9042, // Cassandra native
  9092, // Kafka
  9200, 9300, // Elasticsearch
  11211, // memcached
  15672, // RabbitMQ management
  27017, 27018, 27019, // MongoDB
  50070, // HDFS
]);

export function isPortAllowed(portString: string): boolean {
  if (portString === "") {
    // No explicit port: default port for the scheme, always allowed.
    return true;
  }
  const port = Number(portString);
  if (!Number.isInteger(port)) return false;
  if (ALLOWED_PORTS_SPECIAL.has(port)) return true;
  if (BLOCKED_SERVICE_PORTS.has(port)) return false;
  // Everything below 1024 other than 80/443 is a privileged service port.
  if (port >= 1024 && port <= 65535) return true;
  return false;
}

/**
 * Synchronous, DNS-free safety checks on a URL string: parseable, an
 * allowed scheme, no embedded credentials, a present and non-blocked
 * hostname (checked directly against the IP deny-list if it's an IP
 * literal), and an allowed port. Does not touch the network.
 */
export function assertSafeUrlSyntax(input: string): UrlSafetyResult {
  const url = normalizeUrl(input);
  if (!url) {
    return {
      ok: false,
      reason: "invalid_url",
      message: "That doesn't look like a valid URL.",
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: "unsupported_scheme",
      message: "Only http and https URLs are supported.",
    };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason: "credentials_in_url",
      message: "URLs with embedded credentials are not allowed.",
    };
  }

  if (!url.hostname) {
    return {
      ok: false,
      reason: "missing_hostname",
      message: "That URL doesn't have a valid host.",
    };
  }

  if (looksLikeIpLiteral(url.hostname)) {
    const bareIp = stripBrackets(url.hostname);
    if (isBlockedIp(bareIp)) {
      return {
        ok: false,
        reason: "blocked_ip",
        message: "That address is not allowed.",
      };
    }
  } else if (isBlockedHostname(url.hostname)) {
    return {
      ok: false,
      reason: "blocked_hostname",
      message: "That host is not allowed.",
    };
  }

  if (!isPortAllowed(url.port)) {
    return {
      ok: false,
      reason: "port_not_allowed",
      message: "That port is not allowed.",
    };
  }

  return { ok: true, url };
}

/**
 * Resolves a hostname (or validates it directly, if it's already an IP
 * literal) and rejects if any resolved address is unsafe. See the module
 * doc comment for the DNS-rebinding caveat this does not fully close.
 */
export async function resolveAndAssertSafeHost(
  hostname: string,
  deps?: ResolveDeps,
): Promise<UrlSafetyResult> {
  if (looksLikeIpLiteral(hostname)) {
    const bareIp = stripBrackets(hostname);
    if (isBlockedIp(bareIp)) {
      return {
        ok: false,
        reason: "blocked_ip",
        message: "That address is not allowed.",
      };
    }
    return { ok: true, addresses: [bareIp] };
  }

  const lookup = deps?.lookup ?? ((h: string) => dnsLookup(h, { all: true }));

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname);
  } catch {
    return {
      ok: false,
      reason: "dns_failure",
      message: "That host could not be resolved.",
    };
  }

  if (!records || records.length === 0) {
    return {
      ok: false,
      reason: "dns_failure",
      message: "That host could not be resolved.",
    };
  }

  const addresses = records.map((r) => r.address);
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      return {
        ok: false,
        reason: "blocked_ip",
        message: "That host resolves to an address that is not allowed.",
      };
    }
  }

  return { ok: true, addresses };
}

/**
 * Full safety check for a user-supplied URL string: syntax checks followed
 * by DNS resolution (or direct IP validation) of its hostname. This is the
 * entry point callers should use before fetching a URL.
 */
export async function assertSafeUrl(
  input: string,
  deps?: ResolveDeps,
): Promise<UrlSafetyResult> {
  const syntaxResult = assertSafeUrlSyntax(input);
  if (!syntaxResult.ok || !syntaxResult.url) {
    return syntaxResult;
  }

  const hostResult = await resolveAndAssertSafeHost(
    syntaxResult.url.hostname,
    deps,
  );
  if (!hostResult.ok) {
    return hostResult;
  }

  return {
    ok: true,
    url: syntaxResult.url,
    addresses: hostResult.addresses,
  };
}
