import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import type { ResourceServerExtension } from "@x402/core/types";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { MiddlewareHandler } from "hono";

import { CHALLENGE_TAG, type Config } from "./config.js";
import { ENDPOINTS, paramSchema } from "./endpoints.js";

export const SERVICE_NAME = "100xAltcoin";
export const DISCOVERY_TAGS = ["crypto", "altcoins", "market-data", "ai-agents", "algorand", "usdc"];

/** The x402 route table: one exact-scheme USDC option per paid endpoint. */
export function buildRoutes(cfg: Config): RoutesConfig {
  const x = cfg.x402;
  const routes: RoutesConfig = {};
  for (const ep of ENDPOINTS) {
    const price = x.prices[ep.name];
    routes[`GET ${ep.path}`] = {
      accepts: [
        {
          scheme: "exact",
          price,
          network: x.network,
          payTo: x.payTo,
          // The facilitator attributes challenge volume by extra.tag.
          extra: { asset: x.usdcAssetId, tag: CHALLENGE_TAG },
        },
      ],
      ...(cfg.publicUrl ? { resource: cfg.publicUrl + ep.path } : {}),
      description: ep.description,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: DISCOVERY_TAGS,
      // Bazaar discovery: the facilitator catalogs the endpoint on its first settlement.
      extensions: declareDiscoveryExtension({
        input: ep.exampleInput,
        inputSchema: {
          properties: Object.fromEntries(ep.params.map((p) => [p.name, paramSchema(p)])),
        },
        output: { example: ep.exampleOutput },
      }),
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
          network: x.network,
          asset: `USDC (ASA ${x.usdcAssetId})`,
          docs: cfg.publicUrl ? `${cfg.publicUrl}/` : "/",
        },
      }),
    };
  }
  return routes;
}

/** The x402 payment middleware backed by the GoPlausible facilitator. */
export function createPaymentMiddleware(cfg: Config, facilitator?: FacilitatorClient): MiddlewareHandler {
  const client = facilitator ?? new HTTPFacilitatorClient({ url: cfg.x402.facilitatorUrl });
  const server = new x402ResourceServer(client);
  server.register(cfg.x402.network, new ExactAvmScheme());
  server.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);
  return paymentMiddleware(buildRoutes(cfg), server, {
    appName: SERVICE_NAME,
    testnet: cfg.x402.networkName === "testnet",
  });
}
