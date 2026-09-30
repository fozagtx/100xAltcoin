package api

import (
	"bytes"
	"html/template"
	"net/http"
)

var docsTmpl = template.Must(template.New("docs").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>100xAltcoin</title>
<style>
:root { --bg:#fbfbf9; --fg:#1d1d1b; --muted:#6b6b66; --line:#e3e2dc; --card:#ffffff; --accent:#0b6b4f; --code:#f1f0ea; }
@media (prefers-color-scheme: dark) { :root { --bg:#121311; --fg:#ecebe6; --muted:#9a9a93; --line:#2a2b28; --card:#1a1b19; --accent:#4fc79c; --code:#20211f; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width: 920px; margin: 0 auto; padding: 40px 16px 64px; }
h1 { font-size: 2rem; margin: 0 0 4px; letter-spacing: -0.02em; }
h2 { font-size: 1.15rem; margin: 36px 0 12px; }
p.lead { color: var(--muted); margin: 0 0 24px; max-width: 70ch; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 0.94rem; }
th { font-weight: 600; color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: 0; }
td.price { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; white-space: nowrap; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.86rem; }
code { background: var(--code); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--code); padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
.wrap { overflow-x: auto; }
ul { padding-left: 20px; }
.muted { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>100xAltcoin</h1>
<p class="lead">Pay-per-call altcoin discovery for AI agents. Every call scores the CoinMarketCap top {{.TopN}} on turnover, rank climb, listing age and sector heat to surface small caps before they move. Paid with <a href="https://x402.org">x402</a>: USDC on {{.Network}}, no API key, no signup.</p>

<h2>Endpoints</h2>
<div class="wrap"><table>
<thead><tr><th>Endpoint</th><th>Price</th><th>Replaces</th><th>What it returns</th></tr></thead>
<tbody>
{{range .Endpoints}}<tr><td><code>GET {{.Path}}</code></td><td class="price">{{.Price}}</td><td class="muted">{{.Telegram}}</td><td>{{.Summary}}</td></tr>
{{end}}<tr><td><code>GET /v1/openapi.json</code></td><td class="price">free</td><td></td><td>OpenAPI 3.0 document with every parameter.</td></tr>
</tbody></table></div>

<h2>How paying works</h2>
<ul>
<li>Call a paid endpoint without payment: you get <code>402</code> and a base64 <code>PAYMENT-REQUIRED</code> header with the USDC amount, network and recipient.</li>
<li>Sign the USDC transfer authorization it describes and retry with a <code>PAYMENT-SIGNATURE</code> header. Any x402 v2 client does both steps for you.</li>
<li>Only successful answers are settled. Bad parameters, unknown assets, stale data or missing history are refused <em>before</em> payment is requested, and no error is ever charged.</li>
</ul>
<pre>import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
});

const res = await pay("{{.Base}}/v1/gems?limit=5");
console.log(await res.json());</pre>
<p class="muted">From Go: <code>go run ./cmd/payclient -url {{.Base}}/v1/gems</code> with <code>PAYER_PRIVATE_KEY</code> set (see the README).</p>

<h2>Removed from the Telegram bot</h2>
<ul>
<li><code>/new</code> (new listings): needs CMC <code>/listings/new</code>, which only Startup plans and up include; the bot never produced a listing alert.</li>
<li><code>/climbers 7d</code>: needs a week of unbroken history; only the 24h window is offered.</li>
<li><code>/resolve</code> and on-demand lookups outside the tracked top N: they needed CMC <code>/map</code>, <code>/quotes</code> and <code>/info</code>. <code>/v1/asset</code> now reads the tracked snapshot only.</li>
</ul>
<p class="muted">Version {{.Version}}. Market data for information only, not financial advice.</p>
</main>
</body>
</html>
`))

type docsEndpoint struct {
	Path, Price, Telegram, Summary string
}

func (s *Server) buildDocsPage() []byte {
	data := struct {
		TopN      int
		Network   string
		Base      string
		Version   string
		Endpoints []docsEndpoint
	}{
		TopN:    s.market.Status().TopN,
		Network: "Base",
		Base:    "https://your-host",
		Version: s.cfg.Version,
	}
	if s.cfg.Paywall != nil {
		if st := s.cfg.Paywall.Status(); st.NetworkName != "" {
			data.Network = st.NetworkName
		}
	}
	if s.cfg.PublicURL != "" {
		data.Base = s.cfg.PublicURL
	}
	for _, ep := range s.eps {
		price := "free"
		if ep.paid {
			price = s.cfg.Prices[ep.name]
			if s.cfg.Paywall == nil {
				price += " (off)"
			}
		}
		data.Endpoints = append(data.Endpoints, docsEndpoint{Path: ep.path, Price: price, Telegram: ep.telegram, Summary: ep.summary})
	}
	var buf bytes.Buffer
	if err := docsTmpl.Execute(&buf, data); err != nil {
		panic("api: docs page: " + err.Error())
	}
	return buf.Bytes()
}

func (s *Server) handleDocs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(s.docs)
}
