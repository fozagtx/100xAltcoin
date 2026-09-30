package api

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// buildOpenAPI renders the OpenAPI 3.0 document from the same endpoint
// and parameter tables the handlers validate with.
func (s *Server) buildOpenAPI() []byte {
	paths := map[string]any{}
	for _, ep := range s.eps {
		params := make([]map[string]any, 0, len(ep.params))
		for _, p := range ep.params {
			params = append(params, paramDoc(p))
		}
		responses := map[string]any{
			"200": map[string]any{"description": "Success. Paid calls carry the settlement receipt in the PAYMENT-RESPONSE header.",
				"content": jsonContent(map[string]any{"type": "object"}, ep.example)},
			"400": errRef("Invalid or unknown parameter (checked before any payment is requested)."),
		}
		op := map[string]any{
			"operationId": ep.name,
			"summary":     ep.summary,
			"parameters":  params,
			"responses":   responses,
		}
		if ep.paid {
			price := s.cfg.Prices[ep.name]
			op["description"] = ep.summary + " Costs " + price + " in USDC per call via x402 (replaces the Telegram bot's " + ep.telegram + "). Errors are never charged."
			op["x-payment"] = map[string]any{"protocol": "x402", "x402Version": 2, "scheme": "exact", "price": price, "asset": "USDC"}
			responses["402"] = map[string]any{
				"description": "Payment required. The base64 PAYMENT-REQUIRED header lists the accepted payment (USDC amount, network, payTo); retry with a PAYMENT-SIGNATURE header.",
				"headers": map[string]any{"PAYMENT-REQUIRED": map[string]any{
					"description": "Base64-encoded x402 v2 PaymentRequired object.", "schema": map[string]any{"type": "string"}}},
			}
			responses["404"] = errRef("Asset or sector not found.")
			responses["503"] = errRef("Data not ready, too stale, not enough history (climbers), or payments temporarily unavailable. Never charged.")
		}
		paths[ep.path] = map[string]any{"get": op}
	}
	paths["/v1/openapi.json"] = map[string]any{"get": map[string]any{
		"operationId": "openapi", "summary": "This OpenAPI document. Free.",
		"responses": map[string]any{"200": map[string]any{"description": "OpenAPI 3.0 document."}},
	}}
	doc := map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title":   "100xAltcoin",
			"version": s.cfg.Version,
			"description": "Pay-per-call altcoin discovery for AI agents: find small caps with 100x potential early, " +
				"scored on turnover, rank climb, listing age and sector heat from CoinMarketCap data. " +
				"Paid endpoints use the x402 protocol (USDC on Base). Market data for information only, not financial advice.",
		},
		"paths": paths,
		"components": map[string]any{"schemas": map[string]any{"Error": map[string]any{
			"type": "object",
			"properties": map[string]any{"error": map[string]any{
				"type":     "object",
				"required": []string{"code", "message", "next_step"},
				"properties": map[string]any{
					"code":                map[string]any{"type": "string"},
					"message":             map[string]any{"type": "string"},
					"next_step":           map[string]any{"type": "string"},
					"param":               map[string]any{"type": "string"},
					"retry_after_seconds": map[string]any{"type": "integer"},
				},
			}},
		}}},
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		panic("api: openapi: " + err.Error())
	}
	return append(b, '\n')
}

func paramDoc(p paramSpec) map[string]any {
	schema := map[string]any{}
	switch p.kind {
	case kindInt:
		schema["type"] = "integer"
		schema["minimum"] = p.min
		if p.max > 0 {
			schema["maximum"] = p.max
		}
	case kindNumber:
		schema["type"] = "number"
		if p.min > -1e300 {
			schema["minimum"] = p.min
		}
	case kindEnum:
		schema["type"] = "string"
		schema["enum"] = p.enum
	case kindBool:
		schema["type"] = "boolean"
	default:
		schema["type"] = "string"
		schema["maxLength"] = p.maxLen
	}
	if p.def != "" {
		schema["default"] = typedDefault(p)
	}
	d := map[string]any{"name": p.name, "in": "query", "required": p.required, "description": p.desc, "schema": schema}
	if p.example != "" {
		d["example"] = p.example
	}
	return d
}

func typedDefault(p paramSpec) any {
	switch p.kind {
	case kindInt, kindNumber:
		if f, err := strconv.ParseFloat(p.def, 64); err == nil {
			return f
		}
	case kindBool:
		return p.def == "true"
	}
	return p.def
}

func jsonContent(schema map[string]any, example string) map[string]any {
	c := map[string]any{"schema": schema}
	if example != "" {
		var ex any
		if json.Unmarshal([]byte(example), &ex) == nil {
			c["example"] = ex
		}
	}
	return map[string]any{"application/json": c}
}

func errRef(desc string) map[string]any {
	return map[string]any{"description": desc,
		"content": map[string]any{"application/json": map[string]any{"schema": map[string]any{"$ref": "#/components/schemas/Error"}}}}
}

func (s *Server) handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(s.openapi)
}
