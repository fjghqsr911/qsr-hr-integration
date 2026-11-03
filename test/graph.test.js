/* Graph client with a stubbed fetch: paging, headers, retries, timeout, no-op writes, errors without tokens or bodies. */
const path = require("path");
const { DIST, test, report, assert, eq } = require("./helpers");

module.exports = async () => {
  const { GraphClient, GraphError, USER_SELECT, retryAfterMs } = require(path.join(DIST, "shared", "graph.js"));
  const TOKEN = "eyJ-secret-token-value";

  /** A fetch stub fed by a queue of responses (status, body, headers) or a function of the request. */
  const makeFetch = (script) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body), signal: init.signal });
      const step = typeof script === "function" ? script(calls.length, url, init) : script[Math.min(calls.length - 1, script.length - 1)];
      if (step instanceof Error) throw step;
      if (step.hang) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      const text = step.body === undefined ? "" : JSON.stringify(step.body);
      return { ok: step.status < 400, status: step.status, headers: { get: (k) => (step.headers ?? {})[k.toLowerCase()] ?? null }, text: async () => text };
    };
    return { fetchImpl, calls };
  };
  const sleeps = [];
  let clock = 1_000_000;
  const client = (script, over = {}) => {
    const f = makeFetch(script);
    const c = new GraphClient({ baseUrl: "https://graph.test/v1.0", getToken: async () => TOKEN, fetchImpl: f.fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, now: () => clock, timeoutMs: 20, ...over });
    return { c, calls: f.calls };
  };
  const reset = () => { sleeps.length = 0; };

  await test("graph: listUsers filters per domain with ConsistencyLevel eventual + $count + the $select list, follows @odata.nextLink, drops guests, lower-cases ids", async () => {
    reset();
    const { c, calls } = client([
      { status: 200, body: { value: [{ id: "AAA", userPrincipalName: "pat@qsrgroup.ca", accountEnabled: true, userType: "Member" }, { id: "GGG", userPrincipalName: "g_x#EXT#@qsrgroup.ca", userType: "Guest" }], "@odata.nextLink": "https://graph.test/v1.0/users?$skiptoken=abc" } },
      { status: 200, body: { value: [{ id: "BBB", mail: "sam@qsrgroup.ca", accountEnabled: false, onPremisesSyncEnabled: true }] } }
    ]);
    const users = await c.listUsers("QSRGroup.ca");
    eq(users.map(u => u.id), ["aaa", "bbb"]);
    eq(users[1], { id: "bbb", userPrincipalName: null, mail: "sam@qsrgroup.ca", displayName: null, jobTitle: null, department: null, officeLocation: null, accountEnabled: false, employeeId: null, userType: null, onPremisesSyncEnabled: true });
    eq(calls.length, 2);
    assert(calls[0].url.startsWith("https://graph.test/v1.0/users?$filter="), calls[0].url);
    assert(decodeURIComponent(calls[0].url).includes("endsWith(userPrincipalName,'@qsrgroup.ca') or endsWith(mail,'@qsrgroup.ca')"), calls[0].url);
    assert(calls[0].url.includes("$count=true") && calls[0].url.includes(`$select=${USER_SELECT}`) && calls[0].url.includes("$top=999"), calls[0].url);
    eq(calls[0].headers.ConsistencyLevel, "eventual"); eq(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    eq(calls[1].url, "https://graph.test/v1.0/users?$skiptoken=abc", "nextLink used as-is");
    eq(c.callCount, 2);
  });
  await test("graph: 429 / 503 / 504 retried honouring Retry-After (seconds or HTTP date), at most 3 retries then GraphError with status + code only", async () => {
    reset(); clock = 1_000_000;
    let { c } = client([{ status: 429, headers: { "retry-after": "5" }, body: { error: { code: "TooManyRequests", message: "Throttled: user pat@qsrgroup.ca" } } }, { status: 200, body: { value: [] } }]);
    eq(await c.listGroups(), []); eq(sleeps, [5000]);
    reset();
    ({ c } = client([{ status: 503, headers: { "retry-after": new Date(clock + 7000).toUTCString() } }, { status: 200, body: { value: [] } }]));
    await c.listGroups(); assert(sleeps[0] >= 6000 && sleeps[0] <= 7000, String(sleeps[0]));
    reset();
    ({ c } = client([{ status: 504 }]));
    let err = null; try { await c.listGroups(); } catch (e) { err = e; }
    assert(err instanceof GraphError, "GraphError"); eq([err.status, err.code], [504, null]); eq(sleeps, [1000, 2000, 3000], "3 retries with backoff when no Retry-After");
    eq(retryAfterMs(null, 0), null); eq(retryAfterMs("abc", 0), null); eq(retryAfterMs("2", 0), 2000);
    reset();
    ({ c } = client([{ status: 403, body: { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges; token eyJ-secret-token-value" } } }]));
    err = null; try { await c.getUser("u1"); } catch (e) { err = e; }
    eq([err.status, err.code, err.message], [403, "Authorization_RequestDenied", "Graph 403 on GET /users/u1: Authorization_RequestDenied"]);
    assert(!err.message.includes("Insufficient") && !err.message.includes(TOKEN), "errors never carry the body or the token");
    eq(sleeps, [], "4xx is not retried");
  });
  await test("graph: 20 s timeout aborts the call -> GraphError code timeout, not retried; network errors retried then GraphError", async () => {
    reset();
    let { c } = client([{ hang: true }]);
    let err = null; try { await c.listGroups(); } catch (e) { err = e; }
    eq([err.status, err.code], [0, "timeout"]); eq(sleeps, []);
    assert(/^Graph timeout on GET \/groups$/.test(err.message), err.message);
    reset();
    ({ c } = client(Object.assign(new Error("ECONNRESET"), { name: "FetchError" })));
    err = null; try { await c.listGroups(); } catch (e) { err = e; }
    eq([err.status, err.code], [0, "network"]); eq(sleeps.length, 3);
  });
  await test("graph: error paths never include the query string (filters, select) in the message", async () => {
    const { c } = client([{ status: 400, body: { error: { code: "Request_UnsupportedQuery" } } }]);
    let err = null; try { await c.listUsers("qsrgroup.ca"); } catch (e) { err = e; }
    eq(err.message, "Graph 400 on GET /users: Request_UnsupportedQuery");
  });
  await test("graph: getUser 404 -> null; patchUser sends one PATCH with the body; addGroupMember 400 already-exists -> exists; removeGroupMember 404 -> missing", async () => {
    let { c, calls } = client([{ status: 404, body: { error: { code: "Request_ResourceNotFound" } } }]);
    eq(await c.getUser("u1", "id,jobTitle"), null); assert(calls[0].url.endsWith("/users/u1?$select=id,jobTitle"));
    ({ c, calls } = client([{ status: 204 }]));
    await c.patchUser("u1", { jobTitle: "General Manager" });
    eq([calls[0].method, calls[0].url, calls[0].body, calls[0].headers["Content-Type"]], ["PATCH", "https://graph.test/v1.0/users/u1", { jobTitle: "General Manager" }, "application/json"]);
    ({ c, calls } = client([{ status: 204 }]));
    eq(await c.addGroupMember("g1", "u1"), "added");
    eq([calls[0].method, calls[0].url, calls[0].body], ["POST", "https://graph.test/v1.0/groups/g1/members/$ref", { "@odata.id": "https://graph.test/v1.0/directoryObjects/u1" }]);
    ({ c } = client([{ status: 400, body: { error: { code: "Request_BadRequest", message: "One or more added object references already exist for the following modified properties: 'members'." } } }]));
    eq(await c.addGroupMember("g1", "u1"), "exists");
    ({ c } = client([{ status: 400, body: { error: { code: "Request_BadRequest", message: "Invalid object identifier" } } }]));
    let err = null; try { await c.addGroupMember("g1", "u1"); } catch (e) { err = e; }
    eq(err.status, 400, "other 400s are errors");
    ({ c, calls } = client([{ status: 404, body: { error: { code: "Request_ResourceNotFound" } } }]));
    eq(await c.removeGroupMember("g1", "u1"), "missing"); eq([calls[0].method, calls[0].url], ["DELETE", "https://graph.test/v1.0/groups/g1/members/u1/$ref"]);
    ({ c, calls } = client([{ status: 204 }]));
    eq(await c.removeGroupMember("g1", "u1"), "removed");
    ({ c, calls } = client([{ status: 200, body: { value: [{ id: "U1" }, { id: "u2" }] } }]));
    eq(await c.listGroupMemberUserIds("g1"), ["u1", "u2"]); assert(calls[0].url.includes("/groups/g1/members/microsoft.graph.user?$select=id"), calls[0].url);
    ({ c, calls } = client([{ status: 200, body: { value: [{ id: "o1" }] } }]));
    assert(typeof await c.probeOrganization() === "number"); assert(calls[0].url.endsWith("/organization?$select=id"));
  });
  await test("graph: a token failure is a GraphError without the underlying message", async () => {
    const { c } = client([{ status: 200, body: {} }], { getToken: async () => { throw new Error("ManagedIdentityCredential: secret xyz"); } });
    let err = null; try { await c.listGroups(); } catch (e) { err = e; }
    eq([err.status, err.code], [0, "token_unavailable"]); assert(!err.message.includes("xyz"), err.message);
  });

  report("graph client");
};
