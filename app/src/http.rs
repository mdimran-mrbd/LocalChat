//! HTTP routes: embedded static assets, uploads, downloads, WS upgrade,
//! plus admin-API mount.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, Response, StatusCode, Uri},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use compact_str::ToCompactString;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

use crate::admin;
use crate::message::{FileInfo, MsgKind, WireMsg, now_secs};
use crate::state::AppState;

#[derive(RustEmbed)]
#[folder = "web/"]
struct WebAssets;

pub async fn serve(
    state: Arc<AppState>,
    ready: oneshot::Sender<u16>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let port = {
        let cfg = state.config.read().unwrap();
        let requested = if cfg.port > 0 { Some(cfg.port) } else { None };
        crate::net::pick_port(requested)?
    };
    state
        .bound_port
        .store(port, std::sync::atomic::Ordering::Relaxed);

    let app = Router::new()
        .route("/ws", get(ws_upgrade))
        .route("/api/info", get(info))
        .route("/api/recovery/challenge", post(recovery_challenge))
        .route("/api/recovery/reset", post(recovery_reset))
        .route("/api/tls/ca.pem", get(download_ca_certificate))
        .route("/api/update/install", post(install_update))
        .route("/api/share", get(share))
        .route(
            "/api/upload",
            // Disable Axum's default 2 MiB body cap; we enforce
            // `max_upload_mb` ourselves while streaming the multipart
            // body, so videos and large files don't trip the parser
            // with a generic "Error parsing multipart/form-data".
            post(upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/download/:filename", get(download))
        .route("/uploads/:filename", get(serve_upload))
        .nest("/api/admin", admin::router())
        .fallback(serve_asset)
        .with_state(Arc::clone(&state));

    let _ = ready.send(port);

    // Serve everything over HTTPS on the chosen port (443 preferred, else
    // first free port in the preferred list) so browsers grant getUserMedia / Web Crypto on LAN. A self-signed cert
    // is auto-generated under <app_root>/tls/ on first run.
    serve_tls(state, app, port).await
}

async fn serve_tls(
    state: Arc<AppState>,
    app: Router,
    port: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use axum_server::tls_rustls::RustlsConfig;

    // Initialize the rustls crypto provider once (idempotent).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let tls_dir = state.app_root.join("tls");
    std::fs::create_dir_all(&tls_dir)?;
    let cert_path = tls_dir.join("cert.pem");
    let key_path = tls_dir.join("key.pem");
    let ca_cert_path = tls_dir.join("ca-cert.pem");
    let ca_key_path = tls_dir.join("ca-key.pem");

    // Create a persistent local CA once, then issue a server certificate for
    // localhost and the current LAN addresses. Only the public CA certificate
    // is exposed to clients; the CA private key never leaves the host.
    if !ca_key_path.exists() || !ca_cert_path.exists() {
        use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose};
        let ca_key = KeyPair::generate()?;
        let mut ca_params = CertificateParams::new(Vec::<String>::new())?;
        ca_params.distinguished_name.push(DnType::CommonName, "LocalChat Local Network CA");
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let ca_cert = ca_params.self_signed(&ca_key)?;
        std::fs::write(&ca_cert_path, ca_cert.pem())?;
        std::fs::write(&ca_key_path, ca_key.serialize_pem())?;
        crate::applog::log(format_args!(
            "tls: created local CA; public certificate at {}", ca_cert_path.display()
        ));
    }

    // Rebuild the issuer object from the persistent key. The CA's subject and
    // parameters remain stable so certificates issued on later launches chain
    // to the same trusted root.
    use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose};
    let ca_key_pem = std::fs::read_to_string(&ca_key_path)?;
    let ca_key = KeyPair::from_pem(&ca_key_pem)?;
    let mut ca_params = CertificateParams::new(Vec::<String>::new())?;
    ca_params.distinguished_name.push(DnType::CommonName, "LocalChat Local Network CA");
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let ca_cert = ca_params.self_signed(&ca_key)?;

    let mut server_params = CertificateParams::new(build_cert_sans())?;
    server_params.distinguished_name.push(DnType::CommonName, "LocalChat Server");
    server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let server_key = KeyPair::generate()?;
    let server_cert = server_params.signed_by(&server_key, &ca_cert, &ca_key)?;
    std::fs::write(&cert_path, server_cert.pem())?;
    std::fs::write(&key_path, server_key.serialize_pem())?;

    let cfg = RustlsConfig::from_pem_file(cert_path, key_path).await?;
    let addr: std::net::SocketAddr = ([0, 0, 0, 0], port).into();
    axum_server::bind_rustls(addr, cfg)
        .serve(app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .await?;
    Ok(())
}

/// Downloadable public trust anchor for this LocalChat host. The private CA
/// key is never served by this endpoint.
async fn download_ca_certificate(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let path = state.app_root.join("tls").join("ca-cert.pem");
    match tokio::fs::read(path).await {
        Ok(cert) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, HeaderValue::from_static("application/x-pem-file")),
                (header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment; filename=localchat-root-ca.pem")),
                (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
            ],
            cert,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Subject-Alternative-Names that the cert should cover. Includes
/// localhost, 127.0.0.1, and every detected LAN address so browsers
/// don't yell about a hostname mismatch on first visit.
fn build_cert_sans() -> Vec<String> {
    let mut sans: Vec<String> = vec!["localhost".into(), "127.0.0.1".into()];
    for ip in crate::net::lan_addresses() {
        sans.push(ip);
    }
    sans
}

// ── WS ───────────────────────────────────────────────────────────────

async fn ws_upgrade(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ip = addr.ip().to_string();
    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(256)
        .collect::<String>();
    ws.on_upgrade(move |socket: WebSocket| crate::ws::handle(socket, state, ip, ua))
}

// ── Info ─────────────────────────────────────────────────────────────

async fn info(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // CI stamps the release tag (e.g. "1.0.6") into LOCALCHAT_VERSION at
    // build time via env! so the binary's reported version matches the
    // GitHub release that produced it. Cargo.toml stays at "1.0.0" for
    // local dev where the tag is unknown — in that case we fall back to
    // CARGO_PKG_VERSION. Strip a leading "v" so the value compares cleanly
    // against GitHub tag_names like "v1.0.6".
    let version = option_env!("LOCALCHAT_VERSION")
        .map(|v| v.trim_start_matches('v'))
        .filter(|v| !v.is_empty())
        .unwrap_or(env!("CARGO_PKG_VERSION"));
    let build = option_env!("LOCALCHAT_BUILD").unwrap_or("dev");
    Json(json!({
        "addresses": crate::net::lan_addresses(),
        "hostname": hostname(),
        "version": version,
        "build": build,
        "server_id": state.server_id,
        "data_dir": state.app_root.display().to_string(),
        "uploads_dir": state.uploads_dir.display().to_string(),
        "logs_dir": state.logs_dir.display().to_string(),
    }))
}

/// Public share info: the URLs this server is reachable at, plus
/// pre-rendered SVG QR codes. No auth — these are addresses any joined
/// user already knows (they're connected to one of them).
async fn share(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    let port = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.rsplit(':').next())
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or_else(|| {
            let p = state.bound_port.load(std::sync::atomic::Ordering::Relaxed);
            if p > 0 { p } else {
                let cfg = state.config.read().unwrap();
                if cfg.port > 0 { cfg.port } else { 443 }
            }
        });

    let mut entries: Vec<serde_json::Value> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    let mut push = |label: &str, url: String| -> Option<serde_json::Value> {
        if !seen.insert(url.clone()) { return None; }
        Some(json!({ "label": label, "url": url.clone(), "qr": render_qr_svg(&url) }))
    };

    // Only expose true LAN addresses (192.168.x.x). Skips localhost and
    // virtual adapters like 172.x (Hyper-V / WSL) that other phones can't
    // route to anyway.
    for ip in crate::net::lan_addresses() {
        if ip.starts_with("192.168.") {
            if let Some(v) = push("LAN", format!("https://{ip}:{port}")) { entries.push(v); }
        }
    }

    Json(json!({ "entries": entries }))
}

fn render_qr_svg(data: &str) -> String {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};
    match QrCode::with_error_correction_level(data.as_bytes(), EcLevel::M) {
        Ok(code) => code
            .render::<svg::Color<'_>>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(svg::Color("#0f172a"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}

fn hostname() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "localhost".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("HOST"))
            .unwrap_or_else(|_| "localhost".into())
    }
}

// ── Upload / Download ────────────────────────────────────────────────

async fn upload(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let max_bytes = {
        let cfg = state.config.read().unwrap();
        cfg.max_upload_mb.saturating_mul(1024 * 1024)
    };

    // Fail fast on obviously oversized requests — 1 MiB slack for
    // multipart framing overhead. Streaming check below is still the
    // authoritative limit.
    if let Some(len) = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    {
        if len > max_bytes.saturating_add(1024 * 1024) {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, "file too big".into()));
        }
    }

    // Atomically: stream the file body to disk, then (if non-file
    // metadata fields are also present) insert a `file` message into
    // the channel and broadcast it. This collapses the previous
    // two-step "POST + WS announce" flow into a single request, so
    // the upload either fully succeeds (file on disk + chat message
    // in DB + broadcast to peers) or fails as a unit.
    //
    // Expected multipart fields (in any order, but `file` must be
    // last so we have all the metadata when we insert):
    //   session  – token from the WS welcome envelope (auth)
    //   channel  – channel id to post into
    //   text     – optional message text (E2EE envelope for DM files)
    //   client_id – optional client-supplied dedupe id
    //   file     – the bytes
    let mut session: Option<String> = None;
    let mut channel: Option<String> = None;
    let mut text: String = String::new();
    let mut client_id: Option<String> = None;
    let mut purpose: Option<String> = None;

    let mut file_info: Option<FileInfo> = None;
    let mut file_size: u64 = 0;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "session" => {
                session = Some(field.text().await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?);
            }
            "channel" => {
                channel = Some(field.text().await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?);
            }
            "text" => {
                text = field.text().await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
            }
            "client_id" => {
                client_id = Some(field.text().await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?);
            }
            "purpose" => {
                purpose = Some(field.text().await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?);
            }
            "file" => {
                let original = field.file_name().unwrap_or("upload.bin").to_string();
                let mime = field.content_type().unwrap_or("application/octet-stream").to_string();
                let ext = std::path::Path::new(&original)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| format!(".{s}"))
                    .unwrap_or_default();
                let id = uuid::Uuid::new_v4().simple().to_string();
                let stored = format!("{id}{ext}");
                let path = state.uploads_dir.join(&stored);

                let mut f = tokio::fs::File::create(&path)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

                let mut total: u64 = 0;
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
                {
                    total += chunk.len() as u64;
                    if total > max_bytes {
                        drop(f);
                        let _ = tokio::fs::remove_file(&path).await;
                        return Err((StatusCode::PAYLOAD_TOO_LARGE, "file too big".into()));
                    }
                    f.write_all(&chunk)
                        .await
                        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                }
                f.flush()
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

                state.metrics.inc_upload(total);
                file_size = total;
                file_info = Some(FileInfo {
                    id: id.to_compact_string(),
                    original_name: original,
                    filename: stored.to_compact_string(),
                    size: total,
                    mime_type: mime.to_compact_string(),
                    url: format!("/uploads/{stored}").to_compact_string(),
                });
            }
            _ => {
                // Drain unknown fields so the parser can advance.
                let _ = field.bytes().await;
            }
        }
    }

    let info = file_info
        .ok_or((StatusCode::BAD_REQUEST, "no 'file' field".into()))?;

    // Resolve user from session token. Without a valid token the
    // file is still saved but no message is created (legacy behaviour
    // for any non-WS caller). The WS client always supplies one now.
    let user_id = session
        .as_deref()
        .and_then(|t| state.sessions.get(t).map(|e| e.value().clone()));

    // Authenticated profile picture upload. The client crops to a square;
    // the server independently validates image signature and size.
    if purpose.as_deref() == Some("profile_avatar") {
        let Some(uid) = user_id.clone() else {
            let _ = tokio::fs::remove_file(state.uploads_dir.join(info.filename.as_str())).await;
            return Err((StatusCode::UNAUTHORIZED, "session expired — refresh and try again".into()));
        };
        if file_size > 2*1024*1024 || !matches!(info.mime_type.as_str(),"image/webp"|"image/jpeg"|"image/png") {
            let _ = tokio::fs::remove_file(state.uploads_dir.join(info.filename.as_str())).await;
            return Err((StatusCode::BAD_REQUEST,"profile pictures must be JPEG, PNG, or WebP under 2 MB".into()));
        }
        let bytes=tokio::fs::read(state.uploads_dir.join(info.filename.as_str())).await.map_err(|_|(StatusCode::INTERNAL_SERVER_ERROR,"could not verify image".into()))?;
        let valid=(bytes.starts_with(&[0x52,0x49,0x46,0x46])&&bytes.get(8..12)==Some(&b"WEBP"[..]))||bytes.starts_with(&[0xFF,0xD8,0xFF])||bytes.starts_with(&[0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
        if !valid { let _=tokio::fs::remove_file(state.uploads_dir.join(info.filename.as_str())).await; return Err((StatusCode::BAD_REQUEST,"uploaded content is not a supported image".into())); }
        let avatar_url=info.url.to_string();
        let old=state.users.get(&uid).map(|u|u.avatar.to_string()).unwrap_or_default();
        state.db.update_user_avatar(uid.clone(),&avatar_url).await.map_err(|_|(StatusCode::INTERNAL_SERVER_ERROR,"could not save profile picture".into()))?;
        if let Some(mut u)=state.users.get_mut(&uid){u.avatar=avatar_url.clone().into();}
        if let Some(mut u)=state.known_users.get_mut(&uid){u.avatar=avatar_url.clone().into();}
        let username=state.users.get(&uid).map(|u|u.username.to_string()).unwrap_or_default();
        let _=state.db.insert_upload(&info.filename,&info.original_name,info.mime_type.as_str(),file_size,Some(uid.clone()),&username,now_secs()).await;
        if old.starts_with("/uploads/")&&old!=avatar_url { let name=old.trim_start_matches("/uploads/"); if !name.contains('/')&&!name.contains('\\'){let _=tokio::fs::remove_file(state.uploads_dir.join(name)).await;} }
        let users:Vec<_>=state.users.iter().map(|e|e.value().clone()).collect();
        let payload=json!({"ev":"users","users":users}).to_string();
        if let Some(lobby)=state.channels.get(crate::channel::LOBBY_ID){
            let _=lobby.tx.send(Arc::new(WireMsg{id:0,channel:lobby.id.clone(),kind:MsgKind::System,user_id:uid.clone(),username:"__presence".into(),avatar:"".into(),color:"".into(),ts:now_secs(),text:payload,file:None,reply_to:None,edited_at:None,deleted:true}));
        }
        return Ok(Json(json!({"avatar":avatar_url})));
    }

    // Group-photo uploads are a separate authenticated operation: they
    // update channel metadata and never create a chat message. The client
    // resizes/crops first; the server still enforces strict size/type checks.
    if purpose.as_deref() == Some("channel_photo") {
        let (Some(uid), Some(ch_id)) = (user_id.clone(), channel.clone()) else {
            let _ = tokio::fs::remove_file(state.uploads_dir.join(info.filename.as_str())).await;
            return Err((StatusCode::UNAUTHORIZED, "session expired — refresh and try again".into()));
        };
        if file_size > 2 * 1024 * 1024 || !matches!(info.mime_type.as_str(), "image/webp" | "image/jpeg" | "image/png") {
            let _ = tokio::fs::remove_file(state.uploads_dir.join(info.filename.as_str())).await;
            return Err((StatusCode::BAD_REQUEST, "group photos must be JPEG, PNG, or WebP under 2 MB".into()));
        }
        let bytes = tokio::fs::read(state.uploads_dir.join(info.filename.as_str())).await
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "could not verify image".into()))?;
        let valid_signature = (bytes.starts_with(&[0x52, 0x49, 0x46, 0x46]) && bytes.get(8..12) == Some(&b"WEBP"[..]))
            || bytes.starts_with(&[0xFF, 0xD8, 0xFF])
            || bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        if !valid_signature {
            let _ = tokio::fs::remove_file(state.uploads_dir.join(info.filename.as_str())).await;
            return Err((StatusCode::BAD_REQUEST, "uploaded content is not a supported image".into()));
        }
        let ch = state.channels.get(&ch_id)
            .ok_or((StatusCode::BAD_REQUEST, "no such channel".into()))?;
        if !matches!(ch.kind, crate::channel::ChannelKind::Group) {
            let _ = tokio::fs::remove_file(state.uploads_dir.join(info.filename.as_str())).await;
            return Err((StatusCode::BAD_REQUEST, "only groups can have a group photo".into()));
        }
        let role = state.db.member_role(&ch_id, uid.as_str()).await
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "could not check group permissions".into()))?;
        if ch.created_by != uid && role.as_deref() != Some("moderator") && role.as_deref() != Some("owner") {
            let _ = tokio::fs::remove_file(state.uploads_dir.join(info.filename.as_str())).await;
            return Err((StatusCode::FORBIDDEN, "only group owners and moderators can change the photo".into()));
        }
        let (name, description, old_photo) = state.db.channel_details(&ch_id).await
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "could not load group details".into()))?
            .ok_or((StatusCode::BAD_REQUEST, "group no longer exists".into()))?;
        let photo_url = info.url.to_string();
        state.db.update_channel_details(&ch_id, &name, &description, &photo_url).await
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "could not save group photo".into()))?;
        let uploaded_by_name = state.users.get(&uid).map(|u| u.username.to_string()).unwrap_or_default();
        let _ = state.db.insert_upload(&info.filename, &info.original_name, info.mime_type.as_str(), file_size, Some(uid.clone()), &uploaded_by_name, now_secs()).await;
        if old_photo.starts_with("/uploads/") && old_photo != photo_url {
            let old_name = old_photo.trim_start_matches("/uploads/");
            if !old_name.contains('/') && !old_name.contains('\\') {
                let _ = tokio::fs::remove_file(state.uploads_dir.join(old_name)).await;
            }
        }
        if let Some(lobby) = state.channels.get(crate::channel::LOBBY_ID) {
            let payload = json!({"channel":ch_id,"photoUrl":photo_url});
            let update = Arc::new(WireMsg {
                id: 0,
                channel: lobby.id.clone(),
                kind: MsgKind::System,
                user_id: uid.clone(),
                username: "__ch_photo_updated".into(),
                avatar: "".into(),
                color: "".into(),
                ts: now_secs(),
                text: payload.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: true,
            });
            let _ = lobby.tx.send(update);
        }
        return Ok(Json(json!({ "photoUrl": photo_url })));
    }

    // Always record the upload in the durable index for the admin
    // dashboard, regardless of whether a message was created.
    let uploaded_by_name = user_id
        .as_ref()
        .and_then(|uid| state.users.get(uid).map(|u| u.username.to_string()))
        .unwrap_or_default();
    let _ = state.db.insert_upload(
        &info.filename,
        &info.original_name,
        info.mime_type.as_str(),
        file_size,
        user_id.clone(),
        &uploaded_by_name,
        now_secs(),
    ).await;

    // No session / no channel → return file info without posting
    // (kept for the unauthenticated drop-in test path; production
    // clients always pass session+channel).
    let (Some(uid), Some(ch_id)) = (user_id, channel.clone()) else {
        // If the client tried to post (i.e. supplied a `session` or
        // `channel` field) but auth failed, fail loudly so the user
        // gets a toast instead of a silently-orphaned file.
        if session.is_some() || channel.is_some() {
            return Err((StatusCode::UNAUTHORIZED, "session expired — refresh and try again".into()));
        }
        return Ok(Json(serde_json::to_value(&info).unwrap_or(json!({}))));
    };

    // Idempotency: if the client retries the same logical upload
    // (the JS outbox replays after a refresh), we'd see a fresh
    // file_id but the same client_id. Use that to avoid posting
    // duplicate messages. A cold replay (different client_id) would
    // post twice — clients are responsible for stable client_ids.
    if let Some(cid) = client_id.as_deref() {
        if let Ok(Some(_existing)) = state.db.message_id_for_client_id(cid).await {
            return Ok(Json(json!({
                "file": info,
                "deduped": true,
            })));
        }
    }

    let ch = state.channels.get(&ch_id)
        .ok_or((StatusCode::BAD_REQUEST, "no such channel".into()))?;
    if !matches!(ch.kind, crate::channel::ChannelKind::Lobby) && !ch.members.contains(&uid) {
        return Err((StatusCode::FORBIDDEN, "not a member".into()));
    }
    let user = state.users.get(&uid)
        .ok_or((StatusCode::UNAUTHORIZED, "user gone".into()))?
        .clone();

    let msg = Arc::new(WireMsg {
        id: state.next_msg_id(),
        channel: ch_id.to_compact_string(),
        kind: MsgKind::File,
        user_id: uid.clone(),
        username: user.username.clone(),
        avatar: user.avatar.clone(),
        color: user.color.clone(),
        ts: now_secs(),
        text,
        file: Some(info.clone()),
        reply_to: None,
        edited_at: None,
        deleted: false,
    });
    ch.push_history(msg.clone()).await;
    if let Err(e) = state.db.insert_message(&msg).await {
        crate::applog::log(format_args!("db.insert_message FAILED (upload): {e}"));
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("db write failed: {e}")));
    }
    if let Some(cid) = client_id.as_deref() {
        let _ = state.db.set_message_client_id(msg.id, cid).await;
    }
    if file_size > 0 {
        let _ = state.db.bump_user_uploaded(uid, file_size).await;
    }
    state.metrics.inc_messages();
    let _ = ch.tx.send(msg.clone());

    Ok(Json(json!({
        "file": info,
        "messageId": msg.id,
    })))
}

#[derive(Deserialize)]
struct DownloadQuery {
    name: Option<String>,
}

async fn download(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
    Query(q): Query<DownloadQuery>,
) -> impl IntoResponse {
    let safe = std::path::Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let path = state.uploads_dir.join(safe);
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let disp_name = q.name.unwrap_or_else(|| safe.to_string());
            let mime = mime_guess::from_path(&path)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
            let mut headers = HeaderMap::new();
            if let Ok(v) = HeaderValue::from_str(&mime) {
                headers.insert(header::CONTENT_TYPE, v);
            }
            if let Ok(v) = HeaderValue::from_str(&format!(
                "attachment; filename=\"{}\"",
                disp_name.replace('"', "'")
            )) {
                headers.insert(header::CONTENT_DISPOSITION, v);
            }
            (StatusCode::OK, headers, bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn serve_upload(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> impl IntoResponse {
    let safe = std::path::Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let path = state.uploads_dir.join(safe);
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&path)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
            let mut headers = HeaderMap::new();
            if let Ok(v) = HeaderValue::from_str(&mime) {
                headers.insert(header::CONTENT_TYPE, v);
            }
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, must-revalidate"),
            );
            (StatusCode::OK, headers, bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

// ── Embedded static assets (the web/ folder) ─────────────────────────

async fn serve_asset(
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    uri: Uri,
) -> impl IntoResponse {
    let mut p = uri.path().trim_start_matches('/').to_string();
    if p.is_empty() {
        p = "index.html".into();
    }
    // Admin path convenience: /admin → admin.html
    if p == "admin" || p == "admin/" {
        p = "admin.html".into();
    }
    // The admin dashboard is host-only. Treat as 404 from any non-loopback
    // address so its existence is not advertised on the LAN.
    if (p == "admin.html" || p == "admin.js") && !addr.ip().is_loopback() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    match WebAssets::get(&p) {
        Some(content) => {
            let mime = mime_guess::from_path(&p)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .body(Body::from(content.data.into_owned()))
                .unwrap()
        }
        None => {
            // SPA fallback → index.html
            if let Some(content) = WebAssets::get("index.html") {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(Body::from(content.data.into_owned()))
                    .unwrap()
            } else {
                (StatusCode::NOT_FOUND, "not found").into_response()
            }
        }
    }
}


// ── User-confirmed self-update (Windows host only) ────────────────────
// The update endpoint is loopback-only: LAN chat participants must never
// be able to replace the host's executable. The helper downloads only the
// latest release from this repository and verifies SHA256SUMS.txt before
// replacing the running binary. The user must explicitly click "Update now".
async fn install_update(
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> axum::response::Response {
    if !addr.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({
            "error": "Updates can only be started from the host computer."
        }))).into_response();
    }
    // Require a same-origin request from the host's own browser. This stops
    // a remote LAN participant or an unrelated website from triggering a restart.
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).unwrap_or("");
    let trusted_origin = origin == "https://localhost"
        || origin.starts_with("https://localhost:")
        || origin == "https://127.0.0.1"
        || origin.starts_with("https://127.0.0.1:");
    if !trusted_origin {
        return (StatusCode::FORBIDDEN, Json(json!({
            "error": "Open LocalChat on the host computer to start an update."
        }))).into_response();
    }

    #[cfg(not(windows))]
    {
        return (StatusCode::NOT_IMPLEMENTED, Json(json!({
            "error": "The automatic updater currently supports Windows only."
        }))).into_response();
    }

    #[cfg(windows)]
    {
        use std::process::Command;

        let current_exe = match std::env::current_exe() {
            Ok(path) => path,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                "error": "Could not locate the running LocalChat executable."
            }))).into_response(),
        };
        let script_path = std::env::temp_dir().join(format!(
            "localchat-update-{}.ps1", std::process::id()
        ));
        let script = r##"param([string]$CurrentExe, [int]$ParentPid)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = 'mdimran-mrbd/LocalChat'
$releaseUri = "https://api.github.com/repos/$repo/releases/latest"
$headers = @{ 'User-Agent' = 'LocalChat-Updater'; 'Accept' = 'application/vnd.github+json' }
$tempExe = "$CurrentExe.update-$ParentPid"
$tempSum = "$CurrentExe.sha256-$ParentPid"
$backup = "$CurrentExe.previous"
$scriptFile = $MyInvocation.MyCommand.Path
$stoppedApp = $false
try {
  $release = Invoke-RestMethod -Uri $releaseUri -Headers $headers -TimeoutSec 30
  $exeAsset = $release.assets | Where-Object { $_.name -eq 'LocalChat.exe' } | Select-Object -First 1
  $sumAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
  if (-not $exeAsset -or -not $sumAsset) { throw 'The latest release is missing the executable or checksum manifest.' }
  Invoke-WebRequest -Uri $exeAsset.browser_download_url -OutFile $tempExe -Headers $headers -TimeoutSec 120
  Invoke-WebRequest -Uri $sumAsset.browser_download_url -OutFile $tempSum -Headers $headers -TimeoutSec 30
  $line = Get-Content -LiteralPath $tempSum | Where-Object { $_ -match '^\s*[A-Fa-f0-9]{64}\s+\*?LocalChat\.exe\s*$' } | Select-Object -First 1
  if (-not $line -or $line -notmatch '^\s*([A-Fa-f0-9]{64})\s+\*?LocalChat\.exe\s*$') { throw 'The release checksum manifest is invalid.' }
  $expected = $Matches[1].ToUpperInvariant()
  $actual = (Get-FileHash -LiteralPath $tempExe -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actual -ne $expected) { throw 'The downloaded executable failed SHA-256 verification.' }
  # Keep the current server running throughout download and verification.
  # Stop it only once the replacement is verified and ready to install.
  Stop-Process -Id $ParentPid -Force -ErrorAction SilentlyContinue
  $stoppedApp = $true
  $stopDeadline = (Get-Date).AddSeconds(15)
  while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $stopDeadline) { throw 'Could not stop LocalChat to finish the update.' }
    Start-Sleep -Milliseconds 400
  }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
  Move-Item -LiteralPath $CurrentExe -Destination $backup
  try {
    Move-Item -LiteralPath $tempExe -Destination $CurrentExe
    $started = Start-Process -FilePath $CurrentExe -PassThru
    Start-Sleep -Seconds 3
    $started.Refresh()
    if ($started.HasExited) { throw 'The updated executable exited immediately; restoring the previous build.' }
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  } catch {
    if (Test-Path -LiteralPath $CurrentExe) { Remove-Item -LiteralPath $CurrentExe -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $CurrentExe -Force }
    if (Test-Path -LiteralPath $CurrentExe) { Start-Process -FilePath $CurrentExe }
    throw
  }
} catch {
  # Keep a local diagnostic for the user; never install an unverified file.
  try { Set-Content -LiteralPath "$CurrentExe.update-error.txt" -Value $_.Exception.Message -Encoding UTF8 } catch {}
  if (Test-Path -LiteralPath $tempExe) { Remove-Item -LiteralPath $tempExe -Force -ErrorAction SilentlyContinue }
  # If installation had begun, restore service after the old process exits.
  # A download/checksum failure happens before shutdown, so leave the app running.
  if ($stoppedApp) {
    $stopDeadline = (Get-Date).AddSeconds(15)
    while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
      if ((Get-Date) -gt $stopDeadline) { break }
      Start-Sleep -Milliseconds 400
    }
    $parentStillRunning = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    $running = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($CurrentExe)) -ErrorAction SilentlyContinue
    if (-not $parentStillRunning -and -not $running -and (Test-Path -LiteralPath $CurrentExe)) {
      try { Start-Process -FilePath $CurrentExe } catch {}
    }
  }
} finally {
  if (Test-Path -LiteralPath $tempSum) { Remove-Item -LiteralPath $tempSum -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $scriptFile) { Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue }
}
"##;
        if let Err(_) = std::fs::write(&script_path, script) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                "error": "Could not prepare the updater helper."
            }))).into_response();
        }
        let spawn_result = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script_path)
            .arg(&current_exe)
            .arg(std::process::id().to_string())
            .spawn();
        match spawn_result {
            Ok(_) => {
                (StatusCode::OK, Json(json!({
                    "status": "starting",
                    "message": "The update will be downloaded and verified first. LocalChat will close only when the replacement is ready."
                }))).into_response()
            }
            Err(_) => {
                let _ = std::fs::remove_file(&script_path);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                    "error": "Could not start the Windows updater."
                }))).into_response()
            }
        }
    }
}


#[derive(Deserialize)]
struct RecoveryChallengeRequest {
    login: String,
}

#[derive(Deserialize)]
struct RecoveryResetRequest {
    login: String,
    #[serde(rename = "questionSlot")]
    question_slot: usize,
    answer: String,
    #[serde(rename = "newPassword")]
    new_password: String,
}

async fn recovery_challenge(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RecoveryChallengeRequest>,
) -> impl IntoResponse {
    let login = request.login.trim();
    if login.is_empty() || login.len() > 254 {
        return (StatusCode::OK, Json(json!({"ok": false, "message": "If the account has recovery configured, its questions will be available here."})));
    }
    let now = now_secs() as i64;
    match state.db.get_recovery_challenge(login).await.ok().flatten() {
        Some((_id, questions, _attempts, locked_until)) if locked_until > now => {
            (StatusCode::TOO_MANY_REQUESTS, Json(json!({"ok": false, "message": "Recovery is temporarily delayed. Please try again later."})))
        }
        Some((_id, questions, _, _)) => {
            (StatusCode::OK, Json(json!({"ok": true, "questions": questions})))
        }
        None => {
            (StatusCode::OK, Json(json!({"ok": false, "message": "If the account has recovery configured, its questions will be available here."})))
        }
    }
}

async fn recovery_reset(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RecoveryResetRequest>,
) -> impl IntoResponse {
    let login = request.login.trim();
    let generic = "Recovery could not be completed. Check your details or try again later.";
    if login.is_empty() || login.len() > 254 || request.answer.trim().is_empty()
        || request.answer.len() > 200 || !(4..=128).contains(&request.new_password.len())
        || request.question_slot > 2 {
        return (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "message": generic})));
    }
    let now = now_secs() as i64;
    let Some((user_id, _questions, _attempts, locked_until)) =
        state.db.get_recovery_challenge(login).await.ok().flatten()
    else {
        return (StatusCode::OK, Json(json!({"ok": false, "message": generic})));
    };
    if locked_until > now {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"ok": false, "message": "Too many attempts. Recovery is temporarily locked."})));
    }
    let hash = state.db.get_recovery_answer_hash(user_id.clone(), request.question_slot).await.ok().flatten();
    let answer = request.answer.trim().to_lowercase();
    if !hash.as_deref().map_or(false, |stored| crate::ws::verify_password(&answer, stored)) {
        let attempts = state.db.record_recovery_failure(user_id, now).await.unwrap_or(10);
        let message = if attempts >= 10 {
            "Too many failed attempts. Recovery is locked for 15 minutes."
        } else if attempts >= 5 {
            "Too many failed attempts. Wait at least 60 seconds before trying again."
        } else {
            generic
        };
        return (StatusCode::OK, Json(json!({"ok": false, "message": message})));
    }

    // Recovery answers authorize a credential reset. Keep the existing E2EE
    // backup and public-key identity untouched: a device that already holds
    // the established local key can re-wrap the backup after signing in with
    // the new password. A fresh device without that key may still need access
    // to the original device to recover old encrypted DMs.
    let Some(hash) = crate::ws::hash_password(&request.new_password) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"ok": false, "message": "Could not secure the new password."})));
    };
    if state.db.set_password_hash(user_id.clone(), &hash, false).await.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"ok": false, "message": "Could not save the new password."})));
    }
    let _ = state.db.clear_recovery_failures(user_id).await;
    (StatusCode::OK, Json(json!({"ok": true, "message": "Password reset. Your existing messages and encryption identity were preserved. On this device, sign in with the new password so LocalChat can refresh the encrypted key backup. A different device may still need the original device to access older encrypted DMs."})))
}
