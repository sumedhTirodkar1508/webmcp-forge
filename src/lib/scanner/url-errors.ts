import { AppError } from "@/lib/errors";
import type { UrlRejectionReason } from "@/lib/scanner/url-safety";

/**
 * Turns a URL-safety rejection into something a portfolio owner can act on.
 *
 * The safety layer's own messages are written for the security boundary
 * ("That host is not allowed."). Shown raw, they told a designer testing
 * `localhost` nothing useful, and a simple typo in a domain came back as
 * BLOCKED_TARGET — as if the address were hostile rather than mistyped. Each
 * reason now gets its own code and an explanation of what to do instead.
 */
export function urlRejectionError(reason: UrlRejectionReason | undefined): AppError {
  switch (reason) {
    case "invalid_url":
    case "missing_hostname":
      return new AppError(
        "INVALID_URL",
        "That doesn't look like a web address. Try something like https://your-portfolio.com.",
      );
    case "unsupported_scheme":
      return new AppError(
        "INVALID_URL",
        "Use a web address that starts with https:// (or http://).",
      );
    case "credentials_in_url":
      return new AppError(
        "INVALID_URL",
        "Remove the username and password from the address — WebMCP Forge only scans public pages.",
      );
    case "dns_failure":
      return new AppError(
        "HOST_NOT_FOUND",
        "We couldn't find that website. Check the address for typos, and make sure the site is published.",
      );
    case "port_not_allowed":
      return new AppError(
        "BLOCKED_TARGET",
        "That port isn't supported. Use your site's normal public address.",
      );
    case "blocked_hostname":
    case "blocked_ip":
    default:
      return new AppError(
        "BLOCKED_TARGET",
        "WebMCP Forge can only scan public websites. Local or private addresses (such as localhost) " +
          "aren't reachable from our servers — use your published site's address or a public preview link.",
      );
  }
}
