// Command payclient calls one 100xAltcoin endpoint and pays for it with
// x402, using the official x402 Go SDK. It is the quickest way to test a
// deployment end to end on Base Sepolia.
//
// Usage:
//
//	PAYER_PRIVATE_KEY=0x... go run ./cmd/payclient -url http://localhost:8080/v1/gems?limit=5
//
// The payer needs testnet USDC on Base Sepolia (https://faucet.circle.com).
// Before signing, the requested amount is checked against -max.
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	evmclient "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

func main() {
	url := flag.String("url", "http://localhost:8080/v1/gems?limit=5", "endpoint to call")
	maxUSD := flag.Float64("max", 0.10, "refuse to pay more than this many USD per call")
	flag.Parse()
	if err := run(*url, *maxUSD); err != nil {
		fmt.Fprintln(os.Stderr, "payclient:", err)
		os.Exit(1)
	}
}

func run(url string, maxUSD float64) error {
	key := strings.TrimSpace(os.Getenv("PAYER_PRIVATE_KEY"))
	if key == "" {
		return errors.New("set PAYER_PRIVATE_KEY to the hex private key of a wallet holding USDC")
	}
	hc := &http.Client{Timeout: 60 * time.Second}

	// 1. Ask without paying, to see the price.
	resp, err := hc.Get(url)
	if err != nil {
		return err
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPaymentRequired {
		fmt.Printf("HTTP %d (no payment needed or request refused before payment)\n%s", resp.StatusCode, body)
		return nil
	}
	amount, network, err := quotedAmount(resp.Header.Get("PAYMENT-REQUIRED"))
	if err != nil {
		return err
	}
	// USDC has 6 decimals.
	limit := new(big.Int).SetInt64(int64(maxUSD * 1e6))
	if amount.Cmp(limit) > 0 {
		return fmt.Errorf("endpoint asks %s USDC base units on %s, over the -max limit of $%.2f", amount, network, maxUSD)
	}
	fmt.Printf("price: $%s USDC on %s\n", usd(amount), network)

	// 2. Pay and call.
	signer, err := evmsigners.NewClientSignerFromPrivateKey(key)
	if err != nil {
		return fmt.Errorf("private key: %w", err)
	}
	fmt.Printf("payer: %s\n", signer.Address())
	client := x402.Newx402Client().Register("eip155:*", evmclient.NewExactEvmScheme(signer, nil))
	payer := x402http.WrapHTTPClientWithPayment(hc, x402http.Newx402HTTPClient(client))
	resp, err = payer.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ = io.ReadAll(resp.Body)
	fmt.Printf("HTTP %d\n", resp.StatusCode)
	if h := resp.Header.Get("PAYMENT-RESPONSE"); h != "" {
		if raw, err := base64.StdEncoding.DecodeString(h); err == nil {
			fmt.Printf("settlement: %s\n", raw)
		}
	}
	fmt.Printf("%s", body)
	return nil
}

// quotedAmount decodes the PAYMENT-REQUIRED header and returns the first
// accepted option's amount and network.
func quotedAmount(header string) (*big.Int, string, error) {
	raw, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return nil, "", fmt.Errorf("PAYMENT-REQUIRED header: %w", err)
	}
	var pr struct {
		Accepts []struct {
			Amount  string `json:"amount"`
			Network string `json:"network"`
		} `json:"accepts"`
	}
	if err := json.Unmarshal(raw, &pr); err != nil || len(pr.Accepts) == 0 {
		return nil, "", fmt.Errorf("PAYMENT-REQUIRED header lists no payment option")
	}
	amt, ok := new(big.Int).SetString(pr.Accepts[0].Amount, 10)
	if !ok {
		return nil, "", fmt.Errorf("bad amount %q", pr.Accepts[0].Amount)
	}
	return amt, pr.Accepts[0].Network, nil
}

func usd(baseUnits *big.Int) string {
	r := new(big.Rat).SetFrac(baseUnits, big.NewInt(1e6))
	return strings.TrimRight(strings.TrimRight(r.FloatString(6), "0"), ".")
}
