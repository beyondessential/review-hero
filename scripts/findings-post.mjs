/**
 * Review Hero — Posting findings and reading earlier rejections
 *
 * Sends a round's findings, as JSON, to the URL the caller named, and reads the
 * pull request's earlier rejections back from it, each authenticated by a
 * GitHub Actions identity token whose audience is that URL's origin. The
 * receiver checks the token with GitHub, so it shares no secret with the
 * caller. Neither a post that does not land nor a read that does not answer
 * fails the review: this module reports how it went and the orchestrator
 * carries on.
 */

import { oneLine } from "./lib.mjs";
import { parseRejections } from "../src/index.mjs";

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
/** Reading earlier rejections, the token request and the read with their retries, is over by this time. */
export const REJECTIONS_READ_TOTAL_MS = 30_000;
/** Earlier rejections a read asks for, the most a receiver gives. */
export const REJECTIONS_READ_LIMIT = 200;
/** The most of a rejections answer read before it counts as malformed. */
const REJECTIONS_READ_MAX_BYTES = 4 * 1024 * 1024;

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

/** A 2xx to a post: the findings were accepted. */
async function accepted(response) {
  await response.body?.cancel().catch(() => {});
  return { status: "accepted", retry: false, detail: `status ${response.status}` };
}

/**
 * One request to the findings URL's origin, following same-origin 307 and 308
 * redirects. Any other redirect is not followed, so the token only ever goes to
 * the origin it is addressed to, and counts as refused. `url` is the findings
 * URL, whose origin bounds the redirects and whose secret parts are kept out of
 * the log; `start` is where the request goes first, `url` unless given.
 *
 * Resolves with `{ status, retry, detail }`: what `onOk` makes of a 2xx (by
 * default `accepted`), `refused` when the receiver answered with anything else,
 * `unreachable` when no answer came. A refusal is worth a retry only when it is
 * a server error. The time limit covers `onOk` reading the reply.
 */
async function attempt({ url, start = url, token, method = "POST", body, fetchImpl, timeoutMs, onOk = accepted }) {
  const origin = url.origin;
  const signal = AbortSignal.timeout(timeoutMs);
  let target = start;
  const headers =
    method === "POST"
      ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
      : { Authorization: `Bearer ${token}`, Accept: "application/json" };
  try {
    for (let hops = 0; ; hops++) {
      const response = await fetchImpl(target, { method, redirect: "manual", headers, body, signal });
      const { status } = response;
      if (status >= 200 && status < 300) return await onOk(response);
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
  return withRetry({
    label: "Posting findings",
    once: (timeoutMs) => attempt({ url, token, body, fetchImpl, timeoutMs }),
    now,
    sleep,
    attemptMs,
    deadline,
    log,
  });
}

/**
 * Run `once(timeoutMs)`, an attempt, and run it once more when its result asks
 * for a retry and one fits before `deadline`. However long the token took, the
 * first attempt gets at least the time a retry would. The result is the last
 * attempt's.
 */
async function withRetry({ label, once, now, sleep, attemptMs, deadline, log }) {
  const firstMs = Math.min(attemptMs, Math.max(FINDINGS_POST_MIN_RETRY_MS, deadline - now()));
  let result = await once(firstMs);
  if (result.retry) {
    // Decided before the pause, so a retry that cannot fit costs no wait.
    const left = deadline - now() - FINDINGS_POST_RETRY_DELAY_MS;
    if (left >= FINDINGS_POST_MIN_RETRY_MS) {
      log(`::warning::${label}: ${result.detail}; trying once more`);
      await sleep(FINDINGS_POST_RETRY_DELAY_MS);
      result = await once(Math.min(attemptMs, deadline - now()));
    } else {
      log(`::warning::${label}: ${result.detail}; too little time left to try again`);
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

/**
 * Read a reply's body as text, refusing one over `maxBytes`: the receiver is
 * whatever the caller named, and could send a body of any size.
 */
async function boundedText(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * A 2xx to a read: `answered` with the rejections when it is a 200 whose body
 * is a rejections answer, `malformed` when it is a 200 with anything else, and
 * `refused` for any other 2xx.
 */
async function rejectionsAnswer(response) {
  const { status } = response;
  if (status !== 200) {
    await response.body?.cancel().catch(() => {});
    return { status: "refused", retry: false, detail: `status ${status}` };
  }
  const text = await boundedText(response, REJECTIONS_READ_MAX_BYTES);
  if (text === null) return { status: "malformed", retry: false, detail: "the answer is too large" };
  let parsed = null;
  try {
    parsed = parseRejections(JSON.parse(text));
  } catch {
    // Not JSON: malformed below.
  }
  if (!parsed) return { status: "malformed", retry: false, detail: "the answer is not a version 1 list of rejections" };
  return { status: "answered", retry: false, detail: `status ${status}`, ...parsed };
}

/**
 * Read the pull request's earlier rejections from `findingsUrl`, with a `GET`
 * naming the pull request, and say how it went: `{ status, rejections }`, where
 * `status` is one of the completion block's `rejectionsRead` values and
 * `rejections` is empty unless it is `answered`. Undefined when there is no
 * findings URL and so nothing to read. Never throws: a read that does not
 * answer leaves the review to carry on without earlier rejections.
 */
// spec: REJ#reading-them
export async function readRejections({
  findingsUrl,
  prNumber,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attemptMs = FINDINGS_POST_ATTEMPT_MS,
  log = console.log,
}) {
  const url = findingsTarget(findingsUrl);
  if (url === undefined) return undefined;
  const none = (status) => ({ status, rejections: [] });
  const deadline = now() + REJECTIONS_READ_TOTAL_MS;
  try {
    if (!url) {
      log("::warning::findings-url is not an https URL; not reading earlier rejections");
      return none("invalid-url");
    }
    const pr = Number(prNumber);
    if (!Number.isInteger(pr) || pr <= 0) {
      log("::error::Not reading earlier rejections: the pull request number is not a positive integer");
      return none("error");
    }
    const token = await requestIdentityToken({ audience: url.origin, env, fetchImpl, now, deadline, sleep, log });
    if (!token) {
      log(
        "::warning::No identity token, so earlier rejections are not read. The caller workflow needs `permissions: id-token: write`, and a pull request from a fork never gets one",
      );
      return none("no-token");
    }
    const start = new URL(url);
    start.searchParams.set("pr", String(pr));
    start.searchParams.set("limit", String(REJECTIONS_READ_LIMIT));
    const result = await withRetry({
      label: "Reading earlier rejections",
      once: (timeoutMs) =>
        attempt({ url, start, token, method: "GET", fetchImpl, timeoutMs, onOk: rejectionsAnswer }),
      now,
      sleep,
      attemptMs,
      deadline,
      log,
    });
    // The origin alone: a caller may put a secret in the path.
    const where = url.origin;
    if (result.status !== "answered") {
      log(`::warning::Reading earlier rejections from ${where} ${result.status}: ${result.detail}; reviewing without them`);
      return none(result.status);
    }
    const { rejections, skipped, matched, truncated } = result;
    const count = `${rejections.length} earlier rejection${rejections.length === 1 ? "" : "s"}`;
    const notes = [
      ...(truncated ? [`${matched} in all`] : []),
      ...(skipped > 0 ? [`${skipped} of the wrong shape left out`] : []),
    ];
    log(`Read ${count} from ${where}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`);
    return { status: "answered", rejections };
  } catch (err) {
    // The review does not wait on this.
    log(`::error::Reading earlier rejections failed before an answer could come: ${logMessage(err, url)}`);
    return none("error");
  }
}
