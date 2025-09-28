# Multi-stage build for doubao translation proxy
FROM golang:1.22 AS builder

WORKDIR /workspace

# Copy module definition and source
COPY go/ ./

ARG TARGETOS=linux
ARG TARGETARCH=amd64

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w" -o /workspace/doubao

FROM gcr.io/distroless/base-nonroot

WORKDIR /app

COPY --from=builder /workspace/doubao ./doubao

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/app/doubao"]
