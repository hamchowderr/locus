import { createFakeGhl } from "@locus/testing";
import { expect, test } from "vitest";
import { defineOperation } from "./operation.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { GhlError, type GhlSession, ghlRequest, rateLimitKey } from "./request.ts";

const getContact = defineOperation({
  id: "contacts.get-contact",
  method: "GET",
  path: "/contacts/{contactId}",
  version: "v3",
  tokens: ["location"],
  scopes: ["contacts.readonly"],
});

const clientA: GhlSession = { token: "tok", tokenKind: "location", locationId: "loc-A" };
const clientB: GhlSession = { token: "tok", tokenKind: "location", locationId: "loc-B" };

/** A clock that only moves when the limiter sleeps, so waits are exact and instant. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

test("requests within the budget go straight through", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000, ...clock });
  for (let i = 0; i < 3; i++) await limiter.acquire("location:loc-A");
  expect(clock.sleeps).toEqual([]);
});

test("a request over the budget waits until the oldest one leaves the window", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, ...clock });
  await limiter.acquire("location:loc-A");
  clock.advance(300);
  await limiter.acquire("location:loc-A");
  await limiter.acquire("location:loc-A");
  // The first request started at 0, so the window frees at 1000; it is now 300.
  expect(clock.sleeps).toEqual([700]);
});

test("each client has its own budget", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, ...clock });
  await limiter.acquire("location:loc-A");
  await limiter.acquire("location:loc-B");
  expect(clock.sleeps).toEqual([]);
});

test("ghlRequest takes a slot from the session's client for every request", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, ...clock });
  const ghl = createFakeGhl({ "*": { body: { contact: {} } } });
  const get = (session: GhlSession) =>
    ghlRequest(
      getContact,
      session,
      { path: { contactId: "c1" } },
      {
        fetch: ghl.fetch,
        rateLimiter: limiter,
      },
    );

  await get(clientA);
  await get(clientB);
  await get(clientA);
  expect(clock.sleeps).toEqual([]);
  await get(clientA);
  expect(clock.sleeps).toEqual([1000]);
  expect(ghl.requests).toHaveLength(4);
});

test("a 429 pauses the client's whole budget for as long as GHL asks, without retrying", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 100, windowMs: 10_000, ...clock });
  let calls = 0;
  const ghl = createFakeGhl({
    "*": () =>
      ++calls === 1
        ? { status: 429, body: { message: "Too many requests" }, headers: { "retry-after": "3" } }
        : { body: { contact: {} } },
  });
  const options = { fetch: ghl.fetch, rateLimiter: limiter };

  await expect(
    ghlRequest(getContact, clientA, { path: { contactId: "c1" } }, options),
  ).rejects.toBeInstanceOf(GhlError);
  expect(ghl.requests).toHaveLength(1);

  // Another client is unaffected; the same client waits out the 3 seconds first.
  await ghlRequest(getContact, clientB, { path: { contactId: "c1" } }, options);
  expect(clock.sleeps).toEqual([]);
  await ghlRequest(getContact, clientA, { path: { contactId: "c1" } }, options);
  expect(clock.sleeps).toEqual([3000]);
});

test("agency tokens are budgeted per agency", () => {
  expect(rateLimitKey({ token: "t", tokenKind: "agency", companyId: "co-1" })).toBe("agency:co-1");
  expect(rateLimitKey(clientA)).toBe("location:loc-A");
});
