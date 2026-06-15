export function createSportmonksProvider({ key = process.env.SPORTMONKS_KEY } = {}) {
  return {
    name: "sportmonks",
    async fetchMatches() {
      if (!key) throw new Error("SPORTMONKS_KEY is not configured");
      throw new Error("Sportmonks provider adapter is configured but not activated in this build");
    },
    async fetchTodayMatches() {
      if (!key) throw new Error("SPORTMONKS_KEY is not configured");
      throw new Error("Sportmonks provider adapter is configured but not activated in this build");
    }
  };
}
