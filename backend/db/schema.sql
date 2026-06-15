-- Real data sync schema for the football AI analytics platform.
-- PostgreSQL 14+ / Supabase compatible.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text UNIQUE NOT NULL,
  home_team text NOT NULL,
  away_team text NOT NULL,
  competition text NOT NULL,
  group_name text,
  kickoff_time timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  home_score int,
  away_score int,
  minute int,
  venue text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT matches_distinct_teams CHECK (home_team <> away_team),
  CONSTRAINT matches_status_check CHECK (status IN ('scheduled', 'live', 'finished')),
  CONSTRAINT matches_score_check CHECK (
    (home_score IS NULL OR home_score >= 0)
    AND (away_score IS NULL OR away_score >= 0)
  ),
  CONSTRAINT matches_minute_check CHECK (minute IS NULL OR minute BETWEEN 0 AND 130)
);

CREATE TABLE IF NOT EXISTS predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  predicted_home_score int NOT NULL,
  predicted_away_score int NOT NULL,
  probability_home_win numeric(6,5) NOT NULL,
  probability_draw numeric(6,5) NOT NULL,
  probability_away_win numeric(6,5) NOT NULL,
  confidence_score numeric(5,2) NOT NULL,
  model_version text NOT NULL,
  explanation jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT predictions_score_check CHECK (predicted_home_score >= 0 AND predicted_away_score >= 0),
  CONSTRAINT predictions_probability_range CHECK (
    probability_home_win BETWEEN 0 AND 1
    AND probability_draw BETWEEN 0 AND 1
    AND probability_away_win BETWEEN 0 AND 1
  ),
  CONSTRAINT predictions_probability_sum CHECK (
    abs((probability_home_win + probability_draw + probability_away_win) - 1) <= 0.001
  ),
  CONSTRAINT predictions_confidence_range CHECK (confidence_score BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS simulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  prediction_id uuid NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  runs int NOT NULL DEFAULT 10000,
  most_common_scores jsonb NOT NULL DEFAULT '[]'::jsonb,
  stability text NOT NULL DEFAULT 'medium',
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT simulations_runs_check CHECK (runs >= 100),
  CONSTRAINT simulations_stability_check CHECK (stability IN ('low', 'medium', 'high'))
);

CREATE TABLE IF NOT EXISTS trust_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  prediction_id uuid NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  trust_score numeric(5,2) NOT NULL,
  data_quality numeric(5,2) NOT NULL,
  model_stability numeric(5,2) NOT NULL,
  simulation_consistency numeric(5,2) NOT NULL,
  historical_accuracy numeric(5,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trust_scores_range CHECK (
    trust_score BETWEEN 0 AND 100
    AND data_quality BETWEEN 0 AND 100
    AND model_stability BETWEEN 0 AND 100
    AND simulation_consistency BETWEEN 0 AND 100
    AND historical_accuracy BETWEEN 0 AND 100
  )
);

CREATE TABLE IF NOT EXISTS match_feature_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  prediction_id uuid REFERENCES predictions(id) ON DELETE SET NULL,
  model_version text NOT NULL,
  player_layer jsonb NOT NULL DEFAULT '{}'::jsonb,
  coach_layer jsonb NOT NULL DEFAULT '{}'::jsonb,
  referee_layer jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_layer jsonb NOT NULL DEFAULT '{}'::jsonb,
  live_process_layer jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_factor_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version text NOT NULL,
  base_team_weight numeric(6,5) NOT NULL DEFAULT 0.30,
  player_weight numeric(6,5) NOT NULL DEFAULT 0.35,
  coach_weight numeric(6,5) NOT NULL DEFAULT 0.12,
  referee_weight numeric(6,5) NOT NULL DEFAULT 0.06,
  external_weight numeric(6,5) NOT NULL DEFAULT 0.07,
  live_process_weight numeric(6,5) NOT NULL DEFAULT 0.10,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT model_factor_weights_range CHECK (
    base_team_weight >= 0
    AND player_weight >= 0
    AND coach_weight >= 0
    AND referee_weight >= 0
    AND external_weight >= 0
    AND live_process_weight >= 0
  )
);

CREATE TABLE IF NOT EXISTS post_match_stats (
  match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  home_score int NOT NULL,
  away_score int NOT NULL,
  home_shots int,
  away_shots int,
  home_shots_on_target int,
  away_shots_on_target int,
  home_possession numeric(5,2),
  away_possession numeric(5,2),
  home_cards int,
  away_cards int,
  goal_timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT post_match_stats_score_check CHECK (home_score >= 0 AND away_score >= 0),
  CONSTRAINT post_match_stats_shots_check CHECK (
    (home_shots IS NULL OR home_shots >= 0)
    AND (away_shots IS NULL OR away_shots >= 0)
    AND (home_shots_on_target IS NULL OR home_shots_on_target >= 0)
    AND (away_shots_on_target IS NULL OR away_shots_on_target >= 0)
  ),
  CONSTRAINT post_match_stats_possession_check CHECK (
    (home_possession IS NULL OR home_possession BETWEEN 0 AND 100)
    AND (away_possession IS NULL OR away_possession BETWEEN 0 AND 100)
  )
);

CREATE TABLE IF NOT EXISTS match_results (
  match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  actual_score text NOT NULL,
  actual_home_score int NOT NULL,
  actual_away_score int NOT NULL,
  winner text NOT NULL,
  source text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT match_results_score_format CHECK (actual_score ~ '^[0-9]+-[0-9]+$'),
  CONSTRAINT match_results_winner_check CHECK (winner IN ('home', 'draw', 'away'))
);

CREATE TABLE IF NOT EXISTS prediction_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id uuid NOT NULL UNIQUE REFERENCES predictions(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  model_version text NOT NULL,
  result_correct boolean NOT NULL,
  score_exact boolean NOT NULL,
  score_error numeric(6,3) NOT NULL,
  goal_total_error numeric(6,3) NOT NULL,
  brier_score numeric(8,6) NOT NULL,
  confidence_error numeric(6,3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prediction_evaluations_error_check CHECK (
    score_error >= 0
    AND goal_total_error >= 0
    AND brier_score BETWEEN 0 AND 2
  )
);

CREATE TABLE IF NOT EXISTS model_versions (
  model_version text PRIMARY KEY,
  attack_weight numeric(6,5) NOT NULL,
  defense_weight numeric(6,5) NOT NULL,
  form_weight numeric(6,5) NOT NULL,
  ranking_weight numeric(6,5) NOT NULL,
  h2h_weight numeric(6,5) NOT NULL,
  draw_bias numeric(6,5) NOT NULL DEFAULT 0,
  upset_bias numeric(6,5) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT model_versions_weight_check CHECK (
    attack_weight >= 0
    AND defense_weight >= 0
    AND form_weight >= 0
    AND ranking_weight >= 0
    AND h2h_weight >= 0
  )
);

CREATE TABLE IF NOT EXISTS model_factor_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version text NOT NULL REFERENCES model_versions(model_version) ON DELETE CASCADE,
  factor_name text NOT NULL,
  old_weight numeric(8,5) NOT NULL,
  new_weight numeric(8,5) NOT NULL,
  reason text NOT NULL,
  based_on_matches_count int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT model_factor_updates_count_check CHECK (based_on_matches_count >= 0)
);

CREATE TABLE IF NOT EXISTS model_stats (
  model_version text PRIMARY KEY,
  accuracy_rate numeric(6,5) NOT NULL DEFAULT 0,
  total_matches int NOT NULL DEFAULT 0,
  correct_matches int NOT NULL DEFAULT 0,
  avg_confidence numeric(5,2) NOT NULL DEFAULT 0,
  exact_score_accuracy numeric(6,5) NOT NULL DEFAULT 0,
  average_score_error numeric(6,3) NOT NULL DEFAULT 0,
  brier_score numeric(8,6) NOT NULL DEFAULT 0,
  confidence_calibration numeric(6,3) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT model_stats_counts_check CHECK (
    total_matches >= 0
    AND correct_matches >= 0
    AND correct_matches <= total_matches
  )
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  sync_type text NOT NULL,
  status text NOT NULL,
  message text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,

  CONSTRAINT sync_logs_status_check CHECK (status IN ('success', 'fallback', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_matches_external_id ON matches (external_id);
CREATE INDEX IF NOT EXISTS idx_matches_status_kickoff ON matches (status, kickoff_time);
CREATE INDEX IF NOT EXISTS idx_matches_group ON matches (group_name);
CREATE INDEX IF NOT EXISTS idx_predictions_match_created ON predictions (match_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_simulations_prediction ON simulations (prediction_id);
CREATE INDEX IF NOT EXISTS idx_trust_scores_prediction ON trust_scores (prediction_id);
CREATE INDEX IF NOT EXISTS idx_match_feature_snapshots_match ON match_feature_snapshots (match_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_feature_snapshots_prediction ON match_feature_snapshots (prediction_id);
CREATE INDEX IF NOT EXISTS idx_prediction_evaluations_match ON prediction_evaluations (match_id);
CREATE INDEX IF NOT EXISTS idx_prediction_evaluations_model ON prediction_evaluations (model_version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_versions_one_active ON model_versions (is_active) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_factor_weights_one_active ON model_factor_weights (is_active) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_model_factor_updates_version ON model_factor_updates (model_version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_logs_started ON sync_logs (started_at DESC);
