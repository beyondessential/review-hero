import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deliverFindings,
  FINDINGS_POST_MAX_REDIRECTS,
  FINDINGS_POST_TOTAL_MS,
  parseFindingsUrl,
  postFindings,
  requestIdentityToken,
} from "./findings-post.mjs";

const URL_OK = "https://workhorse.example/api/rounds";
const ENV = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token?api=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-secret" };
const quiet = () => {};
const noSleep = async () => {};

const reply = (status, { body = "", headers = {} } = {}) =>
  new Response(status === 204 ? null : body, { status, headers });

/**
 * A fake `fetch`: token requests (a GET to the Actions URL) always succeed,
 * and each post is answered by the next of `answers`, which may throw. Every
 * call is recorded.
 */
function fakeFetch(answers, { token = "jwt-token" } = {}) {
  const calls = [];
  const queue = [...answers];
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    calls.push({ url: target, init });
    if (target.origin === "https://actions.example") return Response.json({ value: token });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? reply(200);
  };
  return { fetchImpl, calls, posts: () => calls.filter((c) => c.url.origin !== "https://actions.example") };
}

const payload = () => ({ schema: 1, findings: [] });
const deliver = (fake, over = {}) =>
  deliverFindings({ findingsUrl: URL_OK, payload, env: ENV, fetchImpl: fake.fetchImpl, sleep: noSleep, log: quiet, ...over });

// spec: FPOST#turning-it-on
test("a findings URL must be https", () => {
  assert.equal(parseFindingsUrl(URL_OK).origin, "https://workhorse.example");
  for (const bad of ["http://workhorse.example/x", "ftp://x/y", "workhorse.example/x", "not a url", "javascript:alert(1)"]) {
    assert.equal(parseFindingsUrl(bad), null, bad);
  }
});

// spec: FPOST#turning-it-on
test("no findings URL posts nothing and requests no token", async () => {
  const fake = fakeFetch([]);
  for (const findingsUrl of [undefined, "", "   "]) {
    assert.equal(await deliver(fake, { findingsUrl }), undefined);
  }
  assert.equal(fake.calls.length, 0);
});

// spec: FPOST#turning-it-on
test("a URL that is not https posts nothing, requests no token, and says so in the log", async () => {
  const fake = fakeFetch([]);
  const lines = [];
  assert.equal(await deliver(fake, { findingsUrl: "http://workhorse.example/x", log: (l) => lines.push(l) }), "invalid-url");
  assert.equal(fake.calls.length, 0);
  assert.match(lines.join("\n"), /not an https URL/);
});

// spec: FPOST#turning-it-on
test("a job that cannot request an identity token reports no-token and posts nothing", async () => {
  const fake = fakeFetch([]);
  assert.equal(await deliver(fake, { env: {} }), "no-token");
  assert.equal(await deliver(fake, { env: { ACTIONS_ID_TOKEN_REQUEST_URL: ENV.ACTIONS_ID_TOKEN_REQUEST_URL } }), "no-token");
  assert.equal(fake.calls.length, 0);
});

// spec: FPOST#authentication
test("the token is requested with the findings URL's origin as its audience, and sent as the bearer", async () => {
  const fake = fakeFetch([reply(200)]);
  assert.equal(await deliver(fake, { findingsUrl: "https://workhorse.example/api/rounds?x=1" }), "accepted");
  const [tokenRequest] = fake.calls;
  assert.equal(tokenRequest.url.searchParams.get("audience"), "https://workhorse.example");
  assert.equal(tokenRequest.url.searchParams.get("api"), "1");
  assert.equal(tokenRequest.init.headers.Authorization, "Bearer req-secret");
  const [post] = fake.posts();
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.headers.Authorization, "Bearer jwt-token");
  assert.equal(post.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(post.init.body), payload());
});

test("a failed token request is no-token, and a token is masked in the log", async () => {
  const failing = async () => reply(403);
  assert.equal(await requestIdentityToken({ audience: "https://x", env: ENV, fetchImpl: failing, log: quiet }), null);
  const lines = [];
  const token = await requestIdentityToken({ audience: "https://x", env: ENV, fetchImpl: fakeFetch([]).fetchImpl, log: (l) => lines.push(l) });
  assert.equal(token, "jwt-token");
  assert.deepEqual(lines, ["::add-mask::jwt-token"]);
  const throwing = async () => {
    throw new Error("boom");
  };
  assert.equal(await requestIdentityToken({ audience: "https://x", env: ENV, fetchImpl: throwing, log: quiet }), null);
});

// spec: FPOST#when-a-review-posts
test("a 2xx is accepted, and any other answer is refused without a retry unless it is a server error", async () => {
  for (const status of [200, 201, 204]) assert.equal(await deliver(fakeFetch([reply(status)])), "accepted", String(status));
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const fake = fakeFetch([reply(status)]);
    assert.equal(await deliver(fake), "refused", String(status));
    assert.equal(fake.posts().length, 1, `${status} is not retried`);
  }
});

// spec: FPOST#when-a-review-posts
test("no answer, or a server error, is tried once more, and the retry's result is how the post went", async () => {
  const flaky = fakeFetch([new Error("connection reset"), reply(200)]);
  assert.equal(await deliver(flaky), "accepted");
  assert.equal(flaky.posts().length, 2);

  const recovered = fakeFetch([reply(503), reply(200)]);
  assert.equal(await deliver(recovered), "accepted");

  const down = fakeFetch([new Error("refused"), new Error("still refused"), reply(200)]);
  assert.equal(await deliver(down), "unreachable");
  assert.equal(down.posts().length, 2, "only one retry");

  const broken = fakeFetch([reply(500), reply(502), reply(200)]);
  assert.equal(await deliver(broken), "refused");
  assert.equal(broken.posts().length, 2);

  const worse = fakeFetch([reply(503), new Error("gone")]);
  assert.equal(await deliver(worse), "unreachable");
});

// spec: FPOST#when-a-review-posts
test("the whole post is bounded: a retry starts only with enough of the total left", async () => {
  let clock = 0;
  const fake = fakeFetch([reply(503), reply(200)]);
  const result = await postFindings({
    url: new URL(URL_OK),
    payload: payload(),
    token: "t",
    fetchImpl: fake.fetchImpl,
    now: () => clock,
    // The first attempt and the pause between them used up the budget.
    sleep: async () => {
      clock += FINDINGS_POST_TOTAL_MS;
    },
    log: quiet,
  });
  assert.equal(result.status, "refused");
  assert.equal(fake.posts().length, 1);
});

test("the log says a retry is coming only when one runs, and says when one was skipped", async () => {
  const run = async (spent) => {
    let clock = 0;
    const lines = [];
    await postFindings({
      url: new URL(URL_OK),
      payload: payload(),
      token: "t",
      fetchImpl: fakeFetch([reply(503), reply(200)]).fetchImpl,
      now: () => clock,
      sleep: async () => {
        clock += spent;
      },
      log: (l) => lines.push(l),
    });
    return lines.join("\n");
  };
  const retried = await run(0);
  assert.match(retried, /trying once more/);
  const skipped = await run(FINDINGS_POST_TOTAL_MS);
  assert.doesNotMatch(skipped, /trying once more/);
  assert.match(skipped, /too little time left/);
});

// spec: FPOST#when-a-review-posts
test("an attempt that gets no answer in time is unreachable", async () => {
  const hangs = (_url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const fake = { calls: 0 };
  const counting = (...args) => {
    fake.calls++;
    return hangs(...args);
  };
  const result = await postFindings({ url: new URL(URL_OK), payload: payload(), token: "t", fetchImpl: counting, attemptMs: 20, sleep: noSleep, log: quiet });
  assert.equal(result.status, "unreachable");
  assert.match(result.detail, /timed out/);
  assert.equal(fake.calls, 2, "no answer is retried once");
});

// spec: FPOST#when-a-review-posts
test("a 307 or 308 to the findings URL's own origin is followed, with the token and the body", async () => {
  for (const status of [307, 308]) {
    const fake = fakeFetch([reply(status, { headers: { location: "/v2/rounds" } }), reply(200)]);
    assert.equal(await deliver(fake), "accepted", String(status));
    const [first, second] = fake.posts();
    assert.equal(first.init.redirect, "manual");
    assert.equal(second.url.href, "https://workhorse.example/v2/rounds");
    assert.equal(second.init.headers.Authorization, "Bearer jwt-token");
    assert.equal(second.init.body, first.init.body);
  }
});

// spec: FPOST#when-a-review-posts
test("any other redirect is not followed, and the token goes nowhere else", async () => {
  const cases = [
    reply(307, { headers: { location: "https://evil.example/steal" } }),
    reply(308, { headers: { location: "http://workhorse.example/downgraded" } }),
    reply(302, { headers: { location: "/elsewhere" } }),
    reply(301, { headers: { location: "/elsewhere" } }),
    reply(303, { headers: { location: "/elsewhere" } }),
    reply(307),
  ];
  for (const answer of cases) {
    const fake = fakeFetch([answer, reply(200)]);
    assert.equal(await deliver(fake), "refused", `${answer.status} ${answer.headers.get("location")}`);
    assert.equal(fake.posts().length, 1);
    assert.ok(fake.posts().every((c) => c.url.origin === "https://workhorse.example"));
  }
});

// spec: FPOST#when-a-review-posts
test("redirects are followed only a few times", async () => {
  const loop = Array.from({ length: 10 }, () => reply(307, { headers: { location: "/again" } }));
  const fake = fakeFetch(loop);
  assert.equal(await deliver(fake), "refused");
  assert.equal(fake.posts().length, FINDINGS_POST_MAX_REDIRECTS + 1);
});

// spec: FPOST#when-a-review-posts
test("the log says how the post went, with the status and start of the reply when refused", async () => {
  const lines = [];
  const body = `first line\nsecond line ${"x".repeat(250)}${"y".repeat(100)}`;
  assert.equal(await deliver(fakeFetch([reply(422, { body })]), { log: (l) => lines.push(l) }), "refused");
  const warning = lines.find((l) => l.includes("refused"));
  assert.match(warning, /^::warning::/);
  assert.match(warning, /status 422/);
  assert.match(warning, /first line second line xxxx/);
  assert.ok(!warning.includes("\n"));
  assert.ok(!warning.includes("yyyyyyyyyy"), "only the start of the reply");
  assert.ok(!lines.join("\n").includes("jwt-token") || lines.some((l) => l.startsWith("::add-mask::")));

  const ok = [];
  await deliver(fakeFetch([reply(200)]), { log: (l) => ok.push(l) });
  assert.ok(ok.some((l) => /Posted findings to https:\/\/workhorse\.example: status 200/.test(l)));
});

// spec: FPOST#when-a-review-posts
test("the log names the receiver's origin, never the URL's path", async () => {
  const lines = [];
  await deliver(fakeFetch([reply(200)]), { findingsUrl: "https://workhorse.example/hook/s3cret", log: (l) => lines.push(l) });
  await deliver(fakeFetch([reply(403)]), { findingsUrl: "https://workhorse.example/hook/s3cret", log: (l) => lines.push(l) });
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => !l.includes("s3cret")));
});

test("a refused reply is read only as far as the log needs", async () => {
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new TextEncoder().encode("z".repeat(64)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fake = fakeFetch([new Response(endless, { status: 400 })]);
  assert.equal(await deliver(fake), "refused");
  assert.ok(pulled < 10, `read ${pulled} chunks`);
  assert.ok(cancelled);
});

// spec: FPOST#when-a-review-posts
test("a payload that fails to build sends nothing and reports error, not unreachable", async () => {
  const fake = fakeFetch([]);
  const lines = [];
  const result = await deliver(fake, {
    payload: () => {
      throw new Error("bad payload");
    },
    log: (l) => lines.push(l),
  });
  assert.equal(result, "error");
  assert.equal(fake.posts().length, 0);
  assert.match(lines.join("\n"), /::error::.*nothing was sent: bad payload/);
});

test("a failure of the run's own after the token never throws and reports error", async () => {
  const fake = fakeFetch([]);
  const circular = {};
  circular.self = circular;
  assert.equal(await deliver(fake, { payload: () => circular }), "error");
  assert.equal(fake.posts().length, 0);
});
