import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createDatabase } from "../backend/db/db.js";
import { mockProvider } from "../backend/providers/mockProvider.js";
import { createApp } from "../backend/server.js";

function testDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "worldcup-sec-db-"));
  return createDatabase({ filePath: path.join(dir, "db.json"), seed: false });
}

async function withServer(options = {}, callback) {
  const { app } = await createApp({
    db: testDb(),
    provider: mockProvider,
    initialSync: true,
    ...options
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    return await callback(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("MVP security hardening", () => {
  it("allows public API reads without an admin token", async () => {
    await withServer({}, async (base) => {
      const response = await fetch(`${base}/worldcup-api/matches`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
      const body = await response.json();
      assert.ok(body.matches.length > 0);
    });
  });

  it("blocks admin API writes without a token", async () => {
    await withServer({ adminToken: "unit-secret" }, async (base) => {
      const response = await fetch(`${base}/api/admin/sync`, { method: "POST" });
      assert.equal(response.status, 403);
    });
  });

  it("blocks admin API writes in production if ADMIN_TOKEN is missing", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAdminToken = process.env.ADMIN_TOKEN;
    process.env.NODE_ENV = "production";
    delete process.env.ADMIN_TOKEN;
    try {
      await withServer({ adminToken: "" }, async (base) => {
        const response = await fetch(`${base}/api/admin/sync`, { method: "POST" });
        assert.equal(response.status, 403);
      });
    } finally {
      if (previousNodeEnv == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousAdminToken == null) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = previousAdminToken;
    }
  });

  it("allows admin API writes with a valid token", async () => {
    await withServer({ adminToken: "unit-secret" }, async (base) => {
      const response = await fetch(`${base}/api/admin/sync`, {
        method: "POST",
        headers: { "x-admin-token": "unit-secret", "content-type": "application/json" },
        body: JSON.stringify({ type: "schedule" })
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(body.matches > 0);
    });
  });

  it("rejects unknown analytics events", async () => {
    await withServer({}, async (base) => {
      const response = await fetch(`${base}/api/analytics/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event_name: "unknown_event", session_id: "session_12345" })
      });
      assert.equal(response.status, 400);
    });
  });

  it("accepts and stores allowed analytics events without echoing raw identity", async () => {
    await withServer({}, async (base) => {
      const response = await fetch(`${base}/api/analytics/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event_name: "post_match_review_view",
          session_id: "session_12345",
          metadata: { page: "/worldcup/match/mexico-vs-south-africa/" }
        })
      });
      // Reconciled behaviour: the storing analytics router persists the event
      // and acknowledges with 200 {ok:true}; it never echoes IP/raw identity.
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(Object.hasOwn(body, "ip"), false);
    });
  });

  it("returns 429 when public API rate limit is exceeded", async () => {
    await withServer({ rateLimits: { public: 1, analytics: 30, admin: 10 } }, async (base) => {
      const first = await fetch(`${base}/api/matches`);
      const second = await fetch(`${base}/api/matches`);
      assert.equal(first.status, 200);
      assert.equal(second.status, 429);
    });
  });
});
