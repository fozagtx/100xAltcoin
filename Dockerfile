# syntax=docker/dockerfile:1
FROM golang:1.24-alpine AS build
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(git describe --tags --always 2>/dev/null || echo dev)" -o /100xaltcoin ./cmd/100xaltcoin

# Runs as root so it can write the history file on a mounted disk
# (Render and Railway mount volumes root-owned). The image has no shell.
FROM gcr.io/distroless/static-debian12
COPY --from=build /100xaltcoin /100xaltcoin
ENV HISTORY_FILE=/data/history.json.gz
EXPOSE 8080
ENTRYPOINT ["/100xaltcoin"]
