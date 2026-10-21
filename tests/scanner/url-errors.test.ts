import { describe, expect, it } from "vitest";

import { urlRejectionError } from "@/lib/scanner/url-errors";

/**
 * Turning a URL rejection into something a portfolio owner can act on.
 *
 * Previously every non-syntax rejection became BLOCKED_TARGET — so a typo in a
 * domain was reported as if the address were hostile, and a designer testing
 * `localhost` was told only "That host is not allowed."
 */

describe("urlRejectionError", () => {
  it("reports an unresolvable domain as not found, not blocked", () => {
    const error = urlRejectionError("dns_failure");
    expect(error.code).toBe("HOST_NOT_FOUND");
    expect(error.message).toMatch(/couldn't find that website/i);
    expect(error.message).toMatch(/typos/i);
  });

  it("explains why local and private addresses cannot be scanned", () => {
    for (const reason of ["blocked_hostname", "blocked_ip"] as const) {
      const error = urlRejectionError(reason);
      expect(error.code).toBe("BLOCKED_TARGET");
      expect(error.message).toMatch(/public websites/i);
      // Tells them what to do instead.
      expect(error.message).toMatch(/published site|preview link/i);
    }
  });

  it("treats malformed input as fixable", () => {
    for (const reason of ["invalid_url", "missing_hostname", "unsupported_scheme", "credentials_in_url"] as const) {
      expect(urlRejectionError(reason).code, reason).toBe("INVALID_URL");
    }
    expect(urlRejectionError("credentials_in_url").message).toMatch(/username and password/i);
  });

  it("never echoes internal or security wording to the user", () => {
    const reasons = [
      "invalid_url", "unsupported_scheme", "credentials_in_url", "missing_hostname",
      "blocked_hostname", "blocked_ip", "dns_failure", "port_not_allowed",
    ] as const;
    for (const reason of reasons) {
      const { message } = urlRejectionError(reason);
      expect(message, reason).not.toMatch(/ssrf|rfc1918|link-local|reserved range/i);
      expect(message.length, reason).toBeGreaterThan(20);
    }
  });

  it("falls back to the blocked explanation for an unknown reason", () => {
    expect(urlRejectionError(undefined).code).toBe("BLOCKED_TARGET");
  });
});
