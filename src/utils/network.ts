// Network diagnostics and setup for Node's built-in fetch.
//
// fetch() rejects with a bare "fetch failed" TypeError; the real reason
// (TLS interception, proxy-only network, DNS, broken IPv6) lives in
// err.cause. These helpers surface it and map it to a fix.

interface CauseLike {
  code?: unknown;
  message?: unknown;
  errors?: unknown;
  cause?: unknown;
}

/** The innermost error carrying a code (or the first nested one). */
function rootCause(err: unknown): CauseLike | null {
  let cur: unknown = (err as CauseLike | null)?.cause;
  let best: CauseLike | null = null;
  for (let depth = 0; cur && typeof cur === "object" && depth < 5; depth++) {
    const c = cur as CauseLike;
    // AggregateError (happy-eyeballs: every address failed): use the first.
    if (!c.code && Array.isArray(c.errors) && c.errors.length > 0) {
      cur = c.errors[0];
      continue;
    }
    best = c;
    if (c.code) break;
    cur = c.cause;
  }
  return best;
}

/** "fetch failed (CODE: message)" — the error text plus its underlying cause. */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "AbortError" || err.name === "TimeoutError") return "request timed out";
  const cause = rootCause(err);
  if (!cause) return err.message;
  const code = typeof cause.code === "string" ? cause.code : "";
  const msg = typeof cause.message === "string" ? cause.message : "";
  const detail = [code, msg && msg !== code ? msg : ""].filter(Boolean).join(": ");
  return detail ? `${err.message} (${detail})` : err.message;
}

// Codes from fetch causes, plus OpenSSL wording that gRPC errors carry.
const CERT_RE =
  /SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|\bCERT_[A-Z_]+|ERR_TLS_CERT|self[- ]signed certificate|unable to get local issuer certificate|unable to verify the first certificate/;
const CONNECT_RE = /ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|request timed out/;
const DNS_RE = /ENOTFOUND|EAI_AGAIN/;

export const CERT_HINT =
  "Your network intercepts TLS with its own certificate. Trust it with " +
  "NODE_OPTIONS=--use-system-ca (Node >= 22.15 / 23.8), or " +
  "NODE_EXTRA_CA_CERTS=/path/to/network-ca.pem, then re-run.";
export const CONNECT_HINT =
  "The connection was blocked or dropped. If your network needs a proxy, set " +
  "HTTPS_PROXY=http://proxy-host:port (Synapse uses it automatically); " +
  "otherwise try a different network (e.g. a phone hotspot).";
export const DNS_HINT =
  "DNS lookup failed. Check your connection or DNS settings, and that " +
  "SYNAPSE_API_URL / api_url point at a real host.";

/** A fix for the failure described by `text`, or null when nothing specific applies. */
export function networkHint(text: string): string | null {
  if (CERT_RE.test(text)) return CERT_HINT;
  if (DNS_RE.test(text)) return DNS_HINT;
  if (CONNECT_RE.test(text)) return CONNECT_HINT;
  return null;
}

/** The proxy env vars that are set, by name (values may hold credentials). */
export function proxyEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"].filter(
    (k) => (env[k] ?? "").trim() !== "",
  );
}

/**
 * Called once at startup: prefer IPv4 (venues with broken IPv6), and route
 * fetch through HTTPS_PROXY/HTTP_PROXY when set (Node's fetch ignores them).
 * NO_PROXY is honoured by EnvHttpProxyAgent. Never throws.
 */
export async function setupNetwork(): Promise<void> {
  try {
    const dns = await import("node:dns");
    dns.setDefaultResultOrder?.("ipv4first");
  } catch {
    /* older Node — keep the default */
  }
  const env = process.env;
  if (!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) return;
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
    // undici 6 flags EnvHttpProxyAgent experimental; don't print that to users.
    const emit = process.emitWarning;
    process.emitWarning = (() => undefined) as typeof process.emitWarning;
    try {
      setGlobalDispatcher(new EnvHttpProxyAgent());
    } finally {
      process.emitWarning = emit;
    }
  } catch {
    /* proxy support unavailable — fall back to direct connections */
  }
}
