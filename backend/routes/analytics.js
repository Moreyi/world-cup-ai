import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";

const VALID_EVENTS = new Set([
  "page_view_worldcup",
  "match_card_click",
  "match_detail_view",
  "analysis_scroll_50",
  "analysis_scroll_90",
  "prediction_section_view",
  "unlock_button_click",
  "prediction_revealed",
  "post_match_review_view",
  "share_click",
  "follow_click",
  "ad_slot_view",
  "return_visit"
]);

const DATA_DIR = path.resolve(process.cwd(), process.env.ANALYTICS_DATA_DIR || ".data");
const EVENTS_FILE = path.join(DATA_DIR, "analytics_events.jsonl");

export function createAnalyticsRouter() {
  const router = express.Router();

  router.get("/analytics/config", (req, res) => {
    const id = process.env.GA_MEASUREMENT_ID || "";
    res.json({
      gaEnabled: Boolean(id),
      gaMeasurementId: id,
      internalAnalyticsEnabled: true
    });
  });

  router.post("/analytics/event", async (req, res) => {
    const body = req.body || {};
    const eventName = String(body.event_name || "").trim();
    // Reject unknown/empty events (rate limiting is enforced per-IP upstream).
    if (!eventName || !VALID_EVENTS.has(eventName)) {
      return res.status(400).json({ error: "invalid event_name" });
    }

    const row = {
      id: crypto.randomUUID(),
      event_name: eventName,
      page_path: clean(body.page_path, 300),
      page_type: clean(body.page_type, 40),
      match_id: clean(body.match_id, 140),
      session_id: clean(body.session_id, 140),
      metadata: sanitizeMetadata(body.metadata),
      user_agent_hash: hash(req.get("user-agent") || ""),
      referrer: clean(body.referrer || req.get("referer") || "", 500),
      created_at: new Date().toISOString()
    };

    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.appendFile(EVENTS_FILE, JSON.stringify(row) + "\n", "utf8");
    } catch (error) {
      console.error("[analytics:event]", error.message);
    }

    res.json({ ok: true });
  });

  router.get("/admin/worldcup-growth/summary", async (req, res) => {
    res.json(await buildSummary());
  });

  return router;
}

async function buildSummary() {
  const rows = await readRows();
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const todayRows = rows.filter((row) => String(row.created_at || "").startsWith(todayPrefix));

  const today = {
    events: todayRows.length,
    page_views: count(todayRows, "page_view_worldcup"),
    unique_sessions: unique(todayRows, "session_id"),
    match_detail_views: count(todayRows, "match_detail_view"),
    match_card_clicks: count(todayRows, "match_card_click"),
    prediction_section_views: count(todayRows, "prediction_section_view"),
    unlock_clicks: count(todayRows, "unlock_button_click"),
    prediction_revealed: count(todayRows, "prediction_revealed"),
    follow_clicks: count(todayRows, "follow_click"),
    share_clicks: count(todayRows, "share_click"),
    ad_slot_views: count(todayRows, "ad_slot_view"),
    post_match_review_views: count(todayRows, "post_match_review_view")
  };

  const homepageViews = rows.filter((row) => row.event_name === "page_view_worldcup" && row.page_type === "home").length;
  const matchCardClicks = count(rows, "match_card_click");
  const matchDetailViews = count(rows, "match_detail_view");
  const predictionViews = count(rows, "prediction_section_view");
  const unlockClicks = count(rows, "unlock_button_click");
  const followClicks = count(rows, "follow_click");
  const shareClicks = count(rows, "share_click");

  return {
    today,
    top_matches: topBy(rows.filter((row) => row.match_id), "match_id", 10),
    funnel: {
      homepage_views: homepageViews,
      match_card_click_rate: rate(matchCardClicks, homepageViews),
      prediction_section_view_rate: rate(predictionViews, matchDetailViews),
      unlock_intent_rate: rate(unlockClicks, predictionViews),
      follow_rate: rate(followClicks + shareClicks, unlockClicks || predictionViews || matchDetailViews)
    },
    popular_pages: topBy(rows.filter((row) => row.event_name === "page_view_worldcup"), "page_path", 10),
    referrers: topBy(rows.filter((row) => row.referrer), "referrer", 10),
    finished_match_reviews: topReviewRows(rows),
    last_updated: new Date().toISOString()
  };
}

async function readRows() {
  try {
    const raw = await fs.readFile(EVENTS_FILE, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function topReviewRows(rows) {
  const reviews = rows.filter((row) => row.event_name === "post_match_review_view");
  const grouped = new Map();
  for (const row of reviews) {
    const current = grouped.get(row.match_id) || { label: row.match_id || "unknown", value: 0, metadata: {} };
    current.value += 1;
    current.metadata = { ...current.metadata, ...(row.metadata || {}) };
    grouped.set(row.match_id, current);
  }
  return Array.from(grouped.values()).sort((a, b) => b.value - a.value).slice(0, 10).map((row) => ({
    label: [
      row.label,
      row.metadata.result_correct ? `correct: ${row.metadata.result_correct}` : "",
      row.metadata.score_error ? `score error: ${row.metadata.score_error}` : "",
      row.metadata.model_grade ? `grade: ${row.metadata.model_grade}` : ""
    ].filter(Boolean).join(" · "),
    value: row.value
  }));
}

function topBy(rows, key, limit) {
  const counts = new Map();
  for (const row of rows) {
    const label = row[key];
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, limit);
}

function count(rows, eventName) {
  return rows.filter((row) => row.event_name === eventName).length;
}

function unique(rows, key) {
  return new Set(rows.map((row) => row[key]).filter(Boolean)).size;
}

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function sanitizeMetadata(input) {
  const allowed = new Set([
    "page_path", "page_type", "match_id", "match_status", "home_team", "away_team",
    "group_name", "is_locked", "rewarded_enabled", "ad_unlock_state", "predicted_score",
    "confidence", "prediction_confidence", "trust_score", "result_correct", "score_error",
    "model_grade", "platform", "channel", "ad_slot_name", "is_returning"
  ]);
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).filter(([key]) => allowed.has(key)).map(([key, value]) => [
    key,
    typeof value === "string" ? value.slice(0, 500) : value
  ]));
}

function clean(value, max) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, max);
}

function hash(value) {
  if (!value) return "";
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}
