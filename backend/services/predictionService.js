import { generatePrediction } from "../../api/predictionEngine.js";
import { calculateTrustScore } from "./trustScoreService.js";
import {
  buildFeatureAdjustments,
  extractMatchFeatures,
  featureExplanationLines,
  publicFeatureSnapshot
} from "./featureExtractionService.js";

export async function generateAndStorePrediction(db, match, options = {}) {
  if (!match) throw new Error("match is required");
  const activeModel = options.modelVersion
    ? null
    : typeof db.getActiveModelVersion === "function"
      ? await db.getActiveModelVersion()
      : null;
  const modelVersion = options.modelVersion || activeModel?.model_version || "worldcup-ai-realtime-v1";
  const weights = options.weights || (activeModel ? modelWeights(activeModel) : undefined);
  const factorWeights = options.factorWeights || (typeof db.getActiveModelFactorWeights === "function" ? await db.getActiveModelFactorWeights() : {});
  const features = options.features || await extractMatchFeatures(match);
  const featureAdjustments = buildFeatureAdjustments(features, factorWeights, match);
  const generated = generatePrediction(toPredictionMatch(match), {
    runs: options.runs || 10000,
    modelVersion,
    weights,
    drawBias: options.drawBias ?? activeModel?.draw_bias,
    upsetBias: options.upsetBias ?? activeModel?.upset_bias,
    featureAdjustments,
    seed: options.seed || `${match.external_id}:${match.updated_at || ""}`
  });
  const explanation = [
    ...(Array.isArray(generated.explanation) ? generated.explanation : [generated.explanation].filter(Boolean)),
    ...featureExplanationLines(features)
  ];
  const prediction = await db.createPrediction({
    match_id: match.id,
    predicted_home_score: generated.predictedHomeScore,
    predicted_away_score: generated.predictedAwayScore,
    probability_home_win: generated.probabilities.home,
    probability_draw: generated.probabilities.draw,
    probability_away_win: generated.probabilities.away,
    confidence_score: generated.confidenceScore,
    model_version: generated.modelVersion,
    explanation
  });
  const featureSnapshot = await db.createMatchFeatureSnapshot?.({
    match_id: match.id,
    prediction_id: prediction.id,
    model_version: modelVersion,
    player_layer: features.player_layer,
    coach_layer: features.coach_layer,
    referee_layer: features.referee_layer,
    external_layer: features.external_layer,
    live_process_layer: features.live_process_layer
  });
  const simulation = await db.createSimulation({
    match_id: match.id,
    prediction_id: prediction.id,
    runs: generated.runs,
    most_common_scores: [
      {
        score: generated.predictedScore,
        share: Number((Math.max(generated.probabilities.home, generated.probabilities.draw, generated.probabilities.away) * 100).toFixed(1))
      }
    ],
    stability: stabilityLabel(generated.confidence?.stability)
  });
  const trust = await db.createTrustScore({
    match_id: match.id,
    prediction_id: prediction.id,
    ...calculateTrustScore({ prediction: generated, match })
  });
  return { prediction, simulation, trust, featureSnapshot, generated };
}

function modelWeights(modelVersion) {
  return {
    attack: Number(modelVersion.attack_weight ?? 0.3),
    defense: Number(modelVersion.defense_weight ?? 0.2),
    form: Number(modelVersion.form_weight ?? 0.25),
    ranking: Number(modelVersion.ranking_weight ?? 0.15),
    headToHead: Number(modelVersion.h2h_weight ?? 0.1)
  };
}

export function toPublicPrediction(match, prediction, simulation, trust) {
  if (!prediction) return null;
  const score = `${prediction.predicted_home_score}-${prediction.predicted_away_score}`;
  return {
    match_id: match.external_id || match.id,
    home_team: match.home_team,
    away_team: match.away_team,
    prediction: {
      score,
      probability: {
        home: Number(prediction.probability_home_win),
        draw: Number(prediction.probability_draw),
        away: Number(prediction.probability_away_win)
      }
    },
    confidence: Number(prediction.confidence_score),
    simulation: {
      runs: Number(simulation?.runs || 10000),
      most_common_score: simulation?.most_common_scores?.[0]?.score || score,
      most_common_scores: simulation?.most_common_scores || []
    },
    explanation: Array.isArray(prediction.explanation) ? prediction.explanation : [],
    trust_score: Number(trust?.trust_score || 0)
  };
}

export async function buildPredictionEnvelope(db, match, prediction, simulation, trust) {
  let snapshot = prediction ? await db.getFeatureSnapshotByPrediction?.(prediction.id) : null;
  if (!snapshot && prediction && typeof db.createMatchFeatureSnapshot === "function") {
    const features = await extractMatchFeatures(match, { source: "detail-backfill" });
    snapshot = await db.createMatchFeatureSnapshot({
      match_id: match.id,
      prediction_id: prediction.id,
      model_version: prediction.model_version,
      player_layer: features.player_layer,
      coach_layer: features.coach_layer,
      referee_layer: features.referee_layer,
      external_layer: features.external_layer,
      live_process_layer: features.live_process_layer
    });
  }
  const publicPrediction = toPublicPrediction(match, prediction, simulation, trust);
  const featureLines = snapshot ? featureExplanationLines(publicFeatureSnapshot(snapshot)) : [];
  const explanation = [
    ...(publicPrediction?.explanation || []),
    ...featureLines.filter((line) => !(publicPrediction?.explanation || []).includes(line))
  ];
  return {
    prediction: publicPrediction,
    simulation,
    trust_score: trust,
    feature_snapshot: publicFeatureSnapshot(snapshot),
    explanation
  };
}

function toPredictionMatch(match) {
  return {
    id: match.external_id || match.id,
    homeTeam: match.home_team,
    awayTeam: match.away_team,
    homeMetrics: match.homeMetrics || match.home_metrics || {},
    awayMetrics: match.awayMetrics || match.away_metrics || {}
  };
}

function stabilityLabel(value) {
  const score = Number(value || 0);
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  return "low";
}
