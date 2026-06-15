const DEFAULT_FACTOR_WEIGHTS = {
  base_team_weight: 0.3,
  player_weight: 0.35,
  coach_weight: 0.12,
  referee_weight: 0.06,
  external_weight: 0.07,
  live_process_weight: 0.1
};

export async function extractMatchFeatures(match, options = {}) {
  const status = match?.status || "scheduled";
  const player = playerLayer(match);
  const coach = coachLayer(match);
  const referee = refereeLayer(match);
  const external = externalLayer(match);
  const live = liveProcessLayer(match);
  if (status !== "live") live.adjustment = 0;
  return {
    player_layer: player,
    coach_layer: coach,
    referee_layer: referee,
    external_layer: external,
    live_process_layer: live,
    data_quality: round(average([player.data_quality, coach.data_quality, referee.data_quality, external.data_quality, live.data_quality]), 2),
    source: options.source || "safe-fallback"
  };
}

export function buildFeatureAdjustments(features, factorWeights = {}, match = {}) {
  const weights = normalizeFactorWeights(factorWeights, match.status === "live");
  const layerAdjustments = {
    base_team: 0,
    player: layerAdjustment(features.player_layer) * weights.player_weight,
    coach: layerAdjustment(features.coach_layer) * weights.coach_weight,
    referee: layerAdjustment(features.referee_layer) * weights.referee_weight,
    external: layerAdjustment(features.external_layer) * weights.external_weight,
    live_process: (match.status === "live" ? layerAdjustment(features.live_process_layer) : 0) * weights.live_process_weight
  };
  const total = Object.values(layerAdjustments).reduce((sum, value) => sum + value, 0);
  return {
    weights,
    layer_adjustments: mapValues(layerAdjustments, (value) => round(value, 3)),
    home: round(total, 3),
    away: round(-total, 3)
  };
}

export function featureExplanationLines(features) {
  const lines = [];
  const player = features.player_layer || {};
  const coach = features.coach_layer || {};
  const referee = features.referee_layer || {};
  const external = features.external_layer || {};
  const live = features.live_process_layer || {};

  if (Math.abs(player.adjustment || 0) >= 0.8) {
    lines.push(`Player availability gives ${sideLabel(player.adjustment)} a slight squad-impact advantage.`);
  } else {
    lines.push("Player availability is close enough that the model keeps this layer modest.");
  }
  if (Math.abs(coach.adjustment || 0) >= 0.5) {
    lines.push(`Coach tactical fit favors ${sideLabel(coach.adjustment)} in match-plan stability.`);
  } else {
    lines.push("Coach layer does not create a large tactical separation before kickoff.");
  }
  if (Math.abs(referee.adjustment || 0) >= 0.4) {
    lines.push("Referee profile raises match-control risk for the more aggressive defensive side.");
  } else {
    lines.push("Referee profile is treated as a low-impact risk layer for this fixture.");
  }
  if (Math.abs(external.adjustment || 0) >= 0.4) {
    lines.push("External conditions such as rest, travel, weather and venue context create a small model adjustment.");
  } else {
    lines.push("External conditions are not strong enough to dominate the team-strength signal.");
  }
  if ((live.minute || 0) > 0) {
    lines.push("Live process factors update momentum, score state and match rhythm as verified events arrive.");
  }
  return lines;
}

export function publicFeatureSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    player_layer: snapshot.player_layer,
    coach_layer: snapshot.coach_layer,
    referee_layer: snapshot.referee_layer,
    external_layer: snapshot.external_layer,
    live_process_layer: snapshot.live_process_layer
  };
}

export async function getModelFactors(db) {
  const weights = await db.getActiveModelFactorWeights();
  return {
    model_version: weights.model_version,
    base_team_weight: Number(weights.base_team_weight),
    player_weight: Number(weights.player_weight),
    coach_weight: Number(weights.coach_weight),
    referee_weight: Number(weights.referee_weight),
    external_weight: Number(weights.external_weight),
    live_process_weight: Number(weights.live_process_weight),
    is_active: Boolean(weights.is_active)
  };
}

export async function optimizeFactorWeights(db, options = {}) {
  const minimumMatches = Number(options.minimumMatches || 6);
  const evaluations = await db.listPredictionEvaluations();
  if (evaluations.length < minimumMatches) {
    return { changed: false, reason: "not enough finished matches", evaluated_matches: evaluations.length };
  }
  const active = await db.getActiveModelFactorWeights();
  const next = { ...active };
  const updates = [];
  const enriched = await evaluationsWithSnapshots(db, evaluations);
  const misses = enriched.filter((row) => !row.result_correct);
  const avgScoreError = average(enriched.map((row) => row.score_error));
  const lowQualityMissRate = misses.filter((row) => row.snapshotQuality < 50).length / Math.max(1, misses.length);

  if (misses.length / evaluations.length > 0.45) {
    adjustWeight(next, updates, "base_team_weight", -0.02, "recent results show base team signal needs less dominance");
    adjustWeight(next, updates, "player_weight", 0.02, "recent results suggest squad availability should carry more signal");
  }
  if (avgScoreError > 1.4) {
    adjustWeight(next, updates, "coach_weight", 0.01, "score error suggests tactical fit should be slightly more visible");
    adjustWeight(next, updates, "external_weight", 0.01, "score error suggests rest, travel and conditions need more attention");
  }
  if (lowQualityMissRate > 0.5) {
    adjustWeight(next, updates, "referee_weight", -0.01, "low-quality referee fallback should have softer influence");
    adjustWeight(next, updates, "base_team_weight", 0.01, "fallback-heavy matches should lean a bit more on stable team strength");
  }

  if (!updates.length) return { changed: false, reason: "no material factor bias detected", evaluated_matches: evaluations.length };
  normalizeFactorWeightSet(next);
  const version = nextFactorVersion(active.model_version);
  const created = await db.createModelFactorWeights({
    ...next,
    model_version: version,
    is_active: true
  });
  for (const update of updates) {
    await db.createModelFactorUpdate?.({
      model_version: version,
      factor_name: update.factor_name,
      old_weight: update.old_weight,
      new_weight: Number(created[update.factor_name].toFixed(4)),
      reason: update.reason,
      based_on_matches_count: evaluations.length
    });
  }
  return { changed: true, model_version: created, updates, evaluated_matches: evaluations.length };
}

function playerLayer(match = {}) {
  const home = metrics(match.homeMetrics || match.home_metrics);
  const away = metrics(match.awayMetrics || match.away_metrics);
  const edge = metricEdge(home, away);
  const quality = hasMetrics(match) ? 72 : 46;
  return {
    starting_xi_strength: round(55 + edge * 0.22, 2),
    key_player_missing_penalty: 0,
    attacking_threat: round(50 + edge * 0.16, 2),
    defensive_stability: round(50 + (home.defense - away.defense) * 0.18, 2),
    goalkeeper_form: round(50 + (home.defense - away.defense) * 0.08, 2),
    fatigue_index: 50,
    adjustment: round(edge * 0.12, 3),
    data_quality: quality
  };
}

function coachLayer(match = {}) {
  const home = metrics(match.homeMetrics || match.home_metrics);
  const away = metrics(match.awayMetrics || match.away_metrics);
  const formEdge = home.form - away.form;
  return {
    tactical_fit: round(50 + formEdge * 0.18, 2),
    adjustment_score: round(50 + formEdge * 0.12, 2),
    knockout_experience: 50,
    substitution_impact: round(50 + formEdge * 0.08, 2),
    risk_tendency: 50,
    adjustment: round(formEdge * 0.08, 3),
    data_quality: hasMetrics(match) ? 62 : 42
  };
}

function refereeLayer(match = {}) {
  const referee = match.referee || match.referee_profile || {};
  const cards = Number(referee.cards_per_match ?? 4.1);
  const aggressiveEdge = Math.abs(metrics(match.homeMetrics || match.home_metrics).defense - metrics(match.awayMetrics || match.away_metrics).defense);
  return {
    cards_per_match: cards,
    penalty_tendency: Number(referee.penalty_tendency ?? 0.22),
    foul_tolerance: Number(referee.foul_tolerance ?? 50),
    var_intervention_level: Number(referee.var_intervention_level ?? 50),
    risk_to_aggressive_team: round(Math.min(100, 40 + cards * 7 + aggressiveEdge * 0.1), 2),
    adjustment: round(cards > 4.8 ? -0.6 : cards < 3.2 ? 0.3 : 0, 3),
    data_quality: referee.cards_per_match == null ? 38 : 72
  };
}

function externalLayer(match = {}) {
  const kickoff = new Date(match.kickoff_time || Date.now());
  const hour = kickoff.getUTCHours();
  const temperature = Number(match.temperature ?? (hour >= 18 || hour <= 2 ? 22 : 27));
  const humidity = Number(match.humidity ?? 55);
  const weatherImpact = Math.max(0, temperature - 25) * 0.25 + Math.max(0, humidity - 65) * 0.06;
  return {
    weather_impact: round(weatherImpact, 2),
    temperature,
    humidity,
    rest_days_home: Number(match.rest_days_home ?? 5),
    rest_days_away: Number(match.rest_days_away ?? 5),
    travel_fatigue_home: Number(match.travel_fatigue_home ?? 45),
    travel_fatigue_away: Number(match.travel_fatigue_away ?? 45),
    venue_familiarity: Number(match.venue_familiarity ?? 50),
    adjustment: round((Number(match.rest_days_home ?? 5) - Number(match.rest_days_away ?? 5)) * 0.35 - weatherImpact * 0.05, 3),
    data_quality: match.temperature == null ? 44 : 70
  };
}

function liveProcessLayer(match = {}) {
  const minute = Number(match.minute || 0);
  const homeScore = Number(match.home_score || 0);
  const awayScore = Number(match.away_score || 0);
  const scoreEdge = homeScore - awayScore;
  return {
    minute,
    xg: match.xg || { home: null, away: null },
    shots_on_target: match.shots_on_target || { home: null, away: null },
    possession: match.possession || { home: null, away: null },
    red_card_impact: Number(match.red_card_impact || 0),
    momentum_score: round(50 + scoreEdge * Math.min(30, minute) * 0.18, 2),
    adjustment: round(minute > 0 ? scoreEdge * Math.min(3, minute / 30) : 0, 3),
    data_quality: minute > 0 ? 70 : 28
  };
}

function normalizeFactorWeights(input = {}, isLive = false) {
  const weights = { ...DEFAULT_FACTOR_WEIGHTS, ...input };
  if (!isLive) weights.live_process_weight = 0;
  return mapValues(weights, (value) => Number(value || 0));
}

async function evaluationsWithSnapshots(db, evaluations) {
  const rows = [];
  for (const row of evaluations) {
    const snapshot = await db.getLatestFeatureSnapshot?.(row.match_id);
    rows.push({
      ...row,
      snapshotQuality: snapshotQuality(snapshot)
    });
  }
  return rows;
}

function snapshotQuality(snapshot) {
  if (!snapshot) return 0;
  return average([
    snapshot.player_layer?.data_quality,
    snapshot.coach_layer?.data_quality,
    snapshot.referee_layer?.data_quality,
    snapshot.external_layer?.data_quality,
    snapshot.live_process_layer?.data_quality
  ]);
}

function adjustWeight(model, updates, factorName, delta, reason) {
  const oldWeight = Number(model[factorName] || 0);
  const cappedDelta = Math.max(-0.03, Math.min(0.03, delta));
  const lower = Math.max(0, oldWeight - 0.08);
  const upper = oldWeight + 0.08;
  const newWeight = Math.max(lower, Math.min(upper, oldWeight + cappedDelta));
  if (Math.abs(newWeight - oldWeight) < 0.0001) return;
  model[factorName] = newWeight;
  updates.push({ factor_name: factorName, old_weight: oldWeight, new_weight: newWeight, reason });
}

function normalizeFactorWeightSet(model) {
  const keys = ["base_team_weight", "player_weight", "coach_weight", "referee_weight", "external_weight", "live_process_weight"];
  const total = keys.reduce((sum, key) => sum + Number(model[key] || 0), 0) || 1;
  for (const key of keys) model[key] = round(Number(model[key] || 0) / total, 4);
}

function nextFactorVersion(current) {
  const base = String(current || "worldcup-ai-realtime-v1");
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  return `${base.replace(/-factors-\d{12,17}$/, "")}-factors-${stamp}`;
}

function metrics(input = {}) {
  const elo = Number(input.elo ?? 1600);
  return {
    attack: Number(input.attack ?? 50 + (elo - 1600) / 14),
    defense: Number(input.defense ?? 49 + (elo - 1600) / 16),
    form: Number(input.form ?? 50)
  };
}

function hasMetrics(match = {}) {
  return Boolean(match.homeMetrics || match.home_metrics || match.awayMetrics || match.away_metrics);
}

function metricEdge(home, away) {
  return home.attack * 0.45 + home.defense * 0.3 + home.form * 0.25 - (away.attack * 0.45 + away.defense * 0.3 + away.form * 0.25);
}

function layerAdjustment(layer = {}) {
  return Number(layer.adjustment || 0);
}

function sideLabel(value) {
  return Number(value || 0) >= 0 ? "the home side" : "the away side";
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

function mapValues(object, mapper) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, mapper(value, key)]));
}

function round(value, digits) {
  return Number((Number(value) || 0).toFixed(digits));
}
