export async function evaluatePrediction(db, matchId) {
  const match = await db.getMatch(matchId);
  if (!match) throw new Error("match not found");
  if (match.status !== "finished") throw new Error("match is not finished");

  const result = await ensureResult(db, match);
  const prediction = await db.getLatestPrediction(match.id);
  if (!prediction) throw new Error("prediction not found");

  const existing = await db.getPredictionEvaluation?.(prediction.id);
  if (existing) return { evaluation: existing, modelStats: await updateModelStats(db, prediction.model_version) };

  const actualOutcome = outcome(result.actual_home_score, result.actual_away_score);
  const predictedOutcome = outcome(prediction.predicted_home_score, prediction.predicted_away_score);
  const resultCorrect = predictedOutcome === actualOutcome;
  const scoreError =
    Math.abs(Number(prediction.predicted_home_score) - Number(result.actual_home_score)) +
    Math.abs(Number(prediction.predicted_away_score) - Number(result.actual_away_score));
  const predictedTotal = Number(prediction.predicted_home_score) + Number(prediction.predicted_away_score);
  const actualTotal = Number(result.actual_home_score) + Number(result.actual_away_score);
  const evaluation = await db.createPredictionEvaluation({
    prediction_id: prediction.id,
    match_id: match.id,
    model_version: prediction.model_version,
    result_correct: resultCorrect,
    score_exact: scoreError === 0,
    score_error: scoreError,
    goal_total_error: Math.abs(predictedTotal - actualTotal),
    brier_score: brierScore(prediction, actualOutcome),
    confidence_error: Number((Number(prediction.confidence_score) - (resultCorrect ? 100 : 0)).toFixed(2))
  });
  const modelStats = await updateModelStats(db, prediction.model_version);
  return { evaluation, modelStats };
}

export async function savePostMatchFromMatch(db, match, stats = {}) {
  if (!match || match.status !== "finished") return null;
  const homeScore = match.home_score == null ? stats.home_score : match.home_score;
  const awayScore = match.away_score == null ? stats.away_score : match.away_score;
  if (homeScore == null || awayScore == null) return null;
  await db.upsertMatchResult?.({
    match_id: match.id,
    actual_score: `${homeScore}-${awayScore}`,
    actual_home_score: Number(homeScore),
    actual_away_score: Number(awayScore),
    winner: outcome(homeScore, awayScore),
    source: stats.source || "sync",
    verified_at: stats.verified_at || new Date().toISOString()
  });
  return db.upsertPostMatchStats?.({
    match_id: match.id,
    home_score: Number(homeScore),
    away_score: Number(awayScore),
    home_shots: stats.home_shots,
    away_shots: stats.away_shots,
    home_shots_on_target: stats.home_shots_on_target,
    away_shots_on_target: stats.away_shots_on_target,
    home_possession: stats.home_possession,
    away_possession: stats.away_possession,
    home_cards: stats.home_cards,
    away_cards: stats.away_cards,
    goal_timeline: stats.goal_timeline || []
  });
}

export async function optimizeModelFactors(db, options = {}) {
  const minimumMatches = Number(options.minimumMatches || 6);
  const evaluations = await db.listPredictionEvaluations();
  if (evaluations.length < minimumMatches) {
    return { changed: false, reason: "not enough finished matches", evaluated_matches: evaluations.length };
  }
  const active = await db.getActiveModelVersion();
  const stats = summarizeEvaluations(await enrichEvaluations(db, evaluations));
  const next = { ...active };
  const updates = [];

  if (stats.favoriteMissRate > 0.42) {
    adjust(next, updates, "attack_weight", -0.02, "recent evaluations show favorite strength running too high");
    adjust(next, updates, "ranking_weight", -0.01, "recent evaluations show ranking signal needs softer influence");
    adjust(next, updates, "form_weight", 0.02, "recent evaluations favor more current-form signal");
  }
  if (stats.drawGap > 0.08) {
    adjust(next, updates, "draw_bias", 0.03, "recent evaluations show draws were under-estimated");
    adjust(next, updates, "attack_weight", -0.01, "draw under-estimation calls for slightly softer attacking edge");
  }
  if (stats.avgGoalTotalError > 1.4) {
    adjust(next, updates, "defense_weight", 0.02, "recent evaluations show goal totals need stronger defensive constraint");
    adjust(next, updates, "attack_weight", -0.01, "recent evaluations show goal totals running too loose");
  }
  if (stats.avgConfidenceError > 16) {
    adjust(next, updates, "upset_bias", 0.02, "recent confidence calibration is too aggressive");
  } else if (stats.avgConfidenceError < -16) {
    adjust(next, updates, "upset_bias", -0.02, "recent confidence calibration is too conservative");
  }

  if (!updates.length) return { changed: false, reason: "no material bias detected", evaluated_matches: evaluations.length };

  normalizeCoreWeights(next);
  const version = await db.createModelVersion({
    ...next,
    model_version: nextModelVersion(active.model_version),
    is_active: true
  });
  for (const update of updates) {
    await db.createModelFactorUpdate({
      model_version: version.model_version,
      factor_name: update.factor_name,
      old_weight: update.old_weight,
      new_weight: Number(version[update.factor_name].toFixed(4)),
      reason: update.reason,
      based_on_matches_count: evaluations.length
    });
  }
  return { changed: true, model_version: version, updates, evaluated_matches: evaluations.length };
}

export async function getModelPerformance(db) {
  const evaluations = await db.listPredictionEvaluations();
  const active = await db.getActiveModelVersion();
  const stats = aggregate(evaluations);
  return {
    total_matches_evaluated: stats.total,
    result_accuracy: stats.resultAccuracy,
    exact_score_accuracy: stats.exactScoreAccuracy,
    average_score_error: stats.averageScoreError,
    brier_score: stats.brierScore,
    confidence_calibration: stats.confidenceCalibration,
    current_model_weights: {
      model_version: active.model_version,
      attack_weight: active.attack_weight,
      defense_weight: active.defense_weight,
      form_weight: active.form_weight,
      ranking_weight: active.ranking_weight,
      h2h_weight: active.h2h_weight,
      draw_bias: active.draw_bias,
      upset_bias: active.upset_bias
    }
  };
}

async function ensureResult(db, match) {
  const existing = await db.getMatchResult?.(match.id);
  if (existing) return existing;
  if (match.home_score == null || match.away_score == null) throw new Error("finished match score is required");
  await savePostMatchFromMatch(db, match);
  return db.getMatchResult(match.id);
}

async function updateModelStats(db, modelVersion) {
  const rows = (await db.listPredictionEvaluations()).filter((row) => row.model_version === modelVersion);
  const stats = aggregate(rows);
  return db.upsertModelStats({
    model_version: modelVersion,
    accuracy_rate: stats.resultAccuracy,
    total_matches: stats.total,
    correct_matches: rows.filter((row) => row.result_correct).length,
    avg_confidence: average(rows.map((row) => Math.max(0, 100 - Math.abs(Number(row.confidence_error || 0))))),
    exact_score_accuracy: stats.exactScoreAccuracy,
    average_score_error: stats.averageScoreError,
    brier_score: stats.brierScore,
    confidence_calibration: stats.confidenceCalibration
  });
}

function aggregate(rows) {
  const total = rows.length;
  return {
    total,
    resultAccuracy: total ? round(rows.filter((row) => row.result_correct).length / total, 5) : 0,
    exactScoreAccuracy: total ? round(rows.filter((row) => row.score_exact).length / total, 5) : 0,
    averageScoreError: round(average(rows.map((row) => row.score_error)), 3),
    brierScore: round(average(rows.map((row) => row.brier_score)), 6),
    confidenceCalibration: round(average(rows.map((row) => Math.abs(Number(row.confidence_error || 0)))), 3)
  };
}

async function enrichEvaluations(db, rows) {
  const enriched = [];
  for (const row of rows) {
    const prediction = await db.getPrediction?.(row.prediction_id);
    enriched.push({
      ...row,
      predicted_outcome: prediction ? outcome(prediction.predicted_home_score, prediction.predicted_away_score) : null,
      predicted_draw_probability: prediction ? Number(prediction.probability_draw) : 0
    });
  }
  return enriched;
}

function summarizeEvaluations(rows) {
  const favoriteRows = rows.filter((row) => row.predicted_outcome !== "draw");
  const actualDrawRate = rows.filter((row) => row.actual_outcome === "draw").length / rows.length;
  const predictedDrawConfidence = average(rows.map((row) => Number(row.predicted_draw_probability || 0)));
  return {
    favoriteMissRate: favoriteRows.length ? favoriteRows.filter((row) => !row.result_correct).length / favoriteRows.length : 0,
    drawGap: actualDrawRate - predictedDrawConfidence,
    avgGoalTotalError: average(rows.map((row) => row.goal_total_error)),
    avgConfidenceError: average(rows.map((row) => row.confidence_error))
  };
}

function brierScore(prediction, actualOutcome) {
  return round(
    ["home", "draw", "away"].reduce((sum, key) => {
      const value = Number(
        key === "home" ? prediction.probability_home_win : key === "draw" ? prediction.probability_draw : prediction.probability_away_win
      );
      return sum + (value - (key === actualOutcome ? 1 : 0)) ** 2;
    }, 0),
    6
  );
}

function outcome(home, away) {
  const h = Number(home);
  const a = Number(away);
  if (h > a) return "home";
  if (h < a) return "away";
  return "draw";
}

function adjust(model, updates, factorName, delta, reason) {
  const oldWeight = Number(model[factorName] || 0);
  const cappedDelta = Math.max(-0.03, Math.min(0.03, delta));
  const lower = Math.max(0, oldWeight - 0.08);
  const upper = oldWeight + 0.08;
  const newWeight = clamp(oldWeight + cappedDelta, lower, upper);
  if (Math.abs(newWeight - oldWeight) < 0.0001) return;
  model[factorName] = newWeight;
  updates.push({ factor_name: factorName, old_weight: oldWeight, new_weight: newWeight, reason });
}

function normalizeCoreWeights(model) {
  const keys = ["attack_weight", "defense_weight", "form_weight", "ranking_weight", "h2h_weight"];
  const total = keys.reduce((sum, key) => sum + Number(model[key] || 0), 0) || 1;
  for (const key of keys) model[key] = round(Number(model[key] || 0) / total, 4);
}

function nextModelVersion(current) {
  const base = String(current || "worldcup-ai-realtime-v1");
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  return `${base.replace(/-\d{12,17}$/, "")}-${stamp}`;
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

function round(value, digits) {
  return Number((Number(value) || 0).toFixed(digits));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
