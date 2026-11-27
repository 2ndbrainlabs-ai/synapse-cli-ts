/**
 * synapse doctor — check that this machine can reach the Synapse API.
 */

import { getApiUrl, getBackendConfig } from "../config/manager.js";
import { t, sectionHeader, stepOk, stepErr } from "../ui/theme.js";
import { describeFetchError, networkHint, proxyEnvVars } from "../utils/network.js";

export async function runDoctor(): Promise<void> {
  const apiUrl = getApiUrl().replace(/\/+$/, "");
  const backend = getBackendConfig();
  const proxies = proxyEnvVars();

  sectionHeader("Synapse Doctor");
  console.log(`  ${t.bold("Node")}         ${process.version}`);
  console.log(`  ${t.bold("api_url")}      ${apiUrl}`);
  console.log(`  ${t.bold("backend_url")}  ${backend.url ?? `${backend.host}:${backend.port}`}`);
  console.log(`  ${t.bold("Proxy env")}    ${proxies.length ? proxies.join(", ") : "none"}`);
  console.log(`  ${t.bold("NODE_OPTIONS")} ${process.env.NODE_OPTIONS || "none"}`);
  console.log(`  ${t.bold("Extra CAs")}    ${process.env.NODE_EXTRA_CA_CERTS || "none"}`);
  console.log();

  for (const url of [`${apiUrl}/`, `${apiUrl}/quota`]) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      // Any HTTP answer (even 401 on /quota without a key) means the network path works.
      stepOk(url, `HTTP ${resp.status}`);
    } catch (err) {
      const why = describeFetchError(err);
      stepErr(url, why);
      const hint = networkHint(why);
      if (hint) console.log(`    ${t.warm(hint)}`);
    }
  }
  console.log();
}
