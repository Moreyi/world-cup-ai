import express from "express";
import cron from "node-cron";
import { pathToFileURL } from "node:url";
import { createDatabase } from "./db/db.js";
import { createProvider } from "./providers/index.js";
import { createDataSyncService } from "./services/dataSyncService.js";
import { createMatchesRouter } from "./routes/matches.js";
import { createPredictionsRouter } from "./routes/predictions.js";
import {
  corsGuard,
  createAnalyticsRouter,
  createRateLimiter,
  rejectPublicWrites,
  requireAdminBasicAuth,
  requireAdminToken,
  securityHeaders
} from "./security.js";

export async function createApp(options = {}) {
  const db = options.db || createDatabase();
  const provider = options.provider || createProvider(options.providerName);
  const syncService = options.syncService || createDataSyncService({ db, provider });
  const app = express();
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN;
  const limits = {
    public: options.rateLimits?.public ?? 120,
    analytics: options.rateLimits?.analytics ?? 30,
    admin: options.rateLimits?.admin ?? 10
  };

  app.set("trust proxy", 1);
  app.use(securityHeaders());
  app.use(corsGuard({ allowedOrigin: options.allowedOrigin }));
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader("cache-control", "no-store");
    next();
  });

  const publicLimiter = createRateLimiter({ limit: limits.public, keyPrefix: "public" });
  const analyticsLimiter = createRateLimiter({ limit: limits.analytics, keyPrefix: "analytics" });
  const adminLimiter = createRateLimiter({ limit: limits.admin, keyPrefix: "admin" });
  const adminAuth = requireAdminToken({ token: adminToken });
  const adminPageAuth = requireAdminBasicAuth({ token: adminToken });
  const matchesRouter = createMatchesRouter({ db });
  const predictionsRouter = createPredictionsRouter({ db, syncService });
  const analyticsHandler = createAnalyticsRouter();

  app.use(["/admin", "/admin/*path"], adminPageAuth);
  app.use(["/api/admin", "/api/admin/*path", "/worldcup-api/admin", "/worldcup-api/admin/*path"], adminLimiter, adminAuth);
  app.use(["/api/analytics/event", "/worldcup-api/analytics/event"], analyticsLimiter);
  app.use(["/api", "/api/*path", "/worldcup-api", "/worldcup-api/*path"], publicLimiter);

  app.get(["/health", "/worldcup-api/health"], (req, res) => {
    res.json({ ok: true, provider: provider.name, store: db.kind || "database" });
  });

  app.post(["/api/analytics/event", "/worldcup-api/analytics/event"], analyticsHandler);

  app.use("/api", matchesRouter);
  app.use("/worldcup-api", matchesRouter);
  app.use("/api/predict", adminAuth);
  app.use("/worldcup-api/predict", adminAuth);
  app.use("/api", predictionsRouter);
  app.use("/worldcup-api", predictionsRouter);
  app.use(["/api", "/api/*path", "/worldcup-api", "/worldcup-api/*path"], rejectPublicWrites());

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(500).json({
      error: "internal server error",
      message: process.env.NODE_ENV === "production" ? "temporary service issue" : error.message
    });
  });

  if (options.initialSync !== false) {
    const current = await db.listMatches();
    if (!current.length) await syncService.syncSchedule();
  }

  return { app, db, provider, syncService };
}

export async function startServer(options = {}) {
  const port = Number(options.port || process.env.PORT || 3001);
  const runtime = await createApp(options);
  const server = runtime.app.listen(port);
  const jobs = options.enableCron === false || process.env.ENABLE_CRON === "0" ? [] : startCron(runtime.syncService);
  return { ...runtime, server, jobs, port };
}

export function startCron(syncService) {
  const minuteInterval = clampMinutes(Number(process.env.SYNC_INTERVAL_MINUTES || 5));
  const jobs = [
    cron.schedule("0 2 * * *", () => {
      syncService.syncSchedule().catch((error) => console.error("[sync:schedule]", error.message));
    }),
    cron.schedule(`*/${minuteInterval} * * * *`, () => {
      syncService.syncMatchDay().catch((error) => console.error("[sync:matchday]", error.message));
    })
  ];
  return jobs;
}

function clampMinutes(value) {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(30, Math.round(value)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(({ port, provider, db }) => {
    console.log(`Football AI API listening on http://127.0.0.1:${port}`);
    console.log(`Provider: ${provider.name}; store: ${db.kind || "database"}`);
  });
}
