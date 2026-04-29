/**
 * Base URL of upstream service (target server)
 * Removes trailing slash to ensure proper URL concatenation
 */
const UPSTREAM_BASE_URL = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");

/**
 * Set of headers that must NOT be forwarded
 * Prevents proxy loops and protocol-level conflicts
 */
const BLOCKED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

/**
 * Main handler function (Netlify Edge / Function proxy)
 */
export default async function proxyHandler(incomingRequest) {
  /**
   * Ensure required environment variable is defined
   */
  if (!UPSTREAM_BASE_URL) {
    return new Response("Configuration Error: TARGET_DOMAIN is not defined", {
      status: 500,
    });
  }

  try {
    /**
     * Parse incoming request URL
     */
    const parsedUrl = new URL(incomingRequest.url);

    /**
     * Construct destination URL
     */
    const destinationUrl =
      UPSTREAM_BASE_URL + parsedUrl.pathname + parsedUrl.search;

    /**
     * Prepare sanitized headers for upstream request
     */
    const forwardedHeaders = new Headers();

    /**
     * Store detected client IP address
     */
    let extractedClientIp = null;

    /**
     * Iterate through incoming headers
     */
    for (const [headerKey, headerValue] of incomingRequest.headers) {
      const normalizedKey = headerKey.toLowerCase();

      /**
       * Skip blocked headers
       */
      if (BLOCKED_HEADERS.has(normalizedKey)) continue;

      /**
       * Skip Netlify-specific internal headers
       */
      if (normalizedKey.startsWith("x-nf-")) continue;
      if (normalizedKey.startsWith("x-netlify-")) continue;

      /**
       * Capture real client IP
       */
      if (normalizedKey === "x-real-ip") {
        extractedClientIp = headerValue;
        continue;
      }

      /**
       * Fallback to x-forwarded-for
       */
      if (normalizedKey === "x-forwarded-for") {
        if (!extractedClientIp) extractedClientIp = headerValue;
        continue;
      }

      /**
       * Forward safe headers
       */
      forwardedHeaders.set(normalizedKey, headerValue);
    }

    /**
     * Inject client IP into forwarded headers
     */
    if (extractedClientIp) {
      forwardedHeaders.set("x-forwarded-for", extractedClientIp);
    }

    /**
     * Extract HTTP method
     */
    const httpMethod = incomingRequest.method;

    /**
     * Determine if request contains a body
     */
    const shouldIncludeBody =
      httpMethod !== "GET" && httpMethod !== "HEAD";

    /**
     * Build fetch options
     */
    const upstreamRequestConfig = {
      method: httpMethod,
      headers: forwardedHeaders,
      redirect: "manual", // Prevent automatic redirects
    };

    /**
     * Attach request body if applicable
     */
    if (shouldIncludeBody) {
      upstreamRequestConfig.body = incomingRequest.body;
    }

    /**
     * Perform request to upstream server
     */
    const upstreamResponse = await fetch(
      destinationUrl,
      upstreamRequestConfig
    );

    /**
     * Prepare response headers for client
     */
    const clientResponseHeaders = new Headers();

    for (const [resHeaderKey, resHeaderValue] of upstreamResponse.headers) {
      /**
       * Skip problematic headers
       */
      if (resHeaderKey.toLowerCase() === "transfer-encoding") continue;

      clientResponseHeaders.set(resHeaderKey, resHeaderValue);
    }

    /**
     * Return streamed response back to client
     */
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: clientResponseHeaders,
    });
  } catch (proxyException) {
    /**
     * Return fallback error response
     */
    return new Response("Bad Gateway: Proxy Failure", {
      status: 502,
    });
  }
}