import { createApiFootballProvider } from "./apiFootballProvider.js";
import { createSportmonksProvider } from "./sportmonksProvider.js";
import { mockProvider } from "./mockProvider.js";

export function createProvider(name = process.env.FOOTBALL_API_PROVIDER || "mock") {
  if (name === "api-football") return createApiFootballProvider();
  if (name === "sportmonks") return createSportmonksProvider();
  return mockProvider;
}

export { mockProvider };
