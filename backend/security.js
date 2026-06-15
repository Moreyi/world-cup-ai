import { timingSafeEqual } from "node:crypto";

const DEFAULT_ALLOWED_EVENTS = new Set([
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
  "ad_slot_view"
]);

export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
  };
}

export function corsGuard({ allowedOrigin = process.env.ALLOWED_ORIGIN || "https://renrenrenai.cn" } = {}) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();

    if (process.env.NODE_ENV === "production" && origin !== allowedOrigin) {
      return res.status(403).json({ error: "origin not allowed" });
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
}

export function createRateLimiter({ limit, windowMs = 60_000, keyPrefix = "default" }) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${clientKey(req)}`;
    const bucket = hits.get(key);

    if (!bucket || bucket.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: "rate limit exceeded" });
    }

    next();
  };
}

export function requireAdminToken({ token = process.env.ADMIN_TOKEN } = {}) {
  return (req, res, next) => {
    if (!token) return res.status(403).json({ error: "admin token is not configured" });

    const provided = readAdminToken(req);
    if (!provided || !safeEqual(provided, token)) {
      return res.status(403).json({ error: "admin token required" });
    }

    next();
  };
}

export function requireAdminBasicAuth({ token = process.env.ADMIN_TOKEN } = {}) {
  return (req, res, next) => {
    if (!token) return res.status(403).send("Admin access is not configured.");

    const header = req.headers.authorization || "";
    const [scheme, value] = header.split(" ");
    if (scheme !== "Basic" || !value) {
      res.setHeader("WWW-Authenticate", 'Basic realm="World Cup Admin"');
      return res.status(401).send("Authentication required.");
    }

    const decoded = Buffer.from(value, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const user = separator >= 0 ? decoded.slice(0, separator) : "";
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";
    if (user !== "admin" || !safeEqual(password, token)) {
      return res.status(403).send("Forbidden.");
    }

    next();
  };
}

export function rejectPublicWrites() {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    return res.status(403).json({ error: "write access requires admin route" });
  };
}

export function createAnalyticsRouter({ allowedEvents = DEFAULT_ALLOWED_EVENTS } = {}) {
  return (req, res) => {
    const eventName = String(req.body?.event_name || "");
    if (!allowedEvents.has(eventName)) {
      return res.status(400).json({ error: "unknown event_name" });
    }

    const sessionId = normalizeSessionId(req.body?.session_id);
    const metadata = sanitizeMetadata(req.body?.metadata);
    if (metadata === null) {
      return res.status(400).json({ error: "metadata too large" });
    }

    res.status(202).json({
      ok: true,
      event_name: eventName,
      session_id: sessionId,
      accepted: true
    });
  };
}

function readAdminToken(req) {
  const direct = req.headers["x-admin-token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const authorization = req.headers.authorization || "";
  const [scheme, value] = authorization.split(" ");
  if (scheme === "Bearer" && value) return value.trim();
  return "";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function clientKey(req) {
  return req.ip || req.headers["cf-connecting-ip"] || req.socket?.remoteAddress || "unknown";
}

function normalizeSessionId(input) {
  const value = String(input || "");
  if (/^[A-Za-z0-9_-]{8,80}$/.test(value)) return value;
  return `anon_${Math.random().toString(36).slice(2, 12)}`;
}

function sanitizeMetadata(input) {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return {};

  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(clean).length >= 20) break;
    if (!/^[A-Za-z0-9_.:-]{1,50}$/.test(key)) continue;
    if (typeof value === "string") clean[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean") clean[key] = value;
  }

  return JSON.stringify(clean).length > 2048 ? null : clean;
}
