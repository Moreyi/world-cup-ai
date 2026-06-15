import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_DB_PATH = path.resolve(process.cwd(), process.env.JSON_DB_PATH || ".data/worldcup-db.json");

export function createDatabase(options = {}) {
  return createJsonDatabase(options);
}

export function createJsonDatabase({ filePath = DEFAULT_DB_PATH, seed = true } = {}) {
  const absolutePath = path.resolve(filePath);
  let state = readState(absolutePath, seed);

  function persist() {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify(state, null, 2));
  }

  return {
    kind: "json",
    path: absolutePath,

    async listMatches(filters = {}) {
      return state.matches
        .filter((match) => matchesFilters(match, filters))
        .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
    },

    async getMatch(id) {
      return state.matches.find((match) => match.id === id || match.external_id === id) || null;
    },

    async upsertMatch(input) {
      const now = new Date().toISOString();
      const externalId = input.external_id;
      if (!externalId) throw new Error("match external_id is required");
      const index = state.matches.findIndex((match) => match.external_id === externalId);
      if (index >= 0) {
        const previous = state.matches[index];
        const row = {
          ...previous,
          ...input,
          id: previous.id,
          created_at: previous.created_at,
          updated_at: now,
          last_synced_at: input.last_synced_at || now
        };
        state.matches[index] = row;
        persist();
        return row;
      }
      const row = {
        id: input.id || randomUUID(),
        ...input,
        status: normalizeStatus(input.status),
        created_at: input.created_at || now,
        updated_at: input.updated_at || now,
        last_synced_at: input.last_synced_at || now
      };
      state.matches.push(row);
      persist();
      return row;
    },

    async createPrediction(input) {
      const now = new Date().toISOString();
      const row = {
        id: input.id || randomUUID(),
        match_id: input.match_id,
        predicted_home_score: Number(input.predicted_home_score),
        predicted_away_score: Number(input.predicted_away_score),
        probability_home_win: Number(input.probability_home_win),
        probability_draw: Number(input.probability_draw),
        probability_away_win: Number(input.probability_away_win),
        confidence_score: Number(input.confidence_score),
        model_version: input.model_version,
        explanation: Array.isArray(input.explanation) ? input.explanation : [],
        created_at: input.created_at || now
      };
      state.predictions.push(row);
      persist();
      return row;
    },

    async getLatestPrediction(matchId) {
      return state.predictions
        .filter((prediction) => prediction.match_id === matchId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
    },

    async getPrediction(predictionId) {
      return state.predictions.find((prediction) => prediction.id === predictionId) || null;
    },

    async listPredictions() {
      return [...state.predictions].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    },

    async createSimulation(input) {
      const now = new Date().toISOString();
      const row = {
        id: input.id || randomUUID(),
        match_id: input.match_id,
        prediction_id: input.prediction_id,
        runs: Number(input.runs || 10000),
        most_common_scores: Array.isArray(input.most_common_scores) ? input.most_common_scores : [],
        stability: input.stability || "medium",
        created_at: input.created_at || now
      };
      state.simulations.push(row);
      persist();
      return row;
    },

    async getSimulationByPrediction(predictionId) {
      return state.simulations.find((simulation) => simulation.prediction_id === predictionId) || null;
    },

    async createTrustScore(input) {
      const now = new Date().toISOString();
      const row = {
        id: input.id || randomUUID(),
        match_id: input.match_id,
        prediction_id: input.prediction_id,
        trust_score: Number(input.trust_score),
        data_quality: Number(input.data_quality),
        model_stability: Number(input.model_stability),
        simulation_consistency: Number(input.simulation_consistency),
        historical_accuracy: Number(input.historical_accuracy),
        created_at: input.created_at || now
      };
      state.trust_scores.push(row);
      persist();
      return row;
    },

    async getTrustScoreByPrediction(predictionId) {
      return state.trust_scores.find((score) => score.prediction_id === predictionId) || null;
    },

    async createMatchFeatureSnapshot(input) {
      const now = new Date().toISOString();
      const row = {
        id: input.id || randomUUID(),
        match_id: input.match_id,
        prediction_id: input.prediction_id || null,
        model_version: input.model_version,
        player_layer: input.player_layer || {},
        coach_layer: input.coach_layer || {},
        referee_layer: input.referee_layer || {},
        external_layer: input.external_layer || {},
        live_process_layer: input.live_process_layer || {},
        created_at: input.created_at || now
      };
      state.match_feature_snapshots.push(row);
      persist();
      return row;
    },

    async getFeatureSnapshotByPrediction(predictionId) {
      return state.match_feature_snapshots
        .filter((snapshot) => snapshot.prediction_id === predictionId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
    },

    async getLatestFeatureSnapshot(matchId) {
      return state.match_feature_snapshots
        .filter((snapshot) => snapshot.match_id === matchId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
    },

    async upsertPostMatchStats(input) {
      const now = new Date().toISOString();
      const row = {
        match_id: input.match_id,
        home_score: nullableNumber(input.home_score),
        away_score: nullableNumber(input.away_score),
        home_shots: nullableNumber(input.home_shots),
        away_shots: nullableNumber(input.away_shots),
        home_shots_on_target: nullableNumber(input.home_shots_on_target),
        away_shots_on_target: nullableNumber(input.away_shots_on_target),
        home_possession: nullableNumber(input.home_possession),
        away_possession: nullableNumber(input.away_possession),
        home_cards: nullableNumber(input.home_cards),
        away_cards: nullableNumber(input.away_cards),
        goal_timeline: Array.isArray(input.goal_timeline) ? input.goal_timeline : [],
        updated_at: input.updated_at || now
      };
      const index = state.post_match_stats.findIndex((stats) => stats.match_id === row.match_id);
      if (index >= 0) state.post_match_stats[index] = { ...state.post_match_stats[index], ...row };
      else state.post_match_stats.push(row);
      persist();
      return index >= 0 ? state.post_match_stats[index] : row;
    },

    async getPostMatchStats(matchId) {
      return state.post_match_stats.find((stats) => stats.match_id === matchId) || null;
    },

    async upsertMatchResult(input) {
      const now = new Date().toISOString();
      const row = {
        match_id: input.match_id,
        actual_score: input.actual_score,
        actual_home_score: Number(input.actual_home_score),
        actual_away_score: Number(input.actual_away_score),
        winner: input.winner,
        source: input.source || "sync",
        verified_at: input.verified_at || now,
        created_at: input.created_at || now,
        updated_at: input.updated_at || now
      };
      const index = state.match_results.findIndex((result) => result.match_id === row.match_id);
      if (index >= 0) state.match_results[index] = { ...state.match_results[index], ...row, created_at: state.match_results[index].created_at };
      else state.match_results.push(row);
      persist();
      return index >= 0 ? state.match_results[index] : row;
    },

    async getMatchResult(matchId) {
      return state.match_results.find((result) => result.match_id === matchId) || null;
    },

    async createPredictionEvaluation(input) {
      const now = new Date().toISOString();
      const existing = state.prediction_evaluations.find((row) => row.prediction_id === input.prediction_id);
      if (existing) return existing;
      const row = {
        id: input.id || randomUUID(),
        prediction_id: input.prediction_id,
        match_id: input.match_id,
        model_version: input.model_version,
        result_correct: Boolean(input.result_correct),
        score_exact: Boolean(input.score_exact),
        score_error: Number(input.score_error),
        goal_total_error: Number(input.goal_total_error),
        brier_score: Number(input.brier_score),
        confidence_error: Number(input.confidence_error),
        created_at: input.created_at || now
      };
      state.prediction_evaluations.push(row);
      persist();
      return row;
    },

    async getPredictionEvaluation(predictionId) {
      return state.prediction_evaluations.find((row) => row.prediction_id === predictionId) || null;
    },

    async listPredictionEvaluations() {
      return [...state.prediction_evaluations].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    },

    async upsertModelStats(input) {
      const now = new Date().toISOString();
      const row = {
        model_version: input.model_version,
        accuracy_rate: Number(input.accuracy_rate || 0),
        total_matches: Number(input.total_matches || 0),
        correct_matches: Number(input.correct_matches || 0),
        avg_confidence: Number(input.avg_confidence || 0),
        exact_score_accuracy: Number(input.exact_score_accuracy || 0),
        average_score_error: Number(input.average_score_error || 0),
        brier_score: Number(input.brier_score || 0),
        confidence_calibration: Number(input.confidence_calibration || 0),
        updated_at: input.updated_at || now
      };
      const index = state.model_stats.findIndex((stats) => stats.model_version === row.model_version);
      if (index >= 0) state.model_stats[index] = { ...state.model_stats[index], ...row };
      else state.model_stats.push(row);
      persist();
      return index >= 0 ? state.model_stats[index] : row;
    },

    async listModelStats() {
      return [...state.model_stats].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    },

    async getActiveModelVersion() {
      const active = state.model_versions
        .filter((version) => version.is_active)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (active) return active;
      const initial = defaultModelVersion();
      state.model_versions.push(initial);
      persist();
      return initial;
    },

    async createModelVersion(input) {
      const now = new Date().toISOString();
      if (input.is_active) {
        state.model_versions = state.model_versions.map((version) => ({ ...version, is_active: false }));
      }
      const row = {
        model_version: input.model_version,
        attack_weight: Number(input.attack_weight),
        defense_weight: Number(input.defense_weight),
        form_weight: Number(input.form_weight),
        ranking_weight: Number(input.ranking_weight),
        h2h_weight: Number(input.h2h_weight),
        draw_bias: Number(input.draw_bias || 0),
        upset_bias: Number(input.upset_bias || 0),
        is_active: Boolean(input.is_active),
        created_at: input.created_at || now
      };
      state.model_versions.push(row);
      persist();
      return row;
    },

    async listModelVersions() {
      return [...state.model_versions].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },

    async getActiveModelFactorWeights() {
      const active = state.model_factor_weights
        .filter((weights) => weights.is_active)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (active) return active;
      const model = await this.getActiveModelVersion();
      const initial = defaultModelFactorWeights(model.model_version);
      state.model_factor_weights.push(initial);
      persist();
      return initial;
    },

    async createModelFactorWeights(input) {
      const now = new Date().toISOString();
      if (input.is_active) {
        state.model_factor_weights = state.model_factor_weights.map((weights) => ({ ...weights, is_active: false }));
      }
      const row = {
        id: input.id || randomUUID(),
        model_version: input.model_version,
        base_team_weight: Number(input.base_team_weight),
        player_weight: Number(input.player_weight),
        coach_weight: Number(input.coach_weight),
        referee_weight: Number(input.referee_weight),
        external_weight: Number(input.external_weight),
        live_process_weight: Number(input.live_process_weight),
        is_active: Boolean(input.is_active),
        created_at: input.created_at || now
      };
      state.model_factor_weights.push(row);
      persist();
      return row;
    },

    async listModelFactorWeights() {
      return [...state.model_factor_weights].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },

    async createModelFactorUpdate(input) {
      const now = new Date().toISOString();
      const row = {
        id: input.id || randomUUID(),
        model_version: input.model_version,
        factor_name: input.factor_name,
        old_weight: Number(input.old_weight),
        new_weight: Number(input.new_weight),
        reason: input.reason || "",
        based_on_matches_count: Number(input.based_on_matches_count || 0),
        created_at: input.created_at || now
      };
      state.model_factor_updates.push(row);
      persist();
      return row;
    },

    async createSyncLog(input) {
      const row = {
        id: input.id || randomUUID(),
        provider: input.provider,
        sync_type: input.sync_type,
        status: input.status,
        message: input.message || "",
        started_at: input.started_at,
        finished_at: input.finished_at || new Date().toISOString()
      };
      state.sync_logs.push(row);
      persist();
      return row;
    },

    async listSyncLogs() {
      return [...state.sync_logs].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    },

    async reset(nextState = emptyState()) {
      state = nextState;
      persist();
      return state;
    }
  };
}

function readState(filePath, seed) {
  if (fs.existsSync(filePath)) {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
  }
  const initial = seed ? seedState() : emptyState();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
  return initial;
}

function emptyState() {
  return {
    matches: [],
    predictions: [],
    simulations: [],
    trust_scores: [],
    match_feature_snapshots: [],
    model_factor_weights: [],
    post_match_stats: [],
    match_results: [],
    prediction_evaluations: [],
    model_stats: [],
    model_versions: [],
    model_factor_updates: [],
    sync_logs: []
  };
}

function seedState() {
  return emptyState();
}

function matchesFilters(match, filters) {
  if (filters.status && match.status !== filters.status) return false;
  if (filters.group && match.group_name !== filters.group) return false;
  if (filters.date) {
    const day = String(match.kickoff_time || "").slice(0, 10);
    if (day !== filters.date) return false;
  }
  return true;
}

function normalizeStatus(status) {
  if (status === "final") return "finished";
  return ["scheduled", "live", "finished"].includes(status) ? status : "scheduled";
}

function nullableNumber(value) {
  return value == null || value === "" ? null : Number(value);
}

function defaultModelVersion() {
  return {
    model_version: "worldcup-ai-realtime-v1",
    attack_weight: 0.3,
    defense_weight: 0.2,
    form_weight: 0.25,
    ranking_weight: 0.15,
    h2h_weight: 0.1,
    draw_bias: 0,
    upset_bias: 0,
    is_active: true,
    created_at: new Date().toISOString()
  };
}

function defaultModelFactorWeights(modelVersion) {
  return {
    id: randomUUID(),
    model_version: modelVersion || "worldcup-ai-realtime-v1",
    base_team_weight: 0.3,
    player_weight: 0.35,
    coach_weight: 0.12,
    referee_weight: 0.06,
    external_weight: 0.07,
    live_process_weight: 0.1,
    is_active: true,
    created_at: new Date().toISOString()
  };
}
