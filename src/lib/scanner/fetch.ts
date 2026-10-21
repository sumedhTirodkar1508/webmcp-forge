import { lookup as dnsLookup, type LookupAddress } from "node:dns";

import { Agent, request as undiciRequest } from "undici";

import { AppError } from "@/lib/errors";
import { urlRejectionError } from "@/lib/scanner/url-errors";
import { isBlockedIp, normalizeUrl, assertSafeUrlSyntax } from "@/lib/scanner/url-safety";

/**
 * Bounded, SSRF-checked HTML fetching.
 *
 * Three defences stack here:
 *
 *  1. **Syntax gate** — scheme, credentials, hostname and port are checked
 *     before anything touches the network.
 *  2. **Connection-time DNS validation** — the request is made through an
 *     undici `Agent` whose `connect.lookup` is ours. Every address the resolver
 *     returns is checked against the private/reserved deny-list *at the moment
 *     the socket is opened*, and the lookup fails outright if any of them is
 *     unsafe. Because this is the same resolution the connection then uses,
 *     there is no time-of-check/time-of-use window for DNS rebinding to exploit
 *     — unlike validating with a separate `dns.lookup` and hoping `fetch`
 *     re-resolves to the same answer.
 *  3. **Manual redirects** — undici does not follow redirects unless the
 *     redirect interceptor is installed, and this agent deliberately installs
 *     none. Every `Location` is re-run through the full check before we follow
 *     it, so a public host cannot bounce us to a private one.
 *
 * The body is streamed and abandoned the moment it exceeds the byte budget, so
 * a server that replies forever cannot exhaust memory. Nothing fetched is ever
 * executed; it is only parsed as text.
 */

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

export interface FetchedDocument {
  /** The URL that finally served the document, after redirects. */
  finalUrl: string;
  status: number;
  contentType?: string;
  html: string;
  byteSize: number;
  /** Every hop taken, starting with the requested URL. */
  redirectChain: string[];
  /** The addresses we validated and connected to. */
  addresses: string[];
}

const USER_AGENT =
  "WebMCPForgeBot/1.0 (+https://github.com/sumedhTirodkar1508/webmcp-forge; agent-readiness scanner)";

const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

/** Exported for tests. */
export function isHtmlContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  return HTML_CONTENT_TYPES.includes(mime);
}

/** Marks a rejection that came from our own lookup rather than the resolver. */
export class BlockedAddressError extends Error {
  constructor(readonly address: string) {
    super("blocked address");
    this.name = "BlockedAddressError";
  }
}

/**
 * Builds an agent whose DNS lookup refuses to hand the socket layer an unsafe
 * address. `collect` records what was actually connected to, for diagnostics.
 */
function createGuardedAgent(
  limits: FetchLimits,
  collect: (addresses: string[]) => void,
): Agent {
  return new Agent({
    connections: 1,
    headersTimeout: limits.timeoutMs,
    bodyTimeout: limits.timeoutMs,
    connect: {
      timeout: limits.timeoutMs,
      lookup(hostname, options, callback) {
        dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
          if (error) {
            callback(error, "", 0);
            return;
          }

          const list = addresses as LookupAddress[];
          if (list.length === 0) {
            callback(new BlockedAddressError(hostname), "", 0);
            return;
          }

          for (const entry of list) {
            if (isBlockedIp(entry.address)) {
              // Fail the connection rather than filtering: if a name resolves
              // to anything private, we want nothing to do with it.
              callback(new BlockedAddressError(entry.address), "", 0);
              return;
            }
          }

          collect(list.map((entry) => entry.address));
          callback(null, list, 0);
        });
      },
    },
  });
}

/** Reads at most `maxBytes`, destroying the stream rather than buffering more. */
/** Exported for tests. */
export async function readBounded(
  body: AsyncIterable<Buffer> & { destroy?: (error?: Error) => void },
  maxBytes: number,
): Promise<{ text: string; byteSize: number }> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      body.destroy?.();
      throw new AppError("TOO_LARGE", "That page is larger than we can safely scan.");
    }
    chunks.push(chunk);
  }

  return {
    // Non-UTF-8 pages degrade to replacement characters rather than throwing;
    // extraction stays useful either way.
    text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)),
    byteSize: total,
  };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Fetches one HTML document, validating the target before and during every hop.
 *
 * @throws {AppError} with a user-safe code for every failure mode.
 */
export async function fetchHtml(
  rawUrl: string,
  limits: FetchLimits,
): Promise<FetchedDocument> {
  const redirectChain: string[] = [];
  const addresses: string[] = [];
  const agent = createGuardedAgent(limits, (found) => addresses.push(...found));

  let current = rawUrl;

  try {
    for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
      const safety = assertSafeUrlSyntax(current);
      if (!safety.ok || !safety.url) {
        throw urlRejectionError(safety.reason);
      }

      const target = safety.url;
      redirectChain.push(target.toString());

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limits.timeoutMs);

      let response: Awaited<ReturnType<typeof undiciRequest>>;
      try {
        response = await undiciRequest(target, {
          dispatcher: agent,
          signal: controller.signal,
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "accept-language": "en",
          },
        });
      } catch (error) {
        clearTimeout(timer);
        throw translateTransportError(error, target.toString());
      }

      try {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          await response.body.dump().catch(() => {});
          const location = headerValue(response.headers, "location");
          if (!location) {
            throw new AppError("FETCH_FAILED", "That site sent an incomplete redirect.");
          }
          // Resolve a relative Location against the hop we just made; the next
          // iteration re-runs the full safety check on it.
          const next = normalizeUrl(new URL(location, target).toString());
          if (!next) {
            throw new AppError(
              "FETCH_FAILED",
              "That site redirected somewhere we cannot follow.",
            );
          }
          current = next.toString();
          continue;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          await response.body.dump().catch(() => {});
          throw new AppError(
            "FETCH_FAILED",
            `That page returned status ${response.statusCode}.`,
            { status: response.statusCode },
          );
        }

        const contentType = headerValue(response.headers, "content-type");
        if (!isHtmlContentType(contentType)) {
          await response.body.dump().catch(() => {});
          throw new AppError(
            "NOT_HTML",
            "That address does not serve a web page we can read.",
          );
        }

        const declared = Number(headerValue(response.headers, "content-length") ?? "0");
        if (Number.isFinite(declared) && declared > limits.maxBytes) {
          await response.body.dump().catch(() => {});
          throw new AppError("TOO_LARGE", "That page is larger than we can safely scan.");
        }

        const { text, byteSize } = await readBounded(response.body, limits.maxBytes);

        return {
          finalUrl: target.toString(),
          status: response.statusCode,
          contentType,
          html: text,
          byteSize,
          redirectChain,
          addresses: [...new Set(addresses)],
        };
      } finally {
        clearTimeout(timer);
      }
    }

    throw new AppError("TOO_MANY_REDIRECTS", "That address redirected too many times.");
  } finally {
    await agent.close().catch(() => {});
  }
}

/**
 * Maps transport-level failures onto user-safe codes without leaking detail.
 * Exported for tests.
 */
export function translateTransportError(error: unknown, url: string): AppError {
  const cause = (error as { cause?: unknown })?.cause;

  if (cause instanceof BlockedAddressError || error instanceof BlockedAddressError) {
    return new AppError(
      "BLOCKED_TARGET",
      "That address resolves to a private or reserved network, so we will not scan it.",
    );
  }

  const name = (error as { name?: string })?.name;
  const code = (error as { code?: string })?.code ?? (cause as { code?: string })?.code;

  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return new AppError("FETCH_TIMEOUT", "That site took too long to respond.", { url });
  }

  // The name stopped resolving between validation and connection, or never
  // resolved for this resolver. Same advice as a typo, not a security block.
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new AppError(
      "HOST_NOT_FOUND",
      "We couldn't find that website. Check the address for typos, and make sure the site is published.",
      { url },
    );
  }

  return new AppError("FETCH_FAILED", "We could not reach that address.", { url });
}
