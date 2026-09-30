import type { FacilitatorClient } from "@x402/core/server";
import { ResourceInfoSchema } from "@x402/core/schemas";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { ALGORAND_MAINNET, CHALLENGE_TAG } from "../src/config.js";
import { createPayments } from "../src/x402.js";
import { NOW, PAY_TO, stubMarket, testConfig } from "./helpers.js";

/** A GoPlausible stand-in that accepts every payment and records calls. */
// GoPlausible has advertised the full genesis-hash id; the SDK constant is the short form.
const MAINNET_FULL = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

function fakeFacilitator(network: string = ALGORAND_MAINNET) {
  const calls = { verify: 0, settle: 0, lastRequirements: undefined as Record<string, unknown> | undefined };
  const client = {
    getSupported: async () => ({
      kinds: [
        { x402Version: 2, scheme: "exact", network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe", extra: { feePayer: PAY_TO } },
        { x402Version: 2, scheme: "exact", network, extra: { feePayer: PAY_TO } },
      ],
      extensions: ["bazaar"],
      signers: {},
    }),
    verify: async (_payload: unknown, requirements: Record<string, unknown>) => {
      calls.verify++;
      calls.lastRequirements = requirements;
      return { isValid: true, payer: "PAYER" };
    },
    settle: async () => {
      calls.settle++;
      return { success: true, transaction: "TXID123", network, payer: "PAYER" };
    },
  } as unknown as FacilitatorClient;
  return { client, calls };
}

function setup(market = stubMarket(), network: string = ALGORAND_MAINNET) {
  const cfg = testConfig();
  const fac = fakeFacilitator(network);
  const app = createApp({ config: cfg, market, payments: createPayments(cfg, fac.client), now: () => NOW });
  return { app, fac, market };
}

const decode = (h: string | null) => JSON.parse(Buffer.from(h ?? "", "base64").toString("utf8"));

async function paymentFor(app: ReturnType<typeof setup>["app"], path: string) {
  const res = await app.request(`https://100xaltcoin.example.com${path}`);
  const required = decode(res.headers.get("PAYMENT-REQUIRED"));
  // A syntactically complete x402 v2 AVM payload; the fake facilitator accepts it.
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: { paymentGroup: ["c2lnbmVkLXR4bg=="], paymentIndex: 0 },
    extensions: required.extensions,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("x402 on Algorand", () => {
  it("answers every unpaid paid-route call with 402 and challenge-ready requirements", async () => {
    const { app, fac } = setup();
    for (const path of ["/v1/gems", "/v1/screen", "/v1/climbers", "/v1/sectors", "/v1/asset", "/v1/digest"]) {
      const res = await app.request(`https://100xaltcoin.example.com${path}`);
      expect(res.status, path).toBe(402);
      const body = await res.json();
      expect(body.error.code).toBe("payment_required");
      const req = decode(res.headers.get("PAYMENT-REQUIRED"));
      expect(req.x402Version).toBe(2);
      expect(req.resource.url).toBe(`https://100xaltcoin.example.com${path}`);
      const opt = req.accepts[0];
      expect(opt).toMatchObject({ scheme: "exact", network: ALGORAND_MAINNET, asset: "31566704", payTo: PAY_TO });
      expect(opt.extra.tag).toBe(CHALLENGE_TAG);
      expect(req.extensions.bazaar.info.input.method).toBe("GET");
    }
    const gems = decode((await app.request("https://100xaltcoin.example.com/v1/gems")).headers.get("PAYMENT-REQUIRED"));
    expect(gems.accepts[0].amount).toBe("20000"); // $0.02 in 6-decimal USDC
    expect(fac.calls.verify).toBe(0);
  });

  it("verifies, serves and settles a paid call", async () => {
    const { app, fac } = setup();
    const sig = await paymentFor(app, "/v1/gems?limit=2");
    const res = await app.request("https://100xaltcoin.example.com/v1/gems?limit=2", { headers: { "PAYMENT-SIGNATURE": sig } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(decode(res.headers.get("PAYMENT-RESPONSE")).transaction).toBe("TXID123");
    expect(fac.calls).toMatchObject({ verify: 1, settle: 1 });
    expect(fac.calls.lastRequirements).toMatchObject({ amount: "20000", asset: "31566704", extra: { tag: CHALLENGE_TAG } });
  });

  it("never settles a paid call that fails", async () => {
    const { app, fac } = setup();
    for (const path of ["/v1/asset?asset=doesnotexist", "/v1/gems?limit=500", "/v1/climbers"]) {
      const sig = await paymentFor(app, path);
      const res = await app.request(`https://100xaltcoin.example.com${path}`, { headers: { "PAYMENT-SIGNATURE": sig } });
      expect(res.status, path).toBeGreaterThanOrEqual(400);
    }
    expect(fac.calls.settle).toBe(0);
  });

  it("keeps the free routes free", async () => {
    const { app, fac } = setup();
    for (const path of ["/", "/health", "/v1/status", "/v1/openapi.json", "/.well-known/x402", "/llms.txt"]) {
      const res = await app.request(`https://100xaltcoin.example.com${path}`);
      expect(res.status, path).toBe(200);
    }
    const manifest = await (await app.request("https://100xaltcoin.example.com/.well-known/x402")).json();
    expect(manifest.tags).toContain(CHALLENGE_TAG);
    expect(manifest.resources).toHaveLength(6);
    expect(fac.calls.verify).toBe(0);
  });

  it("uses the network id exactly as the facilitator advertises it", async () => {
    for (const advertised of [ALGORAND_MAINNET, MAINNET_FULL]) {
      const { app, fac } = setup(stubMarket(), advertised);
      const res = await app.request("https://100xaltcoin.example.com/v1/gems");
      expect(res.status).toBe(402);
      expect(decode(res.headers.get("PAYMENT-REQUIRED")).accepts[0].network).toBe(advertised);
      const sig = await paymentFor(app, "/v1/gems");
      const paid = await app.request("https://100xaltcoin.example.com/v1/gems", { headers: { "PAYMENT-SIGNATURE": sig } });
      expect(paid.status).toBe(200);
      expect(fac.calls.settle).toBe(1);
    }
  });

  it("answers 503 (not charged) while the facilitator is unreachable, then recovers", async () => {
    const cfg = testConfig();
    const fac = fakeFacilitator();
    let down = true;
    const flaky = { ...fac.client, getSupported: async () => { if (down) throw new Error("ECONNREFUSED"); return fac.client.getSupported(); } } as typeof fac.client;
    const app = createApp({ config: cfg, market: stubMarket(), payments: createPayments(cfg, flaky), now: () => NOW });
    const res = await app.request("https://100xaltcoin.example.com/v1/gems");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("facilitator_unavailable");
    down = false;
    expect((await app.request("https://100xaltcoin.example.com/v1/gems")).status).toBe(402);
  });

  it("serves the metadata the Bazaar reads", async () => {
    const { app } = setup();
    const page = await (await app.request("https://100xaltcoin.example.com/")).text();
    expect(page).toContain('<meta name="description"');
    expect(page).toContain('og:image');
    const logo = await app.request("https://100xaltcoin.example.com/logo.svg");
    expect(logo.headers.get("content-type")).toContain("image/svg+xml");
    const card = await (await app.request("https://100xaltcoin.example.com/.well-known/agent-card.json")).json();
    expect(card.skills).toHaveLength(6);
    for (const path of ["/robots.txt", "/sitemap.xml", "/openapi.json"]) {
      expect((await app.request(`https://100xaltcoin.example.com${path}`)).status, path).toBe(200);
    }
    const req = decode((await app.request("https://100xaltcoin.example.com/v1/gems")).headers.get("PAYMENT-REQUIRED"));
    expect(req.resource.serviceName ?? "100xAltcoin").toBe("100xAltcoin");
  });

  it("follows the x402 resource schema limits and declares the merchant identity", async () => {
    const { app } = setup();
    for (const path of ["/v1/gems", "/v1/screen", "/v1/climbers", "/v1/sectors", "/v1/asset", "/v1/digest"]) {
      const req = decode((await app.request(`https://100xaltcoin.example.com${path}`)).headers.get("PAYMENT-REQUIRED"));
      expect(req.resource.tags.length, path).toBeLessThanOrEqual(5);
      expect(req.resource.tags.every((t: string) => t.length <= 32)).toBe(true);
      expect(req.resource.serviceName).toBe("100xAltcoin");
      expect(req.resource.iconUrl).toBe("https://100xaltcoin.example.com/logo.png");
      expect(ResourceInfoSchema.safeParse(req.resource).success, path).toBe(true);
      expect(req.extensions["x402-merchant"].info).toMatchObject({ name: "100xAltcoin", website: "https://100xaltcoin.example.com", logo: "https://100xaltcoin.example.com/logo.png" });
      expect(validateDiscoveryExtension(req.extensions.bazaar).valid, path).toBe(true);
    }
  });

  it("refuses HEAD on paid routes instead of answering a free 200", async () => {
    const { app } = setup();
    const head = await app.request("https://100xaltcoin.example.com/v1/gems", { method: "HEAD" });
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toContain("GET");
    expect((await app.request("https://100xaltcoin.example.com/v1/status", { method: "HEAD" })).status).toBe(200);
  });

  it("serves a PNG logo for the merchant page", async () => {
    const { app } = setup();
    const res = await app.request("https://100xaltcoin.example.com/logo.png");
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("reports the package version, not dev", async () => {
    const { readVersion } = await import("../src/version.js");
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("keeps route descriptions ASCII (the AVM paywall page base64-encodes them with btoa)", async () => {
    const { app } = setup();
    for (const path of ["/v1/gems", "/v1/screen", "/v1/climbers", "/v1/sectors", "/v1/asset", "/v1/digest"]) {
      const req = decode((await app.request(`https://100xaltcoin.example.com${path}`)).headers.get("PAYMENT-REQUIRED"));
      expect(/^[\x20-\x7e]*$/.test(req.resource.description), path).toBe(true);
    }
  });
});
