import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";
import {
  BlockedAddressError,
  fetchHtml,
  isHtmlContentType,
  readBounded,
  translateTransportError,
} from "@/lib/scanner/fetch";

const LIMITS = { timeoutMs: 2000, maxBytes: 50_000, maxRedirects: 3 };

describe("isHtmlContentType", () => {
  it("accepts html and xhtml, with or without parameters", () => {
    expect(isHtmlContentType("text/html")).toBe(true);
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
    expect(isHtmlContentType("TEXT/HTML")).toBe(true);
  });

  it("rejects everything else, including a missing header", () => {
    for (const value of [
      undefined,
      "application/json",
      "application/pdf",
      "text/plain",
      "image/png",
      "application/octet-stream",
    ]) {
      expect(isHtmlContentType(value)).toBe(false);
    }
  });
});

describe("readBounded", () => {
  const stream = (chunks: string[]) => Readable.from(chunks.map((c) => Buffer.from(c)));

  it("reads a body that fits within the budget", async () => {
    const result = await readBounded(stream(["<html>", "hi</html>"]), 1000);
    expect(result.text).toBe("<html>hi</html>");
    expect(result.byteSize).toBe(15);
  });

  it("throws TOO_LARGE as soon as the budget is exceeded", async () => {
    await expect(readBounded(stream(["a".repeat(50), "b".repeat(60)]), 80)).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });

  it("decodes invalid utf-8 without throwing", async () => {
    const bad = Readable.from([Buffer.from([0xff, 0xfe, 0x41])]);
    const result = await readBounded(bad, 100);
    expect(result.text).toContain("A");
  });
});

describe("translateTransportError", () => {
  it("maps a blocked address to BLOCKED_TARGET", () => {
    const direct = translateTransportError(new BlockedAddressError("10.0.0.1"), "https://x.test/");
    expect(direct.code).toBe("BLOCKED_TARGET");

    // undici wraps connection errors in `cause`.
    const wrapped = translateTransportError(
      Object.assign(new Error("connect failed"), { cause: new BlockedAddressError("::1") }),
      "https://x.test/",
    );
    expect(wrapped.code).toBe("BLOCKED_TARGET");
  });

  it("maps aborts and undici timeouts to FETCH_TIMEOUT", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(translateTransportError(abort, "https://x.test/").code).toBe("FETCH_TIMEOUT");

    for (const code of [
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_CONNECT_TIMEOUT",
    ]) {
      const error = Object.assign(new Error("timeout"), { code });
      expect(translateTransportError(error, "https://x.test/").code).toBe("FETCH_TIMEOUT");
    }
  });

  it("falls back to FETCH_FAILED without leaking the original message", () => {
    const error = translateTransportError(
      new Error("ECONNREFUSED 10.1.2.3:5432 internal-db"),
      "https://x.test/",
    );
    expect(error.code).toBe("FETCH_FAILED");
    expect(error.message).not.toContain("10.1.2.3");
    expect(error.message).not.toContain("internal-db");
  });
});

describe("fetchHtml — SSRF gate", () => {
  // These never reach the network: the syntax gate refuses them first. The
  // point is that no configuration of the crawler can turn the server into a
  // proxy for internal infrastructure.
  const blocked = [
    "http://127.0.0.1:8080/",
    "http://localhost:3000/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://admin.internal/",
    "https://example.com:6379/",
  ];

  for (const url of blocked) {
    it(`refuses ${url}`, async () => {
      await expect(fetchHtml(url, LIMITS)).rejects.toMatchObject({ code: "BLOCKED_TARGET" });
    });
  }

  it("refuses non-http schemes and credentialed URLs", async () => {
    await expect(fetchHtml("file:///etc/passwd", LIMITS)).rejects.toBeInstanceOf(AppError);
    await expect(fetchHtml("https://user:pw@example.com/", LIMITS)).rejects.toMatchObject({
      code: "BLOCKED_TARGET",
    });
  });

  it("refuses an unparseable address", async () => {
    await expect(fetchHtml("http://", LIMITS)).rejects.toMatchObject({ code: "INVALID_URL" });
  });
});
