export function calculateTrustScore({ prediction, match, historicalAccuracy = 62 } = {}) {
  const confidence = Number(prediction?.confidenceScore || prediction?.confidence_score || 0);
  const stability = Number(prediction?.confidence?.stability || confidence);
  const dataQuality = Number(prediction?.confidence?.dataQuality || sourceQuality(match));
  const simulationConsistency = Math.max(0, Math.min(100, stability));
  const trust = dataQuality * 0.3 + stability * 0.25 + simulationConsistency * 0.25 + Number(historicalAccuracy) * 0.2;
  return {
    trust_score: round(trust),
    data_quality: round(dataQuality),
    model_stability: round(stability),
    simulation_consistency: round(simulationConsistency),
    historical_accuracy: round(historicalAccuracy)
  };
}

function sourceQuality(match) {
  let score = 55;
  if (match?.homeMetrics || match?.home_metrics) score += 15;
  if (match?.awayMetrics || match?.away_metrics) score += 15;
  if (match?.venue) score += 5;
  return Math.min(100, score);
}

function round(value) {
  return Number(Math.max(0, Math.min(100, Number(value) || 0)).toFixed(2));
}
