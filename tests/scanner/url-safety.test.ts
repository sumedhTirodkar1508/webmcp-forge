import { describe, expect, it } from "vitest";
import {
  assertSafeUrl,
  assertSafeUrlSyntax,
  isBlockedHostname,
  isBlockedIp,
  normalizeUrl,
  resolveAndAssertSafeHost,
} from "@/lib/scanner/url-safety";

describe("normalizeUrl", () => {
  it("prepends https:// when no scheme is given", () => {
    const url = normalizeUrl("example.com/foo");
    expect(url?.href).toBe("https://example.com/foo");
  });

  it("strips default ports", () => {
    expect(normalizeUrl("http://example.com:80/")?.href).toBe(
      "http://example.com/",
    );
    expect(normalizeUrl("https://example.com:443/")?.href).toBe(
      "https://example.com/",
    );
  });

  it("keeps non-default ports", () => {
    expect(normalizeUrl("https://example.com:8443/")?.port).toBe("8443");
  });

  it("removes known tracking params and sorts the rest", () => {
    const url = normalizeUrl(
      "https://example.com/?b=2&utm_source=news&a=1&fbclid=abc&gclid=x&mc_cid=y&mc_eid=z&ref=home&_ga=g",
    );
    expect(url?.search).toBe("?a=1&b=2");
  });

  it("drops the query string entirely when nothing is left", () => {
    const url = normalizeUrl("https://example.com/?utm_source=news&fbclid=abc");
    expect(url?.search).toBe("");
    expect(url?.href).toBe("https://example.com/");
  });

  it("removes a trailing slash from non-root paths", () => {
    expect(normalizeUrl("https://example.com/foo/")?.pathname).toBe("/foo");
  });

  it("keeps the root path as-is", () => {
    expect(normalizeUrl("https://example.com/")?.pathname).toBe("/");
  });

  it("collapses duplicate slashes in the path", () => {
    expect(normalizeUrl("https://example.com//foo//bar")?.pathname).toBe(
      "/foo/bar",
    );
  });

  it("strips the fragment", () => {
    expect(normalizeUrl("https://example.com/foo#section")?.hash).toBe("");
    expect(normalizeUrl("https://example.com/foo#section")?.href).toBe(
      "https://example.com/foo",
    );
  });

  it("lowercases the hostname", () => {
    expect(normalizeUrl("https://EXAMPLE.com/Foo")?.hostname).toBe(
      "example.com",
    );
    // Path casing is preserved.
    expect(normalizeUrl("https://EXAMPLE.com/Foo")?.pathname).toBe("/Foo");
  });

  it("strips a trailing dot from the hostname", () => {
    expect(normalizeUrl("https://example.com./foo")?.hostname).toBe(
      "example.com",
    );
  });

  it("returns null for unparseable input", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("http://")).toBeNull();
    expect(normalizeUrl("not a url at all :::")).toBeNull();
  });
});

describe("assertSafeUrlSyntax — schemes", () => {
  it("accepts http and https", () => {
    expect(assertSafeUrlSyntax("http://example.com").ok).toBe(true);
    expect(assertSafeUrlSyntax("https://example.com").ok).toBe(true);
  });

  for (const scheme of ["file", "ftp", "javascript", "data", "gopher"]) {
    it(`rejects ${scheme}: URLs`, () => {
      const input =
        scheme === "javascript"
          ? "javascript:alert(1)"
          : scheme === "data"
            ? "data:text/html,hi"
            : `${scheme}://example.com/`;
      const result = assertSafeUrlSyntax(input);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("unsupported_scheme");
      expect(result.message).toBeTruthy();
    });
  }

  it("rejects invalid URLs", () => {
    const result = assertSafeUrlSyntax("");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_url");
  });
});

describe("assertSafeUrlSyntax — credentials", () => {
  it("rejects URLs with a username/password", () => {
    const result = assertSafeUrlSyntax("https://user:pass@example.com/");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("credentials_in_url");
  });

  it("rejects URLs with only a username", () => {
    const result = assertSafeUrlSyntax("https://user@example.com/");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("credentials_in_url");
  });
});

describe("assertSafeUrlSyntax — blocked hostnames", () => {
  const blocked = [
    "localhost",
    "foo.localhost",
    "foo.local",
    "bar.internal",
    "box.home.arpa",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
  ];

  for (const host of blocked) {
    it(`rejects ${host}`, () => {
      const result = assertSafeUrlSyntax(`https://${host}/`);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("blocked_hostname");
    });
  }

  it("accepts an ordinary public hostname", () => {
    const result = assertSafeUrlSyntax("https://example.com/");
    expect(result.ok).toBe(true);
    expect(result.url?.hostname).toBe("example.com");
  });
});

describe("isBlockedHostname", () => {
  it("blocks localhost and its subdomains", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("LOCALHOST")).toBe(true);
    expect(isBlockedHostname("api.localhost")).toBe(true);
  });

  it("blocks .local, .internal, .home.arpa suffixes", () => {
    expect(isBlockedHostname("printer.local")).toBe(true);
    expect(isBlockedHostname("db.internal")).toBe(true);
    expect(isBlockedHostname("router.home.arpa")).toBe(true);
  });

  it("blocks cloud metadata hostnames", () => {
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHostname("metadata.goog")).toBe(true);
    expect(isBlockedHostname("instance-data")).toBe(true);
    expect(isBlockedHostname("169.254.169.254")).toBe(true);
  });

  it("does not block ordinary hostnames", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("api.example.com")).toBe(false);
    expect(isBlockedHostname("notlocal.com")).toBe(false);
  });
});

describe("isBlockedIp — IPv4 ranges", () => {
  const blockedCases: Array<[string, string]> = [
    ["0.0.0.0/8", "0.0.0.0"],
    ["10/8", "10.1.2.3"],
    ["100.64/10 (CGNAT)", "100.64.0.1"],
    ["127/8", "127.0.0.1"],
    ["169.254/16", "169.254.1.1"],
    ["169.254.169.254 metadata", "169.254.169.254"],
    ["172.16/12", "172.20.1.1"],
    ["192.0.0/24", "192.0.0.8"],
    ["192.0.2/24", "192.0.2.1"],
    ["192.88.99/24", "192.88.99.1"],
    ["192.168/16", "192.168.1.1"],
    ["198.18/15", "198.18.0.1"],
    ["198.51.100/24", "198.51.100.1"],
    ["203.0.113/24", "203.0.113.1"],
    ["224/4 multicast", "224.0.0.1"],
    ["240/4 reserved", "240.0.0.1"],
    ["255.255.255.255 broadcast", "255.255.255.255"],
  ];

  for (const [label, ip] of blockedCases) {
    it(`blocks ${label} (${ip})`, () => {
      expect(isBlockedIp(ip)).toBe(true);
    });
  }

  it("allows a normal public IPv4 address", () => {
    expect(isBlockedIp("93.184.216.34")).toBe(false);
  });
});

describe("isBlockedIp — IPv6 ranges", () => {
  const blockedCases: Array<[string, string]> = [
    ["::", "::"],
    ["::1", "::1"],
    ["fc00::/7 ULA", "fc00::1"],
    ["fd00::/7 ULA", "fd12:3456:789a::1"],
    ["fe80::/10 link-local", "fe80::1"],
    ["ff00::/8 multicast", "ff02::1"],
    ["2001:db8::/32 documentation", "2001:db8::1"],
    ["100::/64 discard-only", "100::1"],
    ["::ffff:127.0.0.1 mapped loopback", "::ffff:127.0.0.1"],
    ["::ffff:10.0.0.1 mapped private", "::ffff:10.0.0.1"],
  ];

  for (const [label, ip] of blockedCases) {
    it(`blocks ${label} (${ip})`, () => {
      expect(isBlockedIp(ip)).toBe(true);
    });
  }

  it("allows a normal public IPv6 address", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  it("blocks unparseable IP-looking strings (fail closed)", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("999.999.999.999")).toBe(true);
    expect(isBlockedIp("1.2.3")).toBe(true);
    expect(isBlockedIp(":::::")).toBe(true);
  });

  it("rejects IPv4 octets with leading zeros", () => {
    expect(isBlockedIp("010.0.0.1")).toBe(true);
  });
});

describe("assertSafeUrlSyntax — IP literals in URLs", () => {
  it("rejects a bracketed IPv6 loopback", () => {
    const result = assertSafeUrlSyntax("http://[::1]/");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("blocked_ip");
  });

  it("rejects an IPv4-mapped loopback in bracketed IPv6 form", () => {
    const result = assertSafeUrlSyntax("http://[::ffff:127.0.0.1]/");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("blocked_ip");
  });

  it("rejects a private IPv4 literal", () => {
    const result = assertSafeUrlSyntax("http://192.168.1.1/");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("blocked_ip");
  });

  it("accepts a public IPv4 literal", () => {
    const result = assertSafeUrlSyntax("http://93.184.216.34/");
    expect(result.ok).toBe(true);
  });
});

describe("assertSafeUrlSyntax — ports", () => {
  // Policy: 80 and 443 are always allowed; every other privileged port
  // (< 1024) is refused; and a deny-list catches well-known non-HTTP service
  // ports that happen to sit above 1024. The IP checks remain the primary
  // defence — this is defence in depth for a public host that also fronts an
  // internal-style service.
  const disallowed = [22, 25, 111, 445, 3306, 5432, 6379, 9200, 11211, 27017];
  for (const port of disallowed) {
    it(`rejects port ${port}`, () => {
      const result = assertSafeUrlSyntax(`https://example.com:${port}/`);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("port_not_allowed");
    });
  }

  it("allows port 80 explicitly on https", () => {
    const result = assertSafeUrlSyntax("https://example.com:80/");
    expect(result.ok).toBe(true);
  });

  it("allows port 443 explicitly on http", () => {
    const result = assertSafeUrlSyntax("http://example.com:443/");
    expect(result.ok).toBe(true);
  });

  it("allows default ports implicitly", () => {
    expect(assertSafeUrlSyntax("https://example.com/").ok).toBe(true);
    expect(assertSafeUrlSyntax("http://example.com/").ok).toBe(true);
  });

  for (const port of [8080, 8443, 3000, 5173]) {
    it(`allows ordinary high port ${port}`, () => {
      const result = assertSafeUrlSyntax(`https://example.com:${port}/`);
      expect(result.ok).toBe(true);
    });
  }
});

describe("resolveAndAssertSafeHost — DNS mocking", () => {
  it("passes when the hostname resolves to a public address", async () => {
    const result = await resolveAndAssertSafeHost("example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(result.ok).toBe(true);
    expect(result.addresses).toEqual(["93.184.216.34"]);
  });

  it("rejects when the hostname resolves to a loopback address", async () => {
    const result = await resolveAndAssertSafeHost("evil.example.com", {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("blocked_ip");
  });

  it("rejects when any resolved address is blocked, even alongside a public one", async () => {
    const result = await resolveAndAssertSafeHost("mixed.example.com", {
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("blocked_ip");
  });

  it("reports dns_failure when the lookup throws", async () => {
    const result = await resolveAndAssertSafeHost("broken.example.com", {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dns_failure");
  });

  it("reports dns_failure when the lookup returns no addresses", async () => {
    const result = await resolveAndAssertSafeHost("empty.example.com", {
      lookup: async () => [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dns_failure");
  });

  it("skips DNS entirely for IP literals", async () => {
    let called = false;
    const result = await resolveAndAssertSafeHost("93.184.216.34", {
      lookup: async () => {
        called = true;
        return [{ address: "93.184.216.34", family: 4 }];
      },
    });
    expect(result.ok).toBe(true);
    expect(called).toBe(false);
  });
});

describe("assertSafeUrl — end to end", () => {
  it("accepts a safe URL that resolves publicly", async () => {
    const result = await assertSafeUrl("https://example.com/foo", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(result.ok).toBe(true);
    expect(result.url?.href).toBe("https://example.com/foo");
    expect(result.addresses).toEqual(["93.184.216.34"]);
  });

  it("rejects before DNS when the syntax is unsafe", async () => {
    let called = false;
    const result = await assertSafeUrl("ftp://example.com/", {
      lookup: async () => {
        called = true;
        return [{ address: "93.184.216.34", family: 4 }];
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unsupported_scheme");
    expect(called).toBe(false);
  });

  it("rejects when DNS resolves to a blocked address", async () => {
    const result = await assertSafeUrl("https://rebind.example.com/", {
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("blocked_ip");
  });
});
