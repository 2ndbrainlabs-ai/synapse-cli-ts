// "fetch failed" must carry its cause and a fix (hackathon network failures).

import { describe, it, expect } from "vitest";
import {
  CERT_HINT,
  CONNECT_HINT,
  DNS_HINT,
  describeFetchError,
  networkHint,
  proxyEnvVars,
} from "../../../src/utils/network.js";
import { backendUnavailableError, classifyFailure, ERROR_CODES } from "../../../src/ui/errors.js";
import { uiBackendFailure } from "../../../src/commands/v2/build-outcome.js";

function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("describeFetchError", () => {
  it("appends the cause code and message", () => {
    const err = fetchFailed(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate"));
    expect(describeFetchError(err)).toBe(
      "fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate)",
    );
  });

  it("digs into AggregateError (every address failed)", () => {
    const agg = new AggregateError([coded("ETIMEDOUT", "connect ETIMEDOUT 1.2.3.4:443")], "");
    expect(describeFetchError(fetchFailed(agg))).toBe("fetch failed (ETIMEDOUT: connect ETIMEDOUT 1.2.3.4:443)");
  });

  it("keeps the plain message when there is no cause", () => {
    expect(describeFetchError(new TypeError("fetch failed"))).toBe("fetch failed");
  });

  it("reports aborts as timeouts", () => {
    const abort = new DOMException("This operation was aborted", "AbortError");
    expect(describeFetchError(abort)).toBe("request timed out");
  });
});

describe("networkHint", () => {
  it.each([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_HAS_EXPIRED",
    "14 UNAVAILABLE: self-signed certificate in certificate chain",
  ])("cert: %s", (text) => {
    expect(networkHint(text)).toBe(CERT_HINT);
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ENETUNREACH", "EHOSTUNREACH"])(
    "connect: %s",
    (code) => {
      expect(networkHint(`fetch failed (${code}: x)`)).toBe(CONNECT_HINT);
    },
  );

  it.each(["ENOTFOUND", "EAI_AGAIN"])("dns: %s", (code) => {
    expect(networkHint(`fetch failed (${code}: x)`)).toBe(DNS_HINT);
  });

  it("returns null for unknown failures", () => {
    expect(networkHint("fetch failed")).toBeNull();
  });

  it("hints name the actual workarounds", () => {
    expect(CERT_HINT).toMatch(/NODE_OPTIONS=--use-system-ca/);
    expect(CERT_HINT).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(CONNECT_HINT).toMatch(/HTTPS_PROXY/);
  });
});

describe("BACKEND_UNAVAILABLE box", () => {
  it("uiBackendFailure surfaces the cause, the URL tried and the cert hint", () => {
    const prev = process.env.SYNAPSE_API_URL;
    process.env.SYNAPSE_API_URL = "https://api.example.test";
    try {
      const e = uiBackendFailure(fetchFailed(coded("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain")));
      expect(e.error_code).toBe(ERROR_CODES.BACKEND_UNAVAILABLE);
      expect(e.technical).toMatch(/fetch failed \(SELF_SIGNED_CERT_IN_CHAIN: /);
      expect(e.technical).toMatch(/URL: https:\/\/api\.example\.test/);
      expect(e.hint).toBe(CERT_HINT);
    } finally {
      if (prev === undefined) delete process.env.SYNAPSE_API_URL;
      else process.env.SYNAPSE_API_URL = prev;
    }
  });

  it("falls back to the generic hint with a pointer to synapse doctor", () => {
    expect(backendUnavailableError("fetch failed").hint).toMatch(/synapse doctor/);
    expect(classifyFailure("fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND x)").hint).toBe(DNS_HINT);
  });
});

describe("proxyEnvVars", () => {
  it("lists set proxy vars by name only", () => {
    expect(proxyEnvVars({ https_proxy: "http://u:p@h:1", NO_PROXY: "localhost", HTTP_PROXY: "" })).toEqual([
      "https_proxy",
      "NO_PROXY",
    ]);
  });
});
