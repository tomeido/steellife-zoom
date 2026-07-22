mod ai;
mod handlers;
mod models;
mod state;
mod stt;

use anyhow::Result;
use axum::{
    routing::{get, post},
    Router,
};
use state::AppState;
use std::net::SocketAddr;
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
    trace::TraceLayer,
};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    // 1. Initialize logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "slzoom=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // 2. 100% Shared App State with XWhisper STT & AI Summarizer
    let app_state = AppState::new();

    // 3. Configure CORS & Explicit API Routes
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/rooms", post(handlers::room::create_room).get(handlers::room::list_rooms))
        .route("/api/rooms/:id", get(handlers::room::get_room))
        .route("/api/minutes/generate", post(handlers::minutes::generate_minutes))
        .route("/api/ws", get(handlers::ws::ws_handler))
        .nest_service("/", ServeDir::new("static"))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(app_state);

    // 4. Start HTTP Server (bind to 0.0.0.0 for Docker & local access)
    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    info!("🚀 SLZoom Enterprise Server running on http://0.0.0.0:3000 (XWhisper Engine Active)");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
