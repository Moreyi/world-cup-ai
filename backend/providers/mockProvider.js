import { STARTER_GROUPS } from "../../src/data.js";
import { buildGroupMatchAnalysis } from "../../src/matchAnalysis.js";

export const mockProvider = {
  name: "mock",
  async fetchMatches({ days = 7, now = new Date() } = {}) {
    const start = startOfDay(now);
    const end = new Date(start.getTime() + Number(days) * 24 * 60 * 60 * 1000);
    const matches = buildGroupMatchAnalysis(STARTER_GROUPS, { todayDate: isoDay(start) }).matches.map(fromAnalysisMatch);
    const windowed = matches.filter((match) => {
      const kickoff = new Date(match.kickoff_time);
      return kickoff >= start && kickoff < end;
    });

    // The fallback provider also backs static SEO match pages. Keep every
    // generated match addressable through /api/match/:id even when the daily
    // schedule sync only asks for the next few days.
    return unionByExternalId([...windowed, ...matches]);
  },
  async fetchTodayMatches({ now = new Date() } = {}) {
    const day = isoDay(now);
    return buildGroupMatchAnalysis(STARTER_GROUPS, { todayDate: day }).matches
      .map(fromAnalysisMatch)
      .filter((match) => isoDay(new Date(match.kickoff_time)) === day || match.status === "live");
  }
};

function unionByExternalId(matches) {
  const seen = new Set();
  const out = [];
  for (const match of matches) {
    if (seen.has(match.external_id)) continue;
    seen.add(match.external_id);
    out.push(match);
  }
  return out;
}

function fromAnalysisMatch(match) {
  const fixture = match.fixture || {};
  const result = match.result || null;
  return {
    external_id: `WorldCup:${slug(match.teamA.name)}-vs-${slug(match.teamB.name)}`,
    home_team: match.teamA.name,
    away_team: match.teamB.name,
    competition: "World Cup 2026",
    group_name: `Group ${match.group}`,
    kickoff_time: fixture.dateTime || `${fixture.date || "2026-06-13"}T00:00:00Z`,
    status: normalizeStatus(result?.status || fixture.status),
    home_score: result?.score?.teamA ?? null,
    away_score: result?.score?.teamB ?? null,
    minute: result?.minute ?? null,
    venue: fixture.venue || null,
    homeMetrics: {
      elo: match.teamA.elo,
      attack: ratingToMetric(match.teamA.elo + 10),
      defense: ratingToMetric(match.teamA.elo - 10),
      form: match.teamA.form ?? 50
    },
    awayMetrics: {
      elo: match.teamB.elo,
      attack: ratingToMetric(match.teamB.elo + 10),
      defense: ratingToMetric(match.teamB.elo - 10),
      form: match.teamB.form ?? 50
    }
  };
}

function normalizeStatus(status) {
  if (status === "final") return "finished";
  if (status === "live") return "live";
  if (status === "finished") return "finished";
  return "scheduled";
}

function ratingToMetric(elo) {
  return Math.max(20, Math.min(95, 50 + (Number(elo) - 1600) / 14));
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function startOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}
