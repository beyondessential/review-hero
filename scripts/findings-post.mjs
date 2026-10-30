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

/** The whole post, retry included, is over by this time. */
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
 * The start of a reply, read only as far as the excerpt needs: the receiver is
 * whatever the caller named, and could send a body of any size.
 */
async function replyExcerpt(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < REPLY_EXCERPT) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return oneLine(text.slice(0, REPLY_EXCERPT));
}

/** The findings URL as a URL, or null unless it is an `https` URL. */
// spec: FPOST#turning-it-on
export function parseFindingsUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Ask GitHub Actions for an identity token addressed to `audience`. Null when
 * the job was not granted permission to request one (a caller without
 * `id-token: write`, or a pull request from a fork) or the request fails.
 */
// spec: FPOST#authentication
export async function requestIdentityToken({
  audience,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = IDENTITY_TOKEN_TIMEOUT_MS,
  log = console.log,
}) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return null;
  try {
    const url = new URL(requestUrl);
    url.searchParams.set("audience", audience);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      log(`::warning::Identity token request failed with status ${response.status}`);
      return null;
    }
    const { value } = await response.json();
    if (typeof value !== "string" || !value) {
      log("::warning::Identity token request returned no token");
      return null;
    }
    // Anything that later prints the token prints it masked.
    log(`::add-mask::${value}`);
    return value;
  } catch (err) {
    log(`::warning::Identity token request failed: ${err.message}`);
    return null;
  }
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
        reply = await replyExcerpt(response);
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
    return { status: "unreachable", retry: true, detail: err.name === "TimeoutError" ? "timed out" : err.message };
  }
}

/**
 * Post `payload` to `url` with `token` as the bearer, trying once more after no
 * answer or a server error, all within `FINDINGS_POST_TOTAL_MS`. The result is
 * the last attempt's.
 */
// spec: FPOST#when-a-review-posts
export async function postFindings({
  url,
  payload,
  token,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attemptMs = FINDINGS_POST_ATTEMPT_MS,
  log = console.log,
}) {
  const body = JSON.stringify(payload);
  const deadline = now() + FINDINGS_POST_TOTAL_MS;
  let result = await attempt({ url, token, body, fetchImpl, timeoutMs: attemptMs });
  if (result.retry) {
    log(`::warning::Posting findings: ${result.detail}; trying once more`);
    await sleep(FINDINGS_POST_RETRY_DELAY_MS);
    const left = deadline - now();
    if (left >= FINDINGS_POST_MIN_RETRY_MS) {
      result = await attempt({ url, token, body, fetchImpl, timeoutMs: Math.min(attemptMs, left) });
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
 * The identity token is requested only once the URL has passed, and `payload`
 * is a function so a review that posts nothing builds nothing.
 */
// spec: FPOST
export async function deliverFindings({
  findingsUrl,
  payload,
  env = process.env,
  fetchImpl = fetch,
  now,
  sleep,
  attemptMs,
  log = console.log,
}) {
  const raw = (findingsUrl ?? "").trim();
  if (!raw) return undefined;
  try {
    const url = parseFindingsUrl(raw);
    if (!url) {
      log("::warning::findings-url is not an https URL; not posting findings");
      return "invalid-url";
    }
    const token = await requestIdentityToken({ audience: url.origin, env, fetchImpl, log });
    if (!token) {
      log(
        "::warning::No identity token, so findings are not posted. The caller workflow needs `permissions: id-token: write`, and a pull request from a fork never gets one",
      );
      return "no-token";
    }
    let built;
    try {
      built = payload();
    } catch (err) {
      log(`::error::Could not build the findings payload, so nothing was sent: ${err.message}`);
      return "error";
    }
    const { status, detail } = await postFindings({
      url,
      payload: built,
      token,
      fetchImpl,
      now,
      sleep,
      attemptMs,
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
    log(`::error::Posting findings failed before an answer could come: ${err.message}`);
    return "error";
  }
}
