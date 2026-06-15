import { mockProvider } from "../providers/mockProvider.js";
import { generateAndStorePrediction } from "./predictionService.js";
import { evaluatePrediction, optimizeModelFactors, savePostMatchFromMatch } from "./evaluationService.js";
import { optimizeFactorWeights } from "./featureExtractionService.js";

export function createDataSyncService({ db, provider, fallbackProvider = mockProvider, now = () => new Date() }) {
  if (!db) throw new Error("db is required");
  if (!provider) throw new Error("provider is required");

  async function syncSchedule({ days = 7 } = {}) {
    return runSync("schedule", async (activeProvider) => activeProvider.fetchMatches({ days, now: now() }));
  }

  async function syncMatchDay() {
    return runSync("matchday", async (activeProvider) => activeProvider.fetchTodayMatches({ now: now() }));
  }

  async function runSync(syncType, fetcher) {
    const startedAt = new Date().toISOString();
    let providerName = provider.name;
    try {
      const rows = await fetcher(provider);
      const result = await applyRows(rows, { syncType });
      await db.createSyncLog({
        provider: providerName,
        sync_type: syncType,
        status: "success",
        message: `synced ${result.matches.length} matches`,
        started_at: startedAt
      });
      return { ...result, provider: providerName, fallback: false };
    } catch (error) {
      providerName = fallbackProvider.name;
      const fallbackRows = await fetcher(fallbackProvider);
      const result = await applyRows(fallbackRows, { syncType });
      await db.createSyncLog({
        provider: providerName,
        sync_type: syncType,
        status: "fallback",
        message: `${error.message}; used fallback data`,
        started_at: startedAt
      });
      return { ...result, provider: providerName, fallback: true, error: error.message };
    }
  }

  async function applyRows(rows, { syncType }) {
    const matches = [];
    const predictions = [];
    const evaluations = [];
    const optimizations = [];
    for (const row of rows) {
      const clean = cleanMatch(row);
      const previous = await db.getMatch(clean.external_id);
      const match = await db.upsertMatch(clean);
      matches.push(match);
      const latest = await db.getLatestPrediction(match.id);
      if (
        match.status === "live" ||
        (match.status === "scheduled" && (!latest || syncType === "schedule"))
      ) {
        predictions.push(await generateAndStorePrediction(db, match));
      }
      if (match.status === "finished" && (previous?.status !== "finished" || !(await db.getPredictionEvaluation?.(latest?.id)))) {
        await savePostMatchFromMatch(db, match, postMatchStats(row));
        if (latest) {
          evaluations.push(await evaluatePrediction(db, match.id));
          const optimization = await optimizeModelFactors(db);
          if (optimization.changed) optimizations.push(optimization);
          const factorOptimization = await optimizeFactorWeights(db);
          if (factorOptimization.changed) optimizations.push(factorOptimization);
        }
      }
    }
    return { matches, predictions, evaluations, optimizations };
  }

  return { syncSchedule, syncMatchDay };
}

function cleanMatch(row) {
  return {
    external_id: String(row.external_id),
    home_team: row.home_team,
    away_team: row.away_team,
    competition: row.competition || "World Cup 2026",
    group_name: row.group_name || null,
    kickoff_time: row.kickoff_time,
    status: normalizeStatus(row.status),
    home_score: row.home_score == null ? null : Number(row.home_score),
    away_score: row.away_score == null ? null : Number(row.away_score),
    minute: row.minute == null ? null : Number(row.minute),
    venue: row.venue || null,
    homeMetrics: row.homeMetrics || row.home_metrics || {},
    awayMetrics: row.awayMetrics || row.away_metrics || {},
    post_match_stats: row.post_match_stats || row.postMatchStats || {},
    last_synced_at: new Date().toISOString()
  };
}

function postMatchStats(row) {
  const stats = row.post_match_stats || row.postMatchStats || {};
  return {
    ...stats,
    home_score: row.home_score,
    away_score: row.away_score,
    source: row.provider || "sync"
  };
}

function normalizeStatus(status) {
  if (status === "final") return "finished";
  return ["scheduled", "live", "finished"].includes(status) ? status : "scheduled";
}
