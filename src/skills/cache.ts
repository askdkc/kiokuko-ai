import type { SkillSearchResult } from './types.js';
import { cacheKey } from './providers/schema.js';

export class SkillDiscoveryCache {
  private readonly flights = new Map<string, Promise<SkillSearchResult>>();
  async getOrLoad(input: { provider: string; query: string; owner?: string | null; mode: string; loader: () => Promise<SkillSearchResult> }): Promise<{ result: SkillSearchResult; hit: boolean }> {
    const key = cacheKey(input);
    const existingFlight = this.flights.get(key);
    if (existingFlight) return { result: await existingFlight, hit: true };
    const flight = input.loader();
    this.flights.set(key, flight);
    try { return { result: await flight, hit: false }; } finally { this.flights.delete(key); }
  }
}
