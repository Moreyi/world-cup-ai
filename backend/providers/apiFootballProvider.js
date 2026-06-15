export function createApiFootballProvider({ key = process.env.API_FOOTBALL_KEY } = {}) {
  return {
    name: "api-football",
    async fetchMatches({ days = 7, now = new Date() } = {}) {
      if (!key) throw new Error("API_FOOTBALL_KEY is not configured");
      const from = isoDay(now);
      const to = isoDay(new Date(startOfDay(now).getTime() + Number(days) * 24 * 60 * 60 * 1000));
      const payload = await request(`/fixtures?from=${from}&to=${to}`);
      return normalizeResponse(payload);
    },
    async fetchTodayMatches({ now = new Date() } = {}) {
      if (!key) throw new Error("API_FOOTBALL_KEY is not configured");
      const payload = await request(`/fixtures?date=${isoDay(now)}`);
      return normalizeResponse(payload);
    }
  };

  async function request(path) {
    const res = await fetch(`https://v3.football.api-sports.io${path}`, {
      headers: {
        "x-apisports-key": key,
        accept: "application/json"
      }
    });
    if (!res.ok) throw new Error(`api-football request failed: ${res.status}`);
    return res.json();
  }
}

function normalizeResponse(payload) {
  return (payload.response || []).map((row) => {
    const fixture = row.fixture || {};
    const league = row.league || {};
    const teams = row.teams || {};
    const goals = row.goals || {};
    const status = fixture.status || {};
    return {
      external_id: String(fixture.id),
      home_team: teams.home?.name || "Home",
      away_team: teams.away?.name || "Away",
      competition: league.name || "World Cup 2026",
      group_name: league.round || null,
      kickoff_time: fixture.date,
      status: normalizeStatus(status.short, status.elapsed),
      home_score: goals.home == null ? null : Number(goals.home),
      away_score: goals.away == null ? null : Number(goals.away),
      minute: status.elapsed == null ? null : Number(status.elapsed),
      venue: fixture.venue?.name || null
    };
  });
}

function normalizeStatus(short, elapsed) {
  if (["FT", "AET", "PEN"].includes(short)) return "finished";
  if (elapsed != null || ["1H", "2H", "HT", "ET", "BT", "P"].includes(short)) return "live";
  return "scheduled";
}

function startOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}
