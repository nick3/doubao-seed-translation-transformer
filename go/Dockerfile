# Multi-stage build for doubao translation proxy
FROM golang:1.22 AS builder

WORKDIR /workspace

# Copy module definition and source
COPY go/ ./

ARG TARGETOS=linux
ARG TARGETARCH=amd64

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w" -o /workspace/doubao

# Use a valid distroless image. The older tag `base-nonroot:latest` no longer exists.
# Options:
#   - gcr.io/distroless/base-debian12:nonroot  (includes CA certs – good for HTTPS clients)
#   - gcr.io/distroless/static-debian12:nonroot (smallest, but no CA certs; only for fully static/no TLS outbound)
# We choose base-debian12:nonroot for safer defaults when the Go binary makes HTTPS requests.
FROM gcr.io/distroless/base-debian12:nonroot

WORKDIR /app

COPY --from=builder /workspace/doubao ./doubao

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/app/doubao"]
