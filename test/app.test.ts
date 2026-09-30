import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { Snapshot } from "../src/market.js";
import { HOUR, NOW, quote, stubMarket, testConfig } from "./helpers.js";

function freeApp(market = stubMarket()) {
  return createApp({ config: testConfig({ X402_ENABLED: "false" }), market, now: () => NOW });
}

const get = async (app: ReturnType<typeof freeApp>, path: string) => {
  const res = await app.request(`http://localhost${path}`);
  return { status: res.status, body: await res.json(), res };
};

describe("paid endpoints (payments off)", () => {
  it("answers each endpoint or a clear error", async () => {
    const app = freeApp();
    const cases: [string, number, string?][] = [
      ["/v1/gems?limit=3", 200],
      ["/v1/screen", 200],
      ["/v1/sectors?min_members=2", 200],
      ["/v1/sectors?sector=DePIN", 200],
      ["/v1/sectors?sector=nope", 404, "sector_not_found"],
      ["/v1/asset?asset=gemb", 200],
      ["/v1/asset", 200],
      ["/v1/asset?asset=nope", 404, "asset_not_found"],
      ["/v1/digest", 200],
      ["/v1/climbers", 503, "insufficient_history"],
      ["/v1/gems?limit=0", 400, "invalid_parameter"],
      ["/v1/gems?unknown=1", 400, "invalid_parameter"],
      ["/v1/new-listings", 404, "not_found"],
      ["/v1/resolve?query=BTC", 404, "not_found"],
    ];
    for (const [path, status, code] of cases) {
      const { status: got, body } = await get(app, path);
      expect(got, path).toBe(status);
      if (code) expect(body.error.code, path).toBe(code);
    }
  });

  it("returns the envelope and defaults /v1/screen to top turnover under $50M", async () => {
    const app = freeApp();
    const gems = await get(app, "/v1/gems?limit=3");
    expect(gems.body).toMatchObject({ source: "coinmarketcap", history_hours: 0 });
    expect(gems.body.data).toHaveLength(3);
    expect(gems.body.warnings[0].code).toBe("insufficient_history");
    const screen = await get(app, "/v1/screen");
    expect(screen.body.data[0].symbol).toBe("GEMB"); // 4M volume / 5M cap
    expect(screen.body.data.every((i: { market_cap: number }) => i.market_cap <= 50e6)).toBe(true);
    const asset = await get(app, "/v1/asset");
    expect(asset.body.data.symbol).toBe("ETH");
  });

  it("serves climbers once 24h of history exist", async () => {
    const m = stubMarket();
    m.hours = 30;
    m.hist.set(1, [{ at: NOW - 24 * HOUR, rank: 900, price: 1, marketCap: 1, volume24h: 1 }]);
    const { status, body } = await get(freeApp(m), "/v1/climbers");
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ rank_then: 900, rank: 601, rank_change: 299 });
  });

  it("refuses when data is missing or stale", async () => {
    const empty = stubMarket();
    empty.snap = new Snapshot([], NOW);
    expect((await get(freeApp(empty), "/v1/gems")).status).toBe(503);
    expect((await get(freeApp(empty), "/v1/status")).body.status).toBe("starting");

    const stale = stubMarket();
    const old = { ...quote(1, "OLD", 700, 5e6, 4e6, 1), fetchedAt: NOW - 3 * HOUR };
    stale.snap = new Snapshot([old], NOW - 3 * HOUR);
    const { status, body } = await get(freeApp(stale), "/v1/gems");
    expect(status).toBe(503);
    expect(body.error.code).toBe("upstream_unavailable");
  });

  it("documents every endpoint in OpenAPI", async () => {
    const { body } = await get(freeApp(), "/v1/openapi.json");
    expect(Object.keys(body.paths).sort()).toEqual(["/v1/asset", "/v1/climbers", "/v1/digest", "/v1/gems", "/v1/screen", "/v1/sectors"]);
    expect(body.paths["/v1/gems"].get["x-payment"]).toMatchObject({ price: "$0.02", asset: "31566704" });
  });

  it("treats 0 as no bound on gems filters", async () => {
    const app = freeApp();
    const dflt = (await get(app, "/v1/gems?limit=50")).body.data.map((g: { symbol: string }) => g.symbol);
    expect(dflt).not.toContain("BIG"); // $90B is over the default $50M cap
    const open = (await get(app, "/v1/gems?limit=50&max_market_cap=0&min_market_cap=0&min_volume=0")).body.data.map((g: { symbol: string }) => g.symbol);
    expect(open).toContain("BIG");
  });

  it("does not reject a large-cap screen just because the default max is lower", async () => {
    const app = freeApp();
    const ok = await get(app, "/v1/screen?min_market_cap=100000000");
    expect(ok.status).toBe(200);
    expect(ok.body.data.map((i: { symbol: string }) => i.symbol)).toEqual(expect.arrayContaining(["BIG", "ETH"]));
    const bad = await get(app, "/v1/screen?min_market_cap=100000000&max_market_cap=50000000");
    expect(bad.status).toBe(400); // an explicit contradiction is still an error
  });

  it("serves the trailing-slash form of a route it prices", async () => {
    const res = await freeApp().request("http://localhost/v1/gems/?limit=1");
    expect(res.status).toBe(200);
  });
});
