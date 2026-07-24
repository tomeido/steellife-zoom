# Stage 1: Build Rust backend & WASM module
FROM rust:bookworm AS builder

WORKDIR /usr/src/slzoom

# Copy Cargo configs and sources
COPY Cargo.toml Cargo.lock ./
COPY wasm_stt ./wasm_stt
COPY src ./src
COPY static ./static

# Build release backend binary
RUN cargo build --release

# Stage 2: Runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates ffmpeg python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy release binary and static assets (including static/pkg)
COPY --from=builder /usr/src/slzoom/target/release/slzoom /app/slzoom
COPY --from=builder /usr/src/slzoom/static /app/static

EXPOSE 3000
ENV RUST_LOG=info

CMD ["/app/slzoom"]
