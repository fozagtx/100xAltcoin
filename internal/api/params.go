package api

import (
	"fmt"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// paramKind says how a query parameter's value is parsed and validated.
type paramKind int

const (
	kindString paramKind = iota // free text
	kindInt                     // integer; min/max bound the value
	kindNumber                  // finite number; min bounds the value
	kindEnum                    // one of enum, case-insensitive
	kindBool                    // true/false/1/0
)

// paramSpec describes one query parameter an endpoint accepts. The same
// table drives request validation (before any payment is requested) and
// the OpenAPI document, so the two cannot drift apart.
type paramSpec struct {
	name     string
	kind     paramKind
	required bool
	def      string   // default value as text; "" when none
	enum     []string // allowed values for kindEnum
	min, max float64  // inclusive bounds; max 0 means unbounded
	maxLen   int      // maximum length of the raw value in bytes
	desc     string   // one sentence for the docs
	example  string   // example value for the docs
}

var paramLimit = func(def string, max float64) paramSpec {
	return paramSpec{name: "limit", kind: kindInt, def: def, min: 1, max: max, maxLen: 10,
		desc: "Maximum number of rows returned.", example: def}
}

// optionalNumber is an unbounded numeric filter; the empty default marks
// it as not provided, which the handler checks with present.
func optionalNumber(name, desc, example string) paramSpec {
	return paramSpec{name: name, kind: kindNumber, min: -math.MaxFloat64, maxLen: 30, desc: desc, example: example}
}

// queryParams is a request's validated query string.
type queryParams struct {
	vals  url.Values
	specs []paramSpec
}

// parseQuery parses the request's query string and rejects parameters the
// endpoint does not accept, repeated parameters and oversized values.
func parseQuery(r *http.Request, path string, specs []paramSpec) (*queryParams, *apiError) {
	q := &queryParams{specs: specs, vals: url.Values{}}
	if r.URL.RawQuery == "" {
		return q, nil
	}
	vals, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, invalidParam("", "The query string is malformed.",
			"Send parameters as name=value pairs joined by &, with values URL-encoded.", nil)
	}
	var unknown []string
	for name, vs := range vals {
		spec, ok := findSpec(specs, name)
		if !ok {
			unknown = append(unknown, name)
			continue
		}
		if len(vs) > 1 {
			return nil, invalidParam(name, fmt.Sprintf("Parameter %s was given %d times.", name, len(vs)),
				fmt.Sprintf("Pass %s once.", name), nil)
		}
		if len(vs[0]) > spec.maxLen {
			return nil, invalidParam(name, fmt.Sprintf("Parameter %s is longer than %d characters.", name, spec.maxLen),
				fmt.Sprintf("Shorten %s.", name), nil)
		}
	}
	if len(unknown) > 0 {
		slices.Sort(unknown)
		return nil, unknownParam(path, unknown[0], specs)
	}
	q.vals = vals
	return q, nil
}

func unknownParam(path, name string, specs []paramSpec) *apiError {
	names := make([]string, len(specs))
	for i, s := range specs {
		names[i] = s.name
	}
	next := fmt.Sprintf("Remove %s; %s takes no parameters.", truncate(name, 40), path)
	if len(names) > 0 {
		next = fmt.Sprintf("Remove %s; %s accepts only: %s.", truncate(name, 40), path, strings.Join(names, ", "))
	}
	e := invalidParam(truncate(name, 40), fmt.Sprintf("Unknown parameter %q.", truncate(name, 40)), next, names)
	if len(names) == 0 {
		e.detail.AllowedValues = []string{}
	}
	return e
}

func findSpec(specs []paramSpec, name string) (paramSpec, bool) {
	for _, s := range specs {
		if s.name == name {
			return s, true
		}
	}
	return paramSpec{}, false
}

// validate parses every declared parameter once, so a bad value is
// rejected before the client is asked to pay.
func (q *queryParams) validate() *apiError {
	for _, spec := range q.specs {
		var err *apiError
		switch spec.kind {
		case kindString:
			_, err = q.str(spec.name)
		case kindInt:
			_, err = q.int(spec.name)
		case kindNumber:
			if spec.def != "" || q.present(spec.name) {
				_, err = q.number(spec.name)
			}
		case kindEnum:
			_, err = q.enum(spec.name)
		case kindBool:
			_, err = q.boolean(spec.name)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// value returns the trimmed raw value of name and its spec. It panics if
// name is not declared for the endpoint, which is a programming error.
func (q *queryParams) value(name string) (string, paramSpec) {
	spec, ok := findSpec(q.specs, name)
	if !ok {
		panic("api: undeclared parameter " + name)
	}
	return strings.TrimSpace(q.vals.Get(name)), spec
}

// str returns a required or optional free-text parameter.
func (q *queryParams) str(name string) (string, *apiError) {
	v, spec := q.value(name)
	if v == "" {
		if spec.required {
			return "", missingParam(name)
		}
		return spec.def, nil
	}
	return v, nil
}

// int returns an integer parameter within its bounds.
func (q *queryParams) int(name string) (int, *apiError) {
	v, spec := q.value(name)
	if v == "" {
		v = spec.def
	}
	n, err := strconv.Atoi(v)
	if err != nil || float64(n) < spec.min || (spec.max > 0 && float64(n) > spec.max) {
		return 0, invalidParam(name,
			fmt.Sprintf("%s must be a whole number from %g to %g; got %q.", name, spec.min, spec.max, truncate(v, 30)),
			fmt.Sprintf("Retry with %s between %g and %g, or omit it for the default %s.", name, spec.min, spec.max, spec.def), nil)
	}
	return n, nil
}

// number returns a finite numeric parameter of at least spec.min.
func (q *queryParams) number(name string) (float64, *apiError) {
	v, spec := q.value(name)
	if v == "" {
		v = spec.def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < spec.min {
		msg := fmt.Sprintf("%s must be a number of at least %g; got %q.", name, spec.min, truncate(v, 30))
		if spec.min == -math.MaxFloat64 {
			msg = fmt.Sprintf("%s must be a number; got %q.", name, truncate(v, 30))
		}
		return 0, invalidParam(name, msg,
			fmt.Sprintf("Retry with a plain number such as %s=%s, or omit it.", name, spec.example), nil)
	}
	return f, nil
}

// enum returns an enumerated parameter, lower-cased.
func (q *queryParams) enum(name string) (string, *apiError) {
	v, spec := q.value(name)
	if v == "" {
		return spec.def, nil
	}
	lv := strings.ToLower(v)
	if !slices.Contains(spec.enum, lv) {
		return "", invalidParam(name,
			fmt.Sprintf("%s must be one of %s; got %q.", name, strings.Join(spec.enum, ", "), truncate(v, 30)),
			fmt.Sprintf("Retry with one of allowed_values, or omit %s for the default %s.", name, spec.def), spec.enum)
	}
	return lv, nil
}

// present reports whether the parameter was sent with a non-empty value.
func (q *queryParams) present(name string) bool {
	v, _ := q.value(name)
	return v != ""
}

// optNumber returns an optional numeric parameter: ok is false when it
// was not provided.
func (q *queryParams) optNumber(name string) (float64, bool, *apiError) {
	if !q.present(name) {
		return 0, false, nil
	}
	v, err := q.number(name)
	if err != nil {
		return 0, false, err
	}
	return v, true, nil
}

// boolean returns a bool parameter: true, false, 1 or 0.
func (q *queryParams) boolean(name string) (bool, *apiError) {
	v, spec := q.value(name)
	if v == "" {
		v = spec.def
	}
	switch strings.ToLower(v) {
	case "true", "1", "yes":
		return true, nil
	case "false", "0", "no":
		return false, nil
	}
	return false, invalidParam(name,
		fmt.Sprintf("%s must be true or false; got %q.", name, truncate(v, 30)),
		fmt.Sprintf("Retry with %s=true or %s=false, or omit it for the default %s.", name, name, spec.def), nil)
}

func missingParam(name string) *apiError {
	return invalidParam(name, fmt.Sprintf("Parameter %s is required.", name),
		fmt.Sprintf("Retry with %s set; see GET /v1/openapi.json for examples.", name), nil)
}

// truncate shortens s to at most n bytes (on a rune boundary) so error
// messages never echo huge inputs.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !isRuneStart(s[n]) {
		n--
	}
	return s[:n] + "..."
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }
