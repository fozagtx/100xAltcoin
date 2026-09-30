import { isAlgorandNetwork, normalizeAlgorandNetwork } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { MiddlewareHandler } from "hono";

import { CHALLENGE_TAG, type Config } from "./config.js";
import { ENDPOINTS, paramSchema } from "./endpoints.js";

export const SERVICE_NAME = "100xAltcoin";
// The x402 resource schema allows at most 5 tags of up to 32 printable ASCII characters each.
export const DISCOVERY_TAGS = ["crypto", "altcoins", "market-data", "ai-agents", "algorand"];
export const MERCHANT_CATEGORIES = ["crypto", "market-data", "ai-agents", "x402"];

/** The x402-merchant identity extension (info plus a JSON Schema for it, per the x402 v2 extension format). */
export function merchantExtension(publicUrl: string) {
  return {
    info: {
      name: SERVICE_NAME,
      website: publicUrl,
      logo: `${publicUrl}/logo.png`,
      categories: MERCHANT_CATEGORIES,
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        website: { type: "string" },
        logo: { type: "string" },
        categories: { type: "array", items: { type: "string" } },
      },
    },
  };
}

/** The x402 route table: one exact-scheme USDC option per paid endpoint, all to the same payTo. */
export function buildRoutes(cfg: Config, network: string): RoutesConfig {
  const x = cfg.x402;
  const routes: RoutesConfig = {};
  for (const ep of ENDPOINTS) {
    const price = x.prices[ep.name];
    routes[`GET ${ep.path}`] = {
      accepts: [
        {
          scheme: "exact",
          price,
          network: network as Network,
          payTo: x.payTo,
          // The facilitator attributes challenge volume by extra.tag.
          extra: { asset: x.usdcAssetId, tag: CHALLENGE_TAG },
        },
      ],
      ...(cfg.publicUrl ? { resource: cfg.publicUrl + ep.path } : {}),
      // Shown in the Bazaar catalog: says concretely what the caller gets.
      description: ep.description,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: DISCOVERY_TAGS,
      ...(cfg.publicUrl ? { iconUrl: `${cfg.publicUrl}/logo.png` } : {}),
      // Bazaar discovery: the facilitator catalogs the endpoint on its first settlement.
      extensions: {
        ...declareDiscoveryExtension({
          input: ep.exampleInput,
          inputSchema: {
            properties: Object.fromEntries(ep.params.map((p) => [p.name, paramSchema(p)])),
          },
          output: { example: ep.exampleOutput },
        }),
        // Optional identity block: lets us control the name, website, logo and
        // categories shown on the merchant page instead of letting the
        // facilitator guess them from the domain.
        ...(cfg.publicUrl ? { "x402-merchant": merchantExtension(cfg.publicUrl) } : {}),
      },
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          error: {
            code: "payment_required",
            message: `${ep.path} costs ${price} in USDC on Algorand ${x.networkName}, paid per call with x402.`,
            next_step:
              "Decode the base64 PAYMENT-REQUIRED header, sign the USDC transfer it describes and retry with a PAYMENT-SIGNATURE header. Any x402 v2 client with the Algorand (AVM) scheme does this for you.",
          },
          price,
          network,
          asset: `USDC (ASA ${x.usdcAssetId})`,
          docs: cfg.publicUrl ? `${cfg.publicUrl}/` : "/",
        },
      }),
    };
  }
  return routes;
}

/**
 * Picks the Algorand network id exactly as the facilitator advertises it in
 * /supported. The SDK's constant (ALGORAND_MAINNET_CAIP2) is the short form;
 * some GoPlausible deployments have advertised the full genesis-hash form.
 * Both name the same chain, but the route must use the facilitator's string.
 */
export async function resolveNetwork(client: FacilitatorClient, preferred: string): Promise<string> {
  const want = normalizeAlgorandNetwork(preferred);
  const supported = await client.getSupported();
  const kind = supported.kinds.find((k) => {
    if (k.scheme !== "exact" || k.x402Version !== 2 || !isAlgorandNetwork(k.network)) return false;
    try {
      return normalizeAlgorandNetwork(k.network) === want;
    } catch {
      return false;
    }
  });
  if (!kind) {
    const offered = supported.kinds.map((k) => `${k.scheme}@${k.network}`).join(", ");
    throw new Error(`facilitator does not offer exact x402 v2 payments on ${want} (it offers: ${offered || "nothing"})`);
  }
  return kind.network;
}

export interface Payments {
  middleware: MiddlewareHandler;
  /** The network id in use once resolved against the facilitator. */
  network(): string | undefined;
  /** Resolves when the facilitator has been reached and routes are built. */
  ready: () => Promise<string>;
}

/**
 * The x402 payment middleware backed by the GoPlausible facilitator. It first
 * reads the facilitator's supported networks (retrying on the next request
 * if the facilitator is unreachable), then hands every request to the
 * official @x402/hono middleware.
 */
export function createPayments(cfg: Config, facilitator?: FacilitatorClient): Payments {
  const client = facilitator ?? new HTTPFacilitatorClient({ url: cfg.x402.facilitatorUrl });
  let network: string | undefined;
  let building: Promise<{ mw: MiddlewareHandler; network: string }> | null = null;

  const build = () =>
    (building ??= (async () => {
      const net = await resolveNetwork(client, cfg.x402.network);
      const server = new x402ResourceServer(client);
      server.register(net as Network, new ExactAvmScheme());
      server.registerExtension(bazaarResourceServerExtension);
      const mw = paymentMiddleware(buildRoutes(cfg, net), server, {
        appName: SERVICE_NAME,
        testnet: cfg.x402.networkName === "testnet",
      });
      network = net;
      return { mw, network: net };
    })().catch((err) => {
      building = null; // try again on the next request
      throw err;
    }));

  return {
    network: () => network,
    ready: async () => (await build()).network,
    middleware: async (c, next) => {
      let built;
      try {
        built = await build();
      } catch (err) {
        console.error(JSON.stringify({ level: "warn", msg: "x402 facilitator unreachable", err: String(err) }));
        c.header("Retry-After", "10");
        return c.json({
          error: {
            code: "facilitator_unavailable",
            message: `The x402 facilitator (${cfg.x402.facilitatorUrl}) could not be reached: ${String(err).slice(0, 200)}`,
            next_step: "Retry in 10 seconds. You have not been charged.",
          },
        }, 503);
      }
      return built.mw(c, next);
    },
  };
}
