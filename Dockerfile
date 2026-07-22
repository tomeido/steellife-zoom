# Stage 1: Build stage using latest Rust image (Edition 2024 support)
FROM rust:latest AS builder

WORKDIR /usr/src/slzoom

# Copy manifest and source files
COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Build release binary
RUN cargo build --release

# Stage 2: Runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy release binary and static assets
COPY --from=builder /usr/src/slzoom/target/release/slzoom /app/slzoom
COPY static /app/static

EXPOSE 3000
ENV RUST_LOG=info

CMD ["/app/slzoom"]
