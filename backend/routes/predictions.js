import { Router } from "express";
import { generateAndStorePrediction, toPublicPrediction } from "../services/predictionService.js";
import { evaluatePrediction, getModelPerformance, optimizeModelFactors } from "../services/evaluationService.js";
import { extractMatchFeatures, getModelFactors, optimizeFactorWeights } from "../services/featureExtractionService.js";

export function createPredictionsRouter({ db, syncService }) {
  const router = Router();

  router.post("/predict", async (req, res, next) => {
    try {
      const id = req.body?.matchId || req.body?.match_id;
      const match = await db.getMatch(id);
      if (!match) return res.status(404).json({ error: "match not found" });
      const { prediction, simulation, trust } = await generateAndStorePrediction(db, match, {
        runs: req.body?.runs,
        modelVersion: req.body?.modelVersion,
        seed: req.body?.seed
      });
      res.status(201).json(toPublicPrediction(match, prediction, simulation, trust));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/sync", async (req, res, next) => {
    try {
      const type = req.body?.type || req.query.type || "schedule";
      const result = type === "matchday" ? await syncService.syncMatchDay() : await syncService.syncSchedule();
      res.json({
        provider: result.provider,
        fallback: result.fallback,
        matches: result.matches.length,
        predictions: result.predictions.length
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/predict/:matchId", async (req, res, next) => {
    try {
      const match = await db.getMatch(req.params.matchId);
      if (!match) return res.status(404).json({ error: "match not found" });
      const { prediction, simulation, trust } = await generateAndStorePrediction(db, match, {
        runs: req.body?.runs,
        modelVersion: req.body?.modelVersion,
        seed: req.body?.seed || `manual:${Date.now()}`
      });
      res.status(201).json(toPublicPrediction(match, prediction, simulation, trust));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/evaluate/:matchId", async (req, res, next) => {
    try {
      const result = await evaluatePrediction(db, req.params.matchId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/optimize-model", async (req, res, next) => {
    try {
      res.json(await optimizeModelFactors(db, { minimumMatches: req.body?.minimumMatches }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/recalculate-features/:matchId", async (req, res, next) => {
    try {
      const match = await db.getMatch(req.params.matchId);
      if (!match) return res.status(404).json({ error: "match not found" });
      const features = await extractMatchFeatures(match, { source: "manual-refresh" });
      const { prediction, simulation, trust, featureSnapshot } = await generateAndStorePrediction(db, match, {
        runs: req.body?.runs,
        seed: req.body?.seed || `features:${Date.now()}`,
        features
      });
      res.status(201).json({
        prediction: toPublicPrediction(match, prediction, simulation, trust),
        feature_snapshot: featureSnapshot
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/optimize-factor-weights", async (req, res, next) => {
    try {
      res.json(await optimizeFactorWeights(db, { minimumMatches: req.body?.minimumMatches }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/model/factors", async (req, res, next) => {
    try {
      res.json(await getModelFactors(db));
    } catch (error) {
      next(error);
    }
  });

  router.get("/model/performance", async (req, res, next) => {
    try {
      res.json(await getModelPerformance(db));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
