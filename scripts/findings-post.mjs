/**
 * Review Hero — Posting findings
 *
 * Sends a round's findings, as JSON, to the URL the caller named, authenticated
 * by a GitHub Actions identity token whose audience is that URL's origin. The
 * receiver checks the token with GitHub, so it shares no secret with the
 * caller. A post that does not land never fails the review: this module
 * reports how it went and the orchestrator carries on.
 */

import { oneLine } from "./lib.mjs";

/** Delivery, the token request and the post with their retries, is over by this time. */
export const FINDINGS_POST_TOTAL_MS = 60_000;
/** One attempt, cut to what is left of the total. */
export const FINDINGS_POST_ATTEMPT_MS = 25_000;
/** The pause before a retry. */
export const FINDINGS_POST_RETRY_DELAY_MS = 2_000;
/** A retry needs at least this much of the total left to be worth starting. */
export const FINDINGS_POST_MIN_RETRY_MS = 5_000;
/** Redirects followed within one attempt. */
export const FINDINGS_POST_MAX_REDIRECTS = 3;
/** Time the request for an identity token has. */
export const IDENTITY_TOKEN_TIMEOUT_MS = 15_000;

/** The reply's first characters kept for the job log. */
const REPLY_EXCERPT = 200;
/**
 * How much of a reply is read before it is redacted and cut to the excerpt, so
 * a URL or secret that runs over the excerpt's end is still seen whole.
 */
const REPLY_READ = REPLY_EXCERPT + 1024;

/**
 * The parts of a findings URL a caller could keep a secret in (its path, query
 * and each query value, fragment and userinfo), each with what stands in for it
 * in the log, longest first so no part is cut by a shorter one. Each comes as
 * written in the URL and decoded, since a message may quote either.
 */
function secretParts(url) {
  const decode = (part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const parts = [
    [url.pathname.length > 1 ? url.pathname : "", "/…"],
    [url.search, "?…"],
    [url.hash, "#…"],
    [url.password, "…"],
    [url.username ? `${url.username}:` : "", "…:"],
    [url.username ? `${url.username}@` : "", "…@"],
    // A reply may echo a query's values without the rest of it.
    ...[...url.searchParams.values()].flatMap((value) => [[value, "…"], [encodeURIComponent(value), "…"]]),
  ];
  return parts
    .flatMap(([part, stand]) => [[part, stand], [decode(part), stand]])
    .filter(([part]) => part.length > 1)
    .sort(([a], [b]) => b.length - a.length);
}

/**
 * Text fit for the job log: on one line, with no control characters (a
 * receiver's reply could otherwise restyle the log), with every part of `url`,
 * when given, that could hold a secret (its path, query, fragment and userinfo)
 * removed wherever it appears, and with every other URL cut to its origin.
 */
function logText(text, url) {
  let line = oneLine(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  if (url) for (const [part, stand] of secretParts(url)) line = line.split(part).join(stand);
  return line.replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#@"'<>]*@)?([^\s/?#"'<>]+)[^\s"'<>]*/gi, "$1$2");
}

/** An error's message, fit for the job log. */
function logMessage(err, url) {
  return logText(err?.message ?? err, url);
}

/**
 * The start of a reply, read only as far as the excerpt needs: the receiver is
 * whatever the caller named, and could send a body of any size. A reply can
 * echo the request, so it is redacted like any other log line, before it is cut
 * so the cut never splits something the redaction would have caught.
 */
async function replyExcerpt(response, url) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < REPLY_READ) {
      const { done, value } = await reader.read();
      if (done) break;
      // A chunk can be any size, and a character is at most four bytes.
      text += decoder.decode(value.subarray(0, 4 * (REPLY_READ - text.length)), { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return logText(text.slice(0, REPLY_READ), url).slice(0, REPLY_EXCERPT);
}

/**
 * Where a review posts its findings: undefined when `raw` is empty, so the
 * review posts nothing; null when it is not an `https` URL; the URL otherwise.
 * The one test of a findings URL, so whatever the review does only for a post
 * (looking up comment ids) follows the post itself.
 */
// spec: FPOST#turning-it-on
export function findingsTarget(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Ask GitHub Actions for an identity token addressed to `audience`. Null when
 * the job was not granted permission to request one (a caller without
 * `id-token: write`, or a pull request from a fork) or the request fails. A
 * request that gets no answer, a server error or a rate limit is tried once
 * more, so a passing hiccup at GitHub does not read as a missing permission.
 * Both attempts keep within `deadline`.
 */
// spec: FPOST#authentication
export async function requestIdentityToken({
  audience,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = IDENTITY_TOKEN_TIMEOUT_MS,
  now = Date.now,
  deadline = Infinity,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return null;

  const once = async () => {
    try {
      const url = new URL(requestUrl);
      url.searchParams.set("audience", audience);
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - now()))),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return {
          retry: response.status >= 500 || response.status === 429,
          why: `status ${response.status}`,
        };
      }
      const { value } = await response.json();
      if (typeof value !== "string" || !value) return { retry: false, why: "no token in the reply" };
      return { value };
    } catch (err) {
      return { retry: true, why: err.name === "TimeoutError" ? "timed out" : logMessage(err) };
    }
  };

  let result = await once();
  if (result.retry && deadline - now() - FINDINGS_POST_RETRY_DELAY_MS >= FINDINGS_POST_MIN_RETRY_MS) {
    log(`::warning::Identity token request failed (${result.why}); trying once more`);
    await sleep(FINDINGS_POST_RETRY_DELAY_MS);
    result = await once();
  }
  if (!result.value) {
    log(`::warning::Identity token request failed: ${result.why}`);
    return null;
  }
  // Anything that later prints the token prints it masked.
  log(`::add-mask::${result.value}`);
  return result.value;
}

/**
 * One attempt at the post, following same-origin 307 and 308 redirects. Any
 * other redirect is not followed, so the token only ever goes to the origin it
 * is addressed to, and counts as refused.
 *
 * Resolves with `{ status, retry, detail }`: `accepted` on a 2xx, `refused`
 * when the receiver answered with anything else, `unreachable` when no answer
 * came. A refusal is worth a retry only when it is a server error.
 */
async function attempt({ url, token, body, fetchImpl, timeoutMs }) {
  const origin = url.origin;
  const signal = AbortSignal.timeout(timeoutMs);
  let target = url;
  try {
    for (let hops = 0; ; hops++) {
      const response = await fetchImpl(target, {
        method: "POST",
        redirect: "manual",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
        signal,
      });
      const { status } = response;
      if (status >= 200 && status < 300) {
        await response.body?.cancel().catch(() => {});
        return { status: "accepted", retry: false, detail: `status ${status}` };
      }
      if (status === 307 || status === 308) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        let next = null;
        try {
          next = location ? new URL(location, target) : null;
        } catch {
          // An unreadable Location is refused below.
        }
        if (next && next.origin === origin && hops < FINDINGS_POST_MAX_REDIRECTS) {
          target = next;
          continue;
        }
        const why = !next ? "no usable Location" : next.origin !== origin ? "redirect to another origin not followed" : "too many redirects";
        return { status: "refused", retry: false, detail: `status ${status}, ${why}` };
      }
      let reply = "";
      try {
        reply = await replyExcerpt(response, url);
      } catch {
        // The status stands without the reply.
      }
      return {
        status: "refused",
        retry: status >= 500,
        detail: `status ${status}${reply ? `, reply: ${reply}` : ""}`,
      };
    }
  } catch (err) {
    return {
      status: "unreachable",
      retry: true,
      detail: err.name === "TimeoutError" ? "timed out" : logMessage(err, url),
    };
  }
}

/**
 * Post `body`, the payload as JSON, to `url` with `token` as the bearer, trying
 * once more after no answer or a server error, all within `deadline`, by
 * default `FINDINGS_POST_TOTAL_MS` from now. The result is the last attempt's.
 */
// spec: FPOST#when-a-review-posts
export async function postFindings({
  url,
  body,
  token,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attemptMs = FINDINGS_POST_ATTEMPT_MS,
  deadline = now() + FINDINGS_POST_TOTAL_MS,
  log = console.log,
}) {
  // However long the token took, the post gets at least the time a retry would.
  const firstMs = Math.min(attemptMs, Math.max(FINDINGS_POST_MIN_RETRY_MS, deadline - now()));
  let result = await attempt({ url, token, body, fetchImpl, timeoutMs: firstMs });
  if (result.retry) {
    // Decided before the pause, so a retry that cannot fit costs no wait.
    const left = deadline - now() - FINDINGS_POST_RETRY_DELAY_MS;
    if (left >= FINDINGS_POST_MIN_RETRY_MS) {
      log(`::warning::Posting findings: ${result.detail}; trying once more`);
      await sleep(FINDINGS_POST_RETRY_DELAY_MS);
      result = await attempt({ url, token, body, fetchImpl, timeoutMs: Math.min(attemptMs, deadline - now()) });
    } else {
      log(`::warning::Posting findings: ${result.detail}; too little time left to try again`);
    }
  }
  return result;
}

/**
 * Deliver a round's findings to `findingsUrl` and say how it went: one of the
 * completion block's `findingsPost` values, or undefined when there is no
 * findings URL and so nothing to post. Never throws: a failure of the run's
 * own, such as the payload failing to build, is `error`, so `unreachable`
 * only ever means the receiver gave no answer.
 *
 * The payload is built before the identity token is requested, so a run that
 * cannot build one mints no token, and `payload` is a function so a review with
 * no usable URL builds nothing.
 */
// spec: FPOST
export async function deliverFindings({
  findingsUrl,
  payload,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  sleep,
  attemptMs,
  log = console.log,
}) {
  const url = findingsTarget(findingsUrl);
  if (url === undefined) return undefined;
  const deadline = now() + FINDINGS_POST_TOTAL_MS;
  try {
    if (!url) {
      log("::warning::findings-url is not an https URL; not posting findings");
      return "invalid-url";
    }
    let body;
    try {
      body = JSON.stringify(payload());
      if (typeof body !== "string") throw new Error("the payload builder returned nothing");
    } catch (err) {
      log(`::error::Could not build the findings payload, so nothing was sent: ${logMessage(err, url)}`);
      return "error";
    }
    const token = await requestIdentityToken({ audience: url.origin, env, fetchImpl, now, deadline, sleep, log });
    if (!token) {
      log(
        "::warning::No identity token, so findings are not posted. The caller workflow needs `permissions: id-token: write`, and a pull request from a fork never gets one",
      );
      return "no-token";
    }
    const { status, detail } = await postFindings({
      url,
      body,
      token,
      fetchImpl,
      now,
      sleep,
      attemptMs,
      deadline,
      log,
    });
    // The origin alone: a caller may put a secret in the path.
    const where = url.origin;
    log(
      status === "accepted"
        ? `Posted findings to ${where}: ${detail}`
        : `::warning::Findings post to ${where} ${status}: ${detail}`,
    );
    return status;
  } catch (err) {
    // The review's comments do not wait on this.
    log(`::error::Posting findings failed before an answer could come: ${logMessage(err, url)}`);
    return "error";
  }
}
