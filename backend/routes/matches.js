import { Router } from "express";
import { buildPredictionEnvelope, generateAndStorePrediction } from "../services/predictionService.js";

export function createMatchesRouter({ db }) {
  const router = Router();

  router.get("/matches", async (req, res, next) => {
    try {
      const matches = await db.listMatches({
        status: req.query.status,
        date: req.query.date,
        group: req.query.group
      });
      res.json({ matches: matches.map(toPublicMatch) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/worldcup/today", async (req, res, next) => {
    try {
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const matches = await db.listMatches({ date });
      res.json({ date, matches: matches.map(toPublicMatch) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/match/:id", async (req, res, next) => {
    try {
      const match = await db.getMatch(req.params.id);
      if (!match) return res.status(404).json({ error: "match not found" });
      let prediction = await db.getLatestPrediction(match.id);
      if (!prediction && match.status !== "finished") {
        const generated = await generateAndStorePrediction(db, match);
        prediction = generated.prediction;
      }
      const simulation = prediction ? await db.getSimulationByPrediction(prediction.id) : null;
      const trust = prediction ? await db.getTrustScoreByPrediction(prediction.id) : null;
      const envelope = await buildPredictionEnvelope(db, match, prediction, simulation, trust);
      res.json({
        match: toPublicMatch(match),
        ...envelope,
        fallback: false
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function toPublicMatch(match) {
  return {
    match_id: match.external_id || match.id,
    id: match.id,
    external_id: match.external_id,
    home_team: match.home_team,
    away_team: match.away_team,
    competition: match.competition,
    group_name: match.group_name,
    kickoff_time: match.kickoff_time,
    match_date: match.kickoff_time,
    league: "WorldCup",
    status: match.status,
    home_score: match.home_score,
    away_score: match.away_score,
    minute: match.minute,
    venue: match.venue,
    last_synced_at: match.last_synced_at
  };
}
