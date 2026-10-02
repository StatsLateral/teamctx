/**
 * The address this deployment is reachable at.
 *
 * Two copies of this used to read `x-forwarded-host` and believe it. That was
 * only ever a redirect away from the person who sent the header, until the view
 * link started being built from it: a tool result now carries this address to an
 * assistant, which presents it as a link to click. A header nobody checked is
 * the wrong thing to put in front of somebody that way.
 *
 * So the request is still what names the address — a preview deployment and a
 * custom domain both have to produce links to themselves — but only when the
 * host it names is one this deployment knows itself by. The names come from the
 * environment, which the platform sets and a request cannot reach.
 *
 * With nothing configured at all there is nothing to check against and nothing
 * to fall back to, so the request is taken at its word. That is local
 * development, where the only host available is the one you are typing into.
 */

const strip = (url) => String(url).replace(/\/+$/, '');

/** The addresses the environment says this deployment answers on, best first. */
export function configuredBases(env = process.env) {
  return [
    env.TEAMCTX_BASE_URL,
    // The production alias before the per-deployment URL: a link somebody keeps
    // should outlive the deployment that produced it.
    env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`,
    env.VERCEL_URL && `https://${env.VERCEL_URL}`,
  ].filter(Boolean).map(strip);
}

/** Same host, ignoring case and a default port. */
function sameHost(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.hostname.toLowerCase() === y.hostname.toLowerCase() && x.port === y.port;
  } catch { return false; }
}

/**
 * Build the base URL from what the request says, checked against what we know.
 *
 * `host` and `proto` come from the request. An explicit `TEAMCTX_BASE_URL` wins
 * outright, because somebody wrote it down on purpose.
 */
export function baseUrlFrom({ host, proto } = {}, env = process.env) {
  if (env.TEAMCTX_BASE_URL) return strip(env.TEAMCTX_BASE_URL);
  const known = configuredBases(env);
  const candidate = host ? `${proto || 'https'}://${host}` : null;
  if (candidate && known.some(base => sameHost(base, candidate))) return strip(candidate);
  if (known.length) return known[0];
  return candidate ? strip(candidate) : '';
}
