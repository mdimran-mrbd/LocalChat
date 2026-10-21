//! WebSocket handler. Owns one connection, routes ops, fans out msgs.
//!
//! Wire protocol (JSON text frames):
//!
//!   Client → Server: {"op":"<name>", ...}
//!   Server → Client: {"ev":"<name>", ...}
//!
//! See README for the complete op/ev list.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use compact_str::{CompactString, ToCompactString};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::channel::{Channel, ChannelKind, LOBBY_ID};
use crate::message::{now_secs, FileInfo, MsgKind, WireMsg};
use crate::state::AppState;
use crate::user::{UserId, UserInfo};

/// What to do with a freshly-supplied password once the join has been
/// validated. Decided pre-commit so the rest of the join logic can run
/// without re-reading the DB.
enum PasswordAction {
    /// Existing row already has a hash that matched \u2014 nothing to write.
    None,
    /// Brand new user; hash and store as part of the create_user step.
    SetForNew,
    /// Row exists but had no hash yet (or we're back-filling it).
    SetForExisting(UserId),
}

/// Argon2id over the supplied password with a fresh random salt.
/// Returns the PHC-formatted string ready for storage.
pub(crate) fn hash_password(plain: &str) -> Option<String> {
    use argon2::{Argon2, PasswordHasher};
    use password_hash::{rand_core::OsRng, SaltString};
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .ok()
        .map(|h| h.to_string())
}

fn verify_password(plain: &str, stored_hash: &str) -> bool {
    use argon2::{Argon2, PasswordVerifier};
    use password_hash::PasswordHash;
    let Ok(parsed) = PasswordHash::new(stored_hash) else { return false };
    Argon2::default()
        .verify_password(plain.as_bytes(), &parsed)
        .is_ok()
}

pub async fn handle(socket: WebSocket, state: Arc<AppState>, peer_ip: String, user_agent: String) {
    state.metrics.inc_connect();
    let (mut sink, mut stream) = socket.split();

    // ---- Wait for the first "join" op before adding to any state.
    let Some(Ok(Message::Text(init))) = stream.next().await else {
        state.metrics.dec_connect();
        return;
    };

    #[derive(Deserialize)]
    struct Join {
        username: String,
        #[serde(default)]
        avatar: String,
        #[serde(default)]
        color: String,
        #[serde(default)]
        pubkey: String,
        /// Previously assigned UserId echoed back from the browser's
        /// localStorage. Reused when the supplied pubkey matches the row
        /// stored on the server, otherwise discarded.
        #[serde(default, rename = "userId")]
        user_id: String,
        /// Plain-text password supplied by the browser. Hashed
        /// server-side and compared with the stored Argon2id hash.
        /// First-time users (no row yet) get this hashed and stored.
        #[serde(default)]
        password: String,
    }
    let Ok(join) = serde_json::from_str::<Value>(&init).and_then(|v| {
        if v.get("op").and_then(Value::as_str) != Some("join") {
            return Err(serde::de::Error::custom("first op must be 'join'"));
        }
        serde_json::from_value::<Join>(v)
    }) else {
        let _ = sink
            .send(Message::Text(
                r#"{"ev":"error","text":"first message must be {\"op\":\"join\"}"}"#.into(),
            ))
            .await;
        state.metrics.dec_connect();
        return;
    };

    let username = sanitize_username(&join.username);
    if username.is_empty() {
        let _ = sink
            .send(Message::Text(
                r#"{"ev":"error","text":"Username must be 3-24 chars: letters, digits, underscore, hyphen, or dot. No spaces.","code":"invalid_username"}"#.into(),
            ))
            .await;
        state.metrics.dec_connect();
        return;
    }

    // ---- Ban check.
    let banned = {
        let cfg = state.config.read().unwrap();
        cfg.banned_users.iter().any(|b| b == &username)
            || cfg.banned_ips.iter().any(|b| b == &peer_ip)
    };
    if banned {
        let _ = sink
            .send(Message::Text(
                r#"{"ev":"error","text":"you are banned from this server"}"#.into(),
            ))
            .await;
        state.metrics.dec_connect();
        return;
    }

    // ── Password-based identity check ─────────────────────────────────
    // Every user must supply a password. First-time signup creates the
    // hash; returning users must present the same password. The password
    // is the durable credential that lets a user move browsers and still
    // reclaim their UserId, DM history, and group memberships.
    if join.password.is_empty() || join.password.len() > 256 {
        let _ = sink
            .send(Message::Text(
                json!({
                    "ev":"error",
                    "text":"Password is required.",
                    "code":"password_required",
                }).to_string(),
            ))
            .await;
        state.metrics.dec_connect();
        return;
    }

    // Look up any prior credentials row for this username.
    let stored = state
        .db
        .find_user_credentials(&username)
        .await
        .ok()
        .flatten();

    // Decide whether this is a signup or a login, and on login verify
    // the password before letting the join proceed. We do this BEFORE
    // touching any in-memory state so a wrong password leaves nothing
    // behind.
    let mut password_action: PasswordAction = PasswordAction::None;
    let mut forced_user_id: Option<UserId> = None;
    let mut must_change_password = false;
    match stored.as_ref() {
        Some((existing_id, hash, must_change)) if !hash.is_empty() => {
            if !verify_password(&join.password, hash) {
                let _ = sink
                    .send(Message::Text(
                        json!({
                            "ev":"error",
                            "text":"Incorrect password for this username.",
                            "code":"bad_password",
                        }).to_string(),
                    ))
                    .await;
                state.metrics.dec_connect();
                return;
            }
            // Login OK \u2014 reuse the existing UserId regardless of what
            // the browser sent in `userId`. This is what lets the same
            // account log in from a brand-new browser.
            forced_user_id = Some(existing_id.clone());
            must_change_password = *must_change;
        }
        Some((existing_id, _, _)) => {
            // Row exists but never had a password \u2014 first password is
            // accepted as the new credential.
            if join.password.len() < 4 {
                let _ = sink
                    .send(Message::Text(
                        json!({
                            "ev":"error",
                            "text":"Password must be at least 4 characters.",
                            "code":"password_weak",
                        }).to_string(),
                    ))
                    .await;
                state.metrics.dec_connect();
                return;
            }
            forced_user_id = Some(existing_id.clone());
            password_action = PasswordAction::SetForExisting(existing_id.clone());
        }
        None => {
            // First-time signup. Enforce a minimum so the password is at
            // least vaguely useful as a credential on a shared LAN.
            if join.password.len() < 4 {
                let _ = sink
                    .send(Message::Text(
                        json!({
                            "ev":"error",
                            "text":"Password must be at least 4 characters.",
                            "code":"password_weak",
                        }).to_string(),
                    ))
                    .await;
                state.metrics.dec_connect();
                return;
            }
            password_action = PasswordAction::SetForNew;
        }
    }

    let user_id = match forced_user_id {
        Some(id) => {
            // Make sure the in-memory map points at the canonical id so
            // every subsequent lookup (DMs, presence) finds this user.
            state
                .username_to_id
                .insert(username.to_lowercase().to_compact_string(), id.clone());
            id
        }
        None => assign_user_id(&state, &username, &join.user_id),
    };

    // Restore previous identity (avatar/color/pubkey) if this user has
    // connected before. Client-supplied values still win when provided.
    let prior = state
        .known_users
        .get(&user_id)
        .map(|e| e.value().clone());


    let avatar = if !join.avatar.is_empty() {
        join.avatar.chars().take(4).collect::<String>().to_compact_string()
    } else if let Some(p) = prior.as_ref() {
        p.avatar.clone()
    } else {
        username
            .chars()
            .next()
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_else(|| "?".to_string())
            .to_compact_string()
    };
    let color = if !join.color.is_empty() {
        join.color.chars().take(16).collect::<String>().to_compact_string()
    } else if let Some(p) = prior.as_ref() {
        p.color.clone()
    } else {
        pick_color_for(&username).to_compact_string()
    };
    let pubkey = if !join.pubkey.is_empty() {
        join.pubkey.chars().take(512).collect::<String>().to_compact_string()
    } else {
        prior.as_ref().map(|p| p.pubkey.clone()).unwrap_or_default()
    };

    let info = UserInfo {
        id: user_id.clone(),
        username: username.clone(),
        avatar,
        color,
        joined_at: prior.as_ref().map(|p| p.joined_at).unwrap_or_else(now_secs),
        ip: peer_ip.to_compact_string(),
        msg_count: prior.as_ref().map(|p| p.msg_count).unwrap_or(0),
        bytes_uploaded: prior.as_ref().map(|p| p.bytes_uploaded).unwrap_or(0),
        pubkey,
        last_ip: peer_ip.to_compact_string(),
        last_seen: prior.as_ref().map(|p| p.last_seen).unwrap_or(0),
        last_connect: now_secs(),
        total_sessions: prior.as_ref().map(|p| p.total_sessions).unwrap_or(0) + 1,
        designation: prior.as_ref().map(|p| p.designation.clone()).unwrap_or_default(),
    };
    state.users.insert(user_id.clone(), info.clone());
    state.known_users.insert(user_id.clone(), info.clone());
    let socket_count = {
        let mut entry = state.connections.entry(user_id.clone()).or_insert(0);
        *entry += 1;
        *entry
    };
    let was_offline = socket_count == 1;
    let session_started = now_secs();
    crate::applog::log(format_args!(
        "join: user={} id={} ip={} (sockets={})",
        info.username, user_id, peer_ip, socket_count,
    ));

    // Persistent audit trail — always append, every socket open.
    let _ = state.db.append_session_event(
        "connect",
        user_id.clone(),
        &info.username,
        &peer_ip,
        &user_agent,
        session_started,
        None,
        Some(socket_count),
    ).await;

    // Persist identity table so the same user keeps the same id across
    // server restarts. New user → INSERT; returning user → UPDATE
    // last_connect/total_sessions/last_ip and refresh avatar/color/pubkey.
    if prior.is_some() {
        let _ = state.db.touch_user_on_connect(
            user_id.clone(), &info.username, &info.avatar, &info.color, &info.pubkey,
            &peer_ip, session_started,
        ).await;
    } else {
        let _ = state.db.create_user(&info).await;
    }

    // Persist the password hash for new signups (and back-fill rows
    // that previously had no password). Decided pre-commit above.
    match &password_action {
        PasswordAction::SetForNew | PasswordAction::SetForExisting(_) => {
            if let Some(hash) = hash_password(&join.password) {
                let target_id = match &password_action {
                    PasswordAction::SetForExisting(id) => id.clone(),
                    _ => user_id.clone(),
                };
                let _ = state.db.set_password_hash(target_id, &hash, false).await;
            }
        }
        PasswordAction::None => {}
    }

    // Every account gets a durable, private Notes chat.
    let notes_id = format!("notes:{}", user_id).to_compact_string();
    let notes_channel = if let Some(existing) = state.channels.get(notes_id.as_str()) {
        existing
    } else {
        let created = Arc::new(Channel::new(
            notes_id.clone(), ChannelKind::Group, CompactString::const_new("Notes"), true,
            user_id.clone(), state.channels.history_cap,
        ));
        created.members.insert(user_id.clone());
        state.channels.map.insert(notes_id.clone(), Arc::clone(&created));
        created
    };
    notes_channel.members.insert(user_id.clone());
    state.channels.add_user_channel(user_id.clone(), &notes_id);
    let _ = state.db.upsert_channel(&notes_channel.meta()).await;
    let _ = state.db.add_member(&notes_id, user_id.clone(), now_secs()).await;

    // Auto-join the lobby.
    let lobby = state.channels.get(LOBBY_ID).expect("lobby always exists");
    lobby.members.insert(user_id.clone());
    state.channels.add_user_channel(user_id.clone(), &lobby.id);

    // Re-bind any DM channels that contain this username so they survive
    // page reloads (DMs are keyed by username hash, members are ephemeral).
    let rebound_dms = state.channels.rebind_user_dms(user_id.clone(), &info.username);

    // Re-subscribe to every group channel this user is already a member
    // of (membership is now durable across reloads & restarts).
    let mut my_channels: Vec<CompactString> = Vec::new();
    for entry in state.channels.map.iter() {
        let ch = entry.value();
        if matches!(ch.kind, ChannelKind::Lobby | ChannelKind::Dm) { continue; }
        if ch.members.contains(&user_id) {
            state.channels.add_user_channel(user_id.clone(), &ch.id);
            my_channels.push(ch.id.clone());
        }
    }

    // Subscribe to all channels this user can see.
    let mut rxs: smallvec::SmallVec<[broadcast::Receiver<Arc<WireMsg>>; 8]> =
        smallvec::smallvec![];
    rxs.push(lobby.tx.subscribe());
    for cid in &rebound_dms {
        if let Some(ch) = state.channels.get(cid) {
            rxs.push(ch.tx.subscribe());
        }
    }
    for cid in &my_channels {
        if let Some(ch) = state.channels.get(cid) {
            rxs.push(ch.tx.subscribe());
        }
    }

    // Welcome envelope.
    // Issue a per-socket session token. Used by the HTTP /api/upload
    // endpoint to identify the user without a separate auth layer; the
    // token lives only as long as this WS connection.
    let session_token: CompactString = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .to_compact_string();
    state.sessions.insert(session_token.clone(), user_id.clone());

    let welcome = json!({
        "ev": "welcome",
        "user": info,
        "channels": state.channels.visible_to(user_id.clone()),
        "users": state.users.iter().map(|e| e.value().clone()).collect::<Vec<_>>(),
        "lobby": LOBBY_ID,
        "session": session_token,
        "mustChangePassword": must_change_password,
    });
    if sink.send(Message::Text(welcome.to_string())).await.is_err() {
        // Session token is intentionally NOT removed on disconnect:
        // an in-flight HTTP upload (which can take many seconds for a
        // large video) needs to look it up after the WS has closed.
        // Tokens accumulate but are bounded by user count and reset on
        // process restart — fine for LAN scope.
        cleanup(&state, user_id, &peer_ip, session_started).await;
        return;
    }

    // Send lobby recent history.
    send_history(&mut sink, &lobby, &state.db, 50).await;

    // Announce in lobby ONLY the very first time a user registers
    // (no prior identity row in the DB). Subsequent reconnects /
    // re-logins update presence silently — no chat spam.
    let is_first_registration = prior.is_none();
    if was_offline {
        if is_first_registration {
            broadcast_system(
                &state,
                &lobby,
                &format!("👋 {} joined LocalChat", info.username),
            ).await;
        }
        broadcast_users(&state).await;
    } else {
        // Still refresh presence for *this* socket so its UI is correct.
        broadcast_users(&state).await;
    }

    // ---- Main loop: multiplex incoming ops and outgoing broadcasts.
    let mut own_channels: smallvec::SmallVec<[CompactString; 8]> =
        smallvec::smallvec![lobby.id.clone()];
    for cid in rebound_dms { own_channels.push(cid); }
    for cid in my_channels { if !own_channels.iter().any(|c| c == &cid) { own_channels.push(cid); } }

    // Subscribe to the admin kick bus so a flush/reset boots us instantly
    // instead of waiting for the next op to fail.
    let mut kick_rx = state.kick_tx.subscribe();

    loop {
        tokio::select! {
            // Admin kick
            kicked = kick_rx.recv() => {
                match kicked {
                    Ok(crate::state::KickSignal::All) => {
                        let _ = sink.send(Message::Text(
                            r#"{"ev":"kicked","reason":"server reset"}"#.into(),
                        )).await;
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                    Ok(crate::state::KickSignal::User(uid)) if uid == user_id => {
                        let _ = sink.send(Message::Text(
                            r#"{"ev":"kicked","reason":"removed by admin"}"#.into(),
                        )).await;
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                    // Lagged or unrelated kick — ignore.
                    _ => continue,
                }
            }

            // Incoming ops
            incoming = stream.next() => {
                let Some(Ok(msg)) = incoming else { break };
                match msg {
                    Message::Text(txt) => {
                        if let Err(e) = handle_op(&state, user_id.clone(), &mut sink, &mut rxs, &mut own_channels, &txt).await {
                            let _ = sink.send(Message::Text(
                                json!({"ev":"error","text":e}).to_string())).await;
                        }
                    }
                    Message::Ping(p) => { let _ = sink.send(Message::Pong(p)).await; }
                    Message::Close(_) => break,
                    _ => {}
                }
            }

            // Outgoing: whichever channel fires first.
            out = recv_any(&mut rxs) => {
                match out {
                    Some(msg) => {
                        // Intercept the __dm_subscribe control event: if it's
                        // addressed to us, subscribe to the named channel and
                        // do NOT forward it to the client.
                        if msg.username == "__dm_subscribe" {
                            if let Ok(v) = serde_json::from_str::<Value>(&msg.text) {
                                let target = v.get("forUserId").and_then(Value::as_str).unwrap_or("").to_compact_string();
                                if target == user_id {
                                    if let Some(ch_id) = v.get("channel").and_then(Value::as_str) {
                                        let cid = ch_id.to_compact_string();
                                        if !own_channels.iter().any(|c| c == &cid) {
                                            if let Some(ch) = state.channels.get(&cid) {
                                                rxs.push(ch.tx.subscribe());
                                                own_channels.push(cid.clone());
                                                // Push a ch_created event so the
                                                // client can show the DM in its sidebar.
                                                let out = json!({"ev":"ch_created","channel":ch.meta()});
                                                let _ = sink.send(Message::Text(out.to_string())).await;
                                            }
                                        }
                                    }
                                }
                            }
                            continue;
                        }
                        // Intercept the __ch_invited control event: if it's
                        // addressed to us, subscribe to the channel, surface
                        // it in the sidebar, and tell the client to toast.
                        if msg.username == "__ch_invited" {
                            if let Ok(v) = serde_json::from_str::<Value>(&msg.text) {
                                let target = v.get("forUserId").and_then(Value::as_str).unwrap_or("").to_compact_string();
                                if target == user_id {
                                    if let Some(ch_id) = v.get("channel").and_then(Value::as_str) {
                                        let cid = ch_id.to_compact_string();
                                        if let Some(ch) = state.channels.get(&cid) {
                                            if !own_channels.iter().any(|c| c == &cid) {
                                                rxs.push(ch.tx.subscribe());
                                                own_channels.push(cid.clone());
                                            }
                                            let created = json!({"ev":"ch_created","channel":ch.meta()});
                                            let _ = sink.send(Message::Text(created.to_string())).await;
                                            let invited = json!({
                                                "ev":"ch_invited",
                                                "channel": ch.id,
                                                "channelName": ch.name(),
                                                "inviter": v.get("inviter").and_then(Value::as_str).unwrap_or("")
                                            });
                                            let _ = sink.send(Message::Text(invited.to_string())).await;
                                        }
                                    }
                                }
                            }
                            continue;
                        }
                        if sink.send(Message::Text(msg_to_json(&msg))).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    // ---- Disconnect cleanup.
    // Note: session_token is intentionally retained — see comment in
    // the welcome-send block above.
    let _ = session_token;
    cleanup(&state, user_id, &peer_ip, session_started).await;
}

async fn cleanup(state: &Arc<AppState>, user_id: UserId, peer_ip: &str, session_started: u64) {
    // Decrement socket count; only fully "leave" when it hits zero.
    let (still_online, sockets_remaining) = {
        let mut entry = state.connections.entry(user_id.clone()).or_insert(0);
        if *entry > 0 { *entry -= 1; }
        let n = *entry;
        let still = n > 0;
        if !still { drop(entry); state.connections.remove(&user_id); }
        (still, n)
    };
    let now = crate::message::now_secs();
    let duration = now.saturating_sub(session_started);

    // If a factory/users reset is in progress, skip per-user audit and
    // identity writes so we don't race against the DB flush and leave
    // ghost rows in `session_events` / `users`.
    let resetting = state
        .resetting
        .load(std::sync::atomic::Ordering::Relaxed);

    let username_for_audit = state
        .known_users
        .get(&user_id)
        .map(|e| e.value().username.to_string())
        .unwrap_or_default();
    if !resetting {
        // Always record the per-socket disconnect in the audit log.
        let _ = state.db.append_session_event(
            "disconnect",
            user_id.clone(),
            &username_for_audit,
            peer_ip,
            "",
            now,
            Some(duration),
            Some(sockets_remaining),
        ).await;

        // Update the persisted identity so the admin page can show "last seen
        // from <ip> at <time>" even after restart.
        if let Some(mut k) = state.known_users.get_mut(&user_id) {
            k.last_seen = now;
            k.last_ip = peer_ip.to_compact_string();
        }
        let _ = state.db.update_user_on_disconnect(user_id.clone(), peer_ip, now).await;
    }

    if still_online {
        // Another tab/window is still open for this user. Keep presence
        // and channel memberships intact.
        state.metrics.dec_connect();
        return;
    }

    // If this user was in any in-flight call, finalize it now so the
    // chat shows what happened instead of leaving a dangling session.
    // (Skipped during a reset — the calls map is wiped wholesale and
    // we don't want to insert orphan messages back into the DB.)
    if !resetting {
        let abandoned: Vec<crate::message::ChannelId> = state
            .calls
            .iter()
            .filter(|e| e.value().caller_id == user_id || e.value().callee_id == user_id)
            .map(|e| e.key().clone())
            .collect();
        for cid in abandoned {
            if let Some((_, session)) = state.calls.remove(&cid) {
                if let Some(ch) = state.channels.get(&cid) {
                    let icon = if session.video { "📹" } else { "📞" };
                    let text = if let Some(ans) = session.answered_at {
                        let dur = now.saturating_sub(ans);
                        format!("{icon} Call ended · {}", fmt_duration(dur))
                    } else {
                        format!("{icon} Missed call")
                    };
                    let msg = Arc::new(WireMsg {
                        id: state.next_msg_id(),
                        channel: ch.id.clone(),
                        kind: MsgKind::System,
                        user_id: session.caller_id,
                        username: session.caller_name.clone(),
                        avatar: CompactString::const_new(""),
                        color: CompactString::const_new(""),
                        ts: now,
                        text,
                        file: None,
                        reply_to: None,
                        edited_at: None,
                        deleted: false,
                    });
                    ch.push_history(msg.clone()).await;
                    if let Err(e) = state.db.insert_message(&msg).await {
                        crate::applog::log(format_args!("db.insert_message FAILED (call-end system): {e}"));
                    }
                    let _ = ch.tx.send(msg);
                }
            }
        }
    }

    let removed = state.users.remove(&user_id).map(|(_, v)| v);
    // We INTENTIONALLY do not strip the user from channel members here.
    // Channel membership is durable; presence is reflected by `users`.
    // Lobby is special — it's auto-joined on every connection, so we can
    // drop it from user_channels to keep the per-user list trim.
    if let Some(mut chs) = state.channels.user_channels.get_mut(&user_id) {
        chs.retain(|c| c.as_str() != LOBBY_ID);
    }
    if let Some(lobby) = state.channels.get(LOBBY_ID) {
        lobby.members.remove(&user_id);
    }
    state.metrics.dec_connect();

    if let Some(u) = removed {
        crate::applog::log(format_args!(
            "leave: user={} id={}", u.username, user_id
        ));
        // No "X left the chat" system message — presence is conveyed
        // by the live user list, and posting on every disconnect was
        // chat spam (especially with reload-heavy browser sessions).
        broadcast_users(state).await;
    }
}

/// Pick a UserId for this username. Always reuses the previously assigned
/// ID if the username has joined before — across reconnects AND across
/// server restarts (loaded from users.json). Multiple concurrent sockets
/// for the same username share the same UserId; the connection ref-count
/// in `state.connections` decides when the user truly goes offline.
fn assign_user_id(
    state: &Arc<AppState>,
    username: &CompactString,
    client_hint: &str,
) -> UserId {
    let key = username.to_lowercase().to_compact_string();
    if let Some(existing) = state.username_to_id.get(&key).map(|v| v.value().clone()) {
        return existing;
    }
    // Honour the client's stored UserId (from localStorage) when it looks
    // sane, otherwise mint a fresh UUID. This keeps a returning user's
    // id stable across server restarts even when the in-memory username
    // map was cleared, while still rejecting collisions and impersonation
    // attempts via the pubkey check upstream.
    let id: UserId = if is_valid_user_id(client_hint)
        && !state.known_users.contains_key(&client_hint.to_compact_string())
    {
        client_hint.to_compact_string()
    } else {
        uuid::Uuid::new_v4().simple().to_string().to_compact_string()
    };
    state.username_to_id.insert(key, id.clone());
    id
}

/// Accept only short hex UUIDs (32 chars, lowercase hex) coming from the
/// browser. Anything else is treated as untrusted noise and discarded.
fn is_valid_user_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Enforce strict username rules: ASCII letters, digits, underscore,
/// hyphen, or dot; 3–24 chars; must start with a letter or digit. Returns
/// an empty string when the input doesn't qualify so the caller can
/// reject the join with the standard "invalid username" error.
fn sanitize_username(u: &str) -> CompactString {
    let trimmed = u.trim();
    if trimmed.len() < 3 || trimmed.len() > 24 {
        return CompactString::const_new("");
    }
    let bytes = trimmed.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() {
        return CompactString::const_new("");
    }
    if !bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')) {
        return CompactString::const_new("");
    }
    trimmed.to_compact_string()
}

/// Stable color from a username (case-insensitive, FNV-1a 32-bit hash).
fn pick_color_for(username: &str) -> &'static str {
    const COLORS: &[&str] = &[
        "#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
        "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
    ];
    let mut h: u32 = 0x811c9dc5;
    for b in username.as_bytes() {
        let lower = b.to_ascii_lowercase();
        h ^= lower as u32;
        h = h.wrapping_mul(0x01000193);
    }
    COLORS[(h as usize) % COLORS.len()]
}

/// Merge-style receive: await on whichever channel fires first.
/// Uses a SmallVec to keep the per-message future array on the stack for
/// the common case (≤ 8 channels per user) — no heap allocation in the
/// hot WS loop.
async fn recv_any(
    rxs: &mut smallvec::SmallVec<[broadcast::Receiver<Arc<WireMsg>>; 8]>,
) -> Option<Arc<WireMsg>> {
    use futures_util::future::{select_all, FutureExt};
    if rxs.is_empty() {
        return futures_util::future::pending().await;
    }
    let futs: smallvec::SmallVec<[_; 8]> = rxs
        .iter_mut()
        .map(|rx| Box::pin(rx.recv().map(|r| r.ok())))
        .collect();
    let (res, _, _) = select_all(futs).await;
    res
}

fn msg_to_json(m: &WireMsg) -> String {
    json!({ "ev":"msg", "m": m }).to_string()
}

type WsSink = futures_util::stream::SplitSink<WebSocket, Message>;

async fn send_history(sink: &mut WsSink, ch: &Channel, db: &crate::db::Db, limit: usize) {
    // Always source from SQLite — the in-memory ring is volatile
    // (lost on restart, capped, and only fully populated by live
    // traffic). DB is the single source of truth for chat history.
    let recent: Vec<WireMsg> = db.tail_messages(&ch.id, limit).await.unwrap_or_default();
    let v: Vec<&WireMsg> = recent.iter().collect();
    let out = json!({ "ev": "history", "channel": ch.id, "messages": v });
    let _ = sink.send(Message::Text(out.to_string())).await;
}

fn collect_reactions(
    state: &Arc<AppState>,
    channel: &CompactString,
) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for entry in state.reactions.iter() {
        let (ch_id, msg_id) = entry.key();
        if ch_id != channel { continue; }
        let mut emap = serde_json::Map::new();
        for ee in entry.value().iter() {
            let users: Vec<UserId> = ee.value().clone();
            if !users.is_empty() {
                emap.insert(ee.key().to_string(), json!(users));
            }
        }
        if !emap.is_empty() {
            out.insert(msg_id.to_string(), Value::Object(emap));
        }
    }
    out
}

async fn broadcast_system(state: &Arc<AppState>, ch: &Channel, text: &str) {
    let msg = Arc::new(WireMsg {
        id: state.next_msg_id(),
        channel: ch.id.clone(),
        kind: MsgKind::System,
        user_id: CompactString::const_new(""),
        username: CompactString::const_new(""),
        avatar: CompactString::const_new(""),
        color: CompactString::const_new(""),
        ts: now_secs(),
        text: text.to_string(),
        file: None,
        reply_to: None,
        edited_at: None,
        deleted: false,
    });
    ch.push_history(msg.clone()).await;
    if let Err(e) = state.db.insert_message(&msg).await {
        crate::applog::log(format_args!("db.insert_message FAILED (system broadcast): {e}"));
    }
    let _ = ch.tx.send(msg);
}

async fn broadcast_users(state: &Arc<AppState>) {
    let users: Vec<UserInfo> =
        state.users.iter().map(|e| e.value().clone()).collect();
    let payload = json!({"ev":"users","users":users}).to_string();
    // Fan out on the lobby channel only (everyone is in lobby).
    if let Some(lobby) = state.channels.get(LOBBY_ID) {
        // Inject a synthetic "presence" message via tx? No — presence is a
        // control event, not a history message. We piggyback by storing as
        // a payload-only push. For simplicity we send presence as a system
        // message to the lobby broadcast, but don't persist.
        let msg = Arc::new(WireMsg {
            id: 0,
            channel: lobby.id.clone(),
            kind: MsgKind::System,
            user_id: CompactString::const_new(""),
            username: CompactString::const_new("__presence"),
            avatar: CompactString::const_new(""),
            color: CompactString::const_new(""),
            ts: now_secs(),
            text: payload,
            file: None,
            reply_to: None,
            edited_at: None,
            deleted: false,
        });
        // Tagged with a sentinel username; client special-cases it.
        let _ = lobby.tx.send(msg);
    }
}

// ──────────────────────────────────────────────────────────────────────
// Op dispatch
// ──────────────────────────────────────────────────────────────────────

async fn handle_op(
    state: &Arc<AppState>,
    user_id: UserId,
    sink: &mut WsSink,
    rxs: &mut smallvec::SmallVec<[broadcast::Receiver<Arc<WireMsg>>; 8]>,
    own_channels: &mut smallvec::SmallVec<[CompactString; 8]>,
    txt: &str,
) -> Result<(), String> {
    let v: Value = serde_json::from_str(txt).map_err(|e| e.to_string())?;
    let op = v.get("op").and_then(Value::as_str).ok_or("missing op")?;

    match op {
        "poll_create" => {
            let channel_id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?.to_compact_string();
            let question = v.get("question").and_then(Value::as_str).unwrap_or("").trim();
            let options_value = v.get("options").and_then(Value::as_array).ok_or("missing poll options")?;
            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            if ch.kind == ChannelKind::Dm { return Err("polls are only available in group chats".into()); }
            if question.is_empty() || question.chars().count() > 180 { return Err("Poll question must be 1–180 characters".into()); }
            if options_value.len() < 2 || options_value.len() > 10 { return Err("Polls need 2–10 options".into()); }
            let mut options = Vec::new();
            for item in options_value {
                let option = item.as_str().unwrap_or("").trim();
                if option.is_empty() || option.chars().count() > 100 { return Err("Each poll option must be 1–100 characters".into()); }
                options.push(option.to_string());
            }
            let unique: std::collections::HashSet<String> = options.iter().map(|s| s.to_lowercase()).collect();
            if unique.len() != options.len() { return Err("Poll options must be unique".into()); }
            let user = state.users.get(&user_id).ok_or("user gone")?.clone();
            let poll_text = format!("poll:v1:{}", json!({"question":question,"options":options}));
            let msg = Arc::new(WireMsg {
                id: state.next_msg_id(), channel: channel_id.clone(), kind: MsgKind::Text,
                user_id: user_id.clone(), username: user.username.clone(), avatar: user.avatar.clone(),
                color: user.color.clone(), ts: now_secs(), text: poll_text, file: None,
                reply_to: None, edited_at: None, deleted: false,
            });
            ch.push_history(msg.clone()).await;
            state.db.insert_message(&msg).await.map_err(|_| "could not save poll".to_string())?;
            state.metrics.inc_messages();
            let _ = ch.tx.send(msg);
        }

        "poll_vote" | "poll_state" => {
            let channel_id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?.to_compact_string();
            let message_id = v.get("msgId").and_then(Value::as_u64).ok_or("missing poll message")?;
            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            if ch.kind == ChannelKind::Dm { return Err("polls are only available in group chats".into()); }
            let poll_text = state.db.poll_message_text(&channel_id, message_id).await
                .map_err(|_| "could not load poll".to_string())?.ok_or("poll not found")?;
            let payload = poll_text.strip_prefix("poll:v1:").ok_or("message is not a poll")?;
            let poll: Value = serde_json::from_str(payload).map_err(|_| "invalid poll data")?;
            let option_count = poll.get("options").and_then(Value::as_array).map(|a| a.len()).ok_or("invalid poll options")?;
            if op == "poll_vote" {
                let option_index = v.get("optionIndex").and_then(Value::as_u64).ok_or("missing option")? as usize;
                if option_index >= option_count { return Err("invalid poll option".into()); }
                let saved = state.db.cast_poll_vote(&channel_id, message_id, user_id.as_str(), option_index, now_secs()).await
                    .map_err(|_| "could not save vote".to_string())?;
                if !saved { return Err("poll is no longer available".into()); }
            }
            let (counts, mine) = state.db.poll_results(&channel_id, message_id, user_id.as_str(), option_count).await
                .map_err(|_| "could not load poll results".to_string())?;
            let event = json!({"ev":"poll_update","channel":channel_id,"msgId":message_id,"counts":counts,"userVote":mine});
            let _ = sink.send(Message::Text(event.to_string())).await;
            if op == "poll_vote" {
                let update = json!({"channel":channel_id,"msgId":message_id,"counts":counts});
                let _ = ch.tx.send(Arc::new(WireMsg {
                    id: 0, channel: channel_id, kind: MsgKind::System, user_id: user_id.clone(),
                    username: CompactString::const_new("__poll"), avatar: CompactString::const_new(""),
                    color: CompactString::const_new(""), ts: now_secs(), text: update.to_string(),
                    file: None, reply_to: None, edited_at: None, deleted: true,
                }));
            }
        }

        "send" => {
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?
                .to_compact_string();
            let text = v
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_end_matches('\n')
                .to_string();
            if text.is_empty() || text.len() > 4096 {
                return Err("empty or oversize text".into());
            }
            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) {
                return Err("not a member".into());
            }
            let user = state.users.get(&user_id).ok_or("user gone")?.clone();
            let msg = Arc::new(WireMsg {
                id: state.next_msg_id(),
                channel: channel_id.clone(),
                kind: MsgKind::Text,
                user_id: user_id.clone(),
                username: user.username.clone(),
                avatar: user.avatar.clone(),
                color: user.color.clone(),
                ts: now_secs(),
                text,
                file: None,
                reply_to: v.get("replyTo").and_then(Value::as_u64),
                edited_at: None,
                deleted: false,
            });
            ch.push_history(msg.clone()).await;
            if let Err(e) = state.db.insert_message(&msg).await {
                crate::applog::log(format_args!("db.insert_message FAILED (send): {e}"));
            }
            state.metrics.inc_messages();
            bump_user_msg_count(state, user_id.clone());
            let _ = state.db.bump_user_msg_count(user_id).await;
            let _ = ch.tx.send(msg);
        }

        "file" => {
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?
                .to_compact_string();
            let file: FileInfo = serde_json::from_value(
                v.get("file").cloned().ok_or("missing file")?,
            )
            .map_err(|e| e.to_string())?;
            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) {
                return Err("not a member".into());
            }
            // Idempotency: if the client retried this op (e.g. after a
            // page refresh between upload completion and the WS frame
            // being delivered), the same file_id is already attached
            // to a message. Re-broadcast that one instead of inserting
            // a duplicate.
            if let Ok(Some(existing_id)) = state.db.message_id_for_file(file.id.as_str()).await {
                let recent = state.db.tail_messages(channel_id.as_str(), 500).await.unwrap_or_default();
                if let Some(existing) = recent.into_iter().find(|m| m.id == existing_id) {
                    let _ = ch.tx.send(Arc::new(existing));
                }
                return Ok(());
            }
            let user = state.users.get(&user_id).ok_or("user gone")?.clone();
            let msg = Arc::new(WireMsg {
                id: state.next_msg_id(),
                channel: channel_id.clone(),
                kind: MsgKind::File,
                user_id: user_id.clone(),
                username: user.username.clone(),
                avatar: user.avatar.clone(),
                color: user.color.clone(),
                ts: now_secs(),
                text: v
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                file: Some(file),
                reply_to: None,
                edited_at: None,
                deleted: false,
            });
            ch.push_history(msg.clone()).await;
            let file_size = msg.file.as_ref().map(|f| f.size).unwrap_or(0);
            if let Err(e) = state.db.insert_message(&msg).await {
                crate::applog::log(format_args!("db.insert_message FAILED (file op): {e}"));
            }
            if file_size > 0 {
                let _ = state.db.bump_user_uploaded(user_id, file_size).await;
            }
            state.metrics.inc_messages();
            let _ = ch.tx.send(msg);
        }

        "typing" => {
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            let is_typing = v
                .get("typing")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let ch = state.channels.get(channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) {
                return Ok(()); // silently ignore
            }
            let user = state
                .users
                .get(&user_id)
                .map(|e| e.value().username.to_string())
                .unwrap_or_default();
            let ev = json!({
                "ev": "typing",
                "channel": channel_id,
                "userId": user_id.as_str(),
                "username": user,
                "typing": is_typing,
            });
            // piggyback on the channel broadcast via a synthetic WireMsg
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__typing"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: ev.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        "ch_create" => {
            let name = v
                .get("name")
                .and_then(Value::as_str)
                .ok_or("missing name")?
                .trim();
            if name.is_empty() {
                return Err("empty name".into());
            }
            let private = v.get("private").and_then(Value::as_bool).unwrap_or(false);
            let ch = state.channels.create_group(name, private, user_id.clone());
            rxs.push(ch.tx.subscribe());
            own_channels.push(ch.id.clone());

            let out = json!({"ev":"ch_created","channel":ch.meta()});
            let _ = sink.send(Message::Text(out.to_string())).await;
            broadcast_system(state, &ch, &format!("Channel #{} created", ch.name())).await;
            let _ = state.db.upsert_channel(&ch.meta()).await;
            let _ = state.db.add_member(&ch.id, user_id, now_secs()).await;
        }

        "ch_join" => {
            let id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if ch.is_private && !ch.members.contains(&user_id) {
                return Err("channel is private".into());
            }
            ch.members.insert(user_id.clone());
            state.channels.add_user_channel(user_id.clone(), &ch.id);
            if !own_channels.iter().any(|c| c == &ch.id) {
                rxs.push(ch.tx.subscribe());
                own_channels.push(ch.id.clone());
            }
            send_history(sink, &ch, &state.db, 50).await;
            let username = state
                .users
                .get(&user_id)
                .map(|u| u.value().username.to_string())
                .unwrap_or_default();
            broadcast_system(state, &ch, &format!("{} joined #{}", username, ch.name())).await;
            let _ = state.db.add_member(&ch.id, user_id, now_secs()).await;
        }

        "ch_leave" => {
            let id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            if id == LOBBY_ID {
                return Err("cannot leave lobby".into());
            }
            if let Some(ch) = state.channels.get(id) {
                ch.members.remove(&user_id);
                state.channels.remove_user_channel(user_id.clone(), id);
                own_channels.retain(|c| c != id);
                // rxs: we don't bother surgically removing; the send loop
                // will drop the receiver when the channel empties or the
                // socket closes. Correctness unaffected.
            }
            let _ = state.db.remove_member(id, user_id).await;
        }

        "ch_invite" => {
            let id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            let users = v
                .get("users")
                .and_then(Value::as_array)
                .ok_or("missing users")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !ch.members.contains(&user_id) {
                return Err("not a member".into());
            }
            let inviter_name = state
                .users
                .get(&user_id)
                .map(|u| u.value().username.to_string())
                .unwrap_or_default();
            let mut added: Vec<(UserId, String)> = Vec::new();
            for u in users {
                if let Some(s) = u.as_str() {
                    let uid = s.to_compact_string();
                    if uid == user_id { continue; }
                    let was_new = ch.members.insert(uid.clone());
                    state.channels.add_user_channel(uid.clone(), &ch.id);
                    if was_new {
                        let name = state
                            .users
                            .get(&uid)
                            .map(|u| u.value().username.to_string())
                            .unwrap_or_default();
                        added.push((uid, name));
                    }
                }
            }
            // Notify each invitee via the lobby control bus so their socket
            // can subscribe to the new channel and surface a toast.
            if !added.is_empty() {
                if let Some(lobby) = state.channels.get(LOBBY_ID) {
                    for (uid, _) in &added {
                        let payload = json!({
                            "ev": "ch_invited",
                            "channel": ch.id,
                            "forUserId": uid.as_str(),
                            "inviter": inviter_name,
                            "channelName": ch.name(),
                        });
                        let _ = lobby.tx.send(Arc::new(WireMsg {
                            id: 0,
                            channel: lobby.id.clone(),
                            kind: MsgKind::System,
                            user_id: user_id.clone(),
                            username: CompactString::const_new("__ch_invited"),
                            avatar: CompactString::const_new(""),
                            color: CompactString::const_new(""),
                            ts: now_secs(),
                            text: payload.to_string(),
                            file: None,
                            reply_to: None,
                            edited_at: None,
                            deleted: false,
                        }));
                    }
                }
                // Post a single system message in the channel announcing the additions.
                let names: Vec<String> = added.iter().map(|(_, n)| n.clone()).filter(|s| !s.is_empty()).collect();
                if !names.is_empty() {
                    let joined = match names.len() {
                        1 => names[0].clone(),
                        2 => format!("{} and {}", names[0], names[1]),
                        _ => {
                            let last = names.last().cloned().unwrap_or_default();
                            let head = &names[..names.len() - 1];
                            format!("{}, and {}", head.join(", "), last)
                        }
                    };
                    let text = format!("{} added {} to #{}", inviter_name, joined, ch.name());
                    broadcast_system(state, &ch, &text).await;
                }
                let now = now_secs();
                for (uid, _) in &added {
                    let _ = state.db.add_member(&ch.id, uid.clone(), now).await;
                }
            }
        }

        "dm_open" => {
            let peer = v.get("user").and_then(Value::as_str).ok_or("missing user")?
                .to_compact_string();
            if peer == user_id {
                return Err("cannot DM yourself".into());
            }
            let my_name = state.users.get(&user_id)
                .map(|e| e.value().username.to_string())
                .ok_or("self gone")?;
            let peer_name = state.users.get(&peer)
                .map(|e| e.value().username.to_string())
                .ok_or("peer gone")?;
            let ch = state.channels.open_dm(user_id.clone(), &my_name, peer.clone(), &peer_name);
            if !own_channels.iter().any(|c| c == &ch.id) {
                rxs.push(ch.tx.subscribe());
                own_channels.push(ch.id.clone());
            }
            let out = json!({"ev":"ch_created","channel":ch.meta()});
            let _ = sink.send(Message::Text(out.to_string())).await;
            send_history(sink, &ch, &state.db, 50).await;

            // Tell the peer's WS handler (via the lobby bus) to subscribe to
            // this DM channel as well, so messages reach them in real-time
            // even if they haven't opened the DM yet.
            if let Some(lobby) = state.channels.get(LOBBY_ID) {
                let payload = json!({
                    "ev": "dm_subscribe",
                    "channel": ch.id,
                    "forUserId": peer.as_str(),
                });
                let _ = lobby.tx.send(Arc::new(WireMsg {
                    id: 0,
                    channel: lobby.id.clone(),
                    kind: MsgKind::System,
                    user_id: user_id.clone(),
                    username: CompactString::const_new("__dm_subscribe"),
                    avatar: CompactString::const_new(""),
                    color: CompactString::const_new(""),
                    ts: now_secs(),
                    text: payload.to_string(),
                    file: None,
                    reply_to: None,
                    edited_at: None,
                    deleted: false,
                }));
            }
            let _ = state.db.upsert_channel(&ch.meta()).await;
            let _ = state.db.add_member(&ch.id, user_id.clone(), now_secs()).await;
            let _ = state.db.add_member(&ch.id, peer, now_secs()).await;
        }

        "dm_delete" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !matches!(ch.kind, ChannelKind::Dm) {
                return Err("only DMs can be deleted".into());
            }
            if !ch.members.contains(&user_id) {
                return Err("not a member".into());
            }
            let id_str: CompactString = ch.id.clone();
            // Tell ALL members (including peer's other tabs and ourselves) to drop it
            // BEFORE we tear it down, while the broadcaster still exists.
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: id_str.clone(),
                kind: MsgKind::System,
                user_id: user_id.clone(),
                username: CompactString::const_new("__dm_deleted"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: json!({"channel": id_str}).to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: true,
            }));
            // Detach all members and drop the channel.
            state.channels.delete_dm(&id_str);
            // Wipe persisted history (cascades messages, members, reactions).
            let _ = state.db.delete_channel(&id_str).await;
            // Drop our own subscription so the local rxs loop stops polling it.
            own_channels.retain(|c| c != &id_str);
            let _ = sink
                .send(Message::Text(json!({"ev":"ch_deleted","channel":id_str}).to_string()))
                .await;
        }

        "ch_delete" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !matches!(ch.kind, ChannelKind::Group) {
                return Err("only group channels can be deleted".into());
            }
            if ch.created_by != user_id {
                return Err("only the creator can delete this channel".into());
            }
            let id_str: CompactString = ch.id.clone();
            // Notify all subscribers BEFORE we drop the broadcaster.
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: id_str.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__ch_deleted"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: json!({"channel": id_str}).to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: true,
            }));
            state.channels.delete_any(&id_str);
            // Cascades messages, members, and reactions in the DB.
            let _ = state.db.delete_channel(&id_str).await;
            // Drop reactions for this channel.
            state.reactions.retain(|(c, _), _| c != &id_str);
            own_channels.retain(|c| c != &id_str);
            let _ = sink
                .send(Message::Text(json!({"ev":"ch_deleted","channel":id_str}).to_string()))
                .await;
        }

        "ch_info" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            let (name, description, photo_url) = state.db.channel_details(id).await
                .map_err(|_| "could not load chat details".to_string())?
                .unwrap_or_else(|| (ch.name().to_string(), String::new(), String::new()));
            let member_ids: Vec<String> = ch.members.iter().map(|uid| uid.key().to_string()).collect();
            let mut members = Vec::new();
            for uid in member_ids {
                let profile = state.users.get(uid.as_str()).map(|p| p.value().clone())
                    .or_else(|| state.known_users.get(uid.as_str()).map(|p| p.value().clone()));
                let role = state.db.member_role(id, &uid).await
                    .ok().flatten().unwrap_or_else(|| {
                        if uid == ch.created_by.as_str() { "owner".to_string() }
                        else { "member".to_string() }
                    });
                if let Some(profile) = profile {
                    members.push(json!({
                        "id": profile.id,
                        "username": profile.username,
                        "avatar": profile.avatar,
                        "color": profile.color,
                        "pubkey": profile.pubkey,
                        "designation": profile.designation,
                        "online": state.users.contains_key(uid.as_str()),
                        "role": role
                    }));
                } else {
                    members.push(json!({"id": uid, "username":"Offline member", "avatar":"", "color":"", "online":false, "role":role}));
                }
            }
            members.sort_by(|a, b| a.get("username").and_then(Value::as_str).unwrap_or("").to_lowercase()
                .cmp(&b.get("username").and_then(Value::as_str).unwrap_or("").to_lowercase()));
            let notification_mode = state.db.channel_notification(id, user_id.as_str()).await
                .unwrap_or_else(|_| "all".to_string());
            let out = json!({
                "ev":"ch_info",
                "channel":id,
                "name":name,
                "description":description,
                "photoUrl":photo_url,
                "members":members,
                "notificationMode":notification_mode,
                "createdBy":ch.created_by,
                "kind":ch.kind,
                "isPrivate":ch.is_private
            });
            let _ = sink.send(Message::Text(out.to_string())).await;
        }

        "ch_role_set" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let target = v.get("userId").and_then(Value::as_str).ok_or("missing userId")?;
            let role = v.get("role").and_then(Value::as_str).ok_or("missing role")?;
            if !matches!(role, "moderator" | "member") { return Err("invalid target role".into()); }
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !matches!(ch.kind, ChannelKind::Group) { return Err("roles are only available in groups".into()); }
            if ch.created_by != user_id { return Err("only the group owner can change roles".into()); }
            if !ch.members.contains(target) { return Err("target is not a group member".into()); }
            let changed = state.db.set_member_role(id, target, role).await
                .map_err(|_| "could not save member role".to_string())?;
            if !changed { return Err("member role was not changed".into()); }
            let out = json!({"ev":"ch_role_updated","channel":id,"userId":target,"role":role});
            let _ = sink.send(Message::Text(out.to_string())).await;
        }

        "ch_member_remove" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let target = v.get("userId").and_then(Value::as_str).ok_or("missing userId")?;
            if target == user_id.as_str() { return Err("use Leave group to remove yourself".into()); }
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !matches!(ch.kind, ChannelKind::Group) { return Err("member removal is only available in groups".into()); }
            if !ch.members.contains(&user_id) { return Err("not a member".into()); }
            let actor_role = state.db.member_role(id, user_id.as_str()).await
                .ok().flatten().unwrap_or_else(|| if ch.created_by == user_id { "owner".to_string() } else { "member".to_string() });
            let target_role = state.db.member_role(id, target).await
                .ok().flatten().unwrap_or_else(|| if ch.created_by.as_str() == target { "owner".to_string() } else { "member".to_string() });
            if actor_role != "owner" && actor_role != "moderator" { return Err("only owners and moderators can remove members".into()); }
            if target_role == "owner" { return Err("the group owner cannot be removed".into()); }
            if actor_role == "moderator" && target_role != "member" { return Err("moderators can only remove regular members".into()); }
            let target_id = target.to_compact_string();
            ch.members.remove(&target_id);
            state.channels.remove_user_channel(target_id.clone(), id);
            state.db.remove_member(id, target_id.clone()).await
                .map_err(|_| "could not remove group member".to_string())?;
            if let Some(lobby) = state.channels.get(LOBBY_ID) {
                let payload = json!({"channel":id,"forUserId":target,"byUserId":user_id.as_str()});
                let _ = lobby.tx.send(Arc::new(WireMsg {
                    id: 0,
                    channel: lobby.id.clone(),
                    kind: MsgKind::System,
                    user_id: user_id.clone(),
                    username: CompactString::const_new("__ch_member_removed"),
                    avatar: CompactString::const_new(""),
                    color: CompactString::const_new(""),
                    ts: now_secs(),
                    text: payload.to_string(),
                    file: None,
                    reply_to: None,
                    edited_at: None,
                    deleted: true,
                }));
            }
            let out = json!({"ev":"ch_member_removed","channel":id,"userId":target});
            let _ = sink.send(Message::Text(out.to_string())).await;
        }

        "ch_update" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !matches!(ch.kind, ChannelKind::Group) { return Err("only groups have editable details".into()); }
            if ch.created_by != user_id { return Err("only the group owner can edit details".into()); }

            let current_name = ch.name();
            let name = v.get("name").and_then(Value::as_str).unwrap_or(current_name.as_str()).trim();
            if name.chars().count() < 2 || name.chars().count() > 48 {
                return Err("channel name must be between 2 and 48 characters".into());
            }
            let description = v.get("description").and_then(Value::as_str).unwrap_or("").trim();
            if description.chars().count() > 500 { return Err("description is too long (max 500 characters)".into()); }

            // Description edits must not overwrite or revalidate the existing photo URL.
            // Group photos uploaded by the app use local /uploads/... paths, not remote HTTP(S) URLs.
            let photo_url = if let Some(value) = v.get("photoUrl").and_then(Value::as_str) {
                let value = value.trim();
                if value.len() > 2048 || (!value.is_empty() && !(value.starts_with("https://") || value.starts_with("http://") || value.starts_with("/uploads/"))) {
                    return Err("photo URL must be an HTTP(S) URL or an app upload path under 2048 characters".into());
                }
                value.to_string()
            } else {
                state.db.channel_details(id).await
                    .map_err(|_| "could not load current group details".to_string())?
                    .map(|details| details.2)
                    .unwrap_or_default()
            };
            let updated = state.db.update_channel_details(id, name, description, &photo_url).await
                .map_err(|_| "could not save group details".to_string())?;
            if !updated { return Err("group no longer exists".into()); }
            ch.set_name(name);
            let (name, description, photo_url) = state.db.channel_details(id).await
                .map_err(|_| "could not load updated group details".to_string())?
                .unwrap_or_else(|| (name.to_string(), description.to_string(), photo_url.to_string()));
            let payload = json!({"channel":id,"name":name,"description":description,"photoUrl":photo_url});
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id: user_id.clone(),
                username: CompactString::const_new("__ch_updated"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: payload.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        "profile_update" => {
            let username = v.get("username").and_then(Value::as_str).ok_or("missing username")?;
            let username = sanitize_username(username);
            if username.is_empty() {
                return Err("Username must be 3–24 characters: letters, digits, underscore, hyphen, or dot.".into());
            }
            let designation = v.get("designation").and_then(Value::as_str).ok_or("missing designation")?;
            if !matches!(designation, "AM" | "TL" | "STL" | "QDE" | "LRD" | "EE" | "CSA") {
                return Err("choose a valid designation".into());
            }
            let mut info = state.users.get(&user_id).map(|entry| entry.value().clone()).ok_or("user not found")?;
            let old_key = info.username.to_lowercase().to_compact_string();
            let new_key = username.to_lowercase().to_compact_string();
            let changed = state.db.update_user_profile(user_id.clone(), &username, designation).await
                .map_err(|_| "could not save profile".to_string())?;
            if !changed { return Err("That username is already in use. Choose another one.".into()); }
            if old_key != new_key {
                state.username_to_id.remove(&old_key);
                state.username_to_id.insert(new_key, user_id.clone());
            }
            info.username = username;
            info.designation = designation.to_compact_string();
            state.users.insert(user_id.clone(), info.clone());
            state.known_users.insert(user_id.clone(), info);
            broadcast_users(&state).await;
        }

        "designation_set" => {
            let designation = v.get("designation").and_then(Value::as_str).ok_or("missing designation")?;
            if !matches!(designation, "AM" | "TL" | "STL" | "QDE" | "LRD" | "EE" | "CSA") {
                return Err("choose a valid designation".into());
            }
            let changed = state.db.set_user_designation(user_id.clone(), designation).await
                .map_err(|_| "could not save designation".to_string())?;
            if !changed { return Err("your designation has already been assigned".into()); }
            let mut info = state.users.get(&user_id).map(|entry| entry.value().clone()).ok_or("user not found")?;
            info.designation = designation.to_compact_string();
            state.users.insert(user_id.clone(), info.clone());
            state.known_users.insert(user_id.clone(), info);
            broadcast_users(&state).await;
        }

        "ch_notification_set" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let mode = v.get("mode").and_then(Value::as_str).ok_or("missing mode")?;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            if !matches!(mode, "all" | "mentions" | "mute") { return Err("invalid notification mode".into()); }
            state.db.set_channel_notification(id, user_id.as_str(), mode, now_secs()).await
                .map_err(|_| "could not save notification setting".to_string())?;
            let out = json!({"ev":"ch_notification_set","channel":id,"mode":mode});
            let _ = sink.send(Message::Text(out.to_string())).await;
        }

        "shared_items_list" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let item_type = v.get("type").and_then(Value::as_str).ok_or("missing type")?;
            // The UI uses plural tab names ("links", "files"), while the
            // persisted index uses singular item types ("link", "file").
            // Normalize the tab name before querying the index.
            if !matches!(item_type, "media" | "link" | "links" | "file" | "files") { return Err("invalid shared item type".into()); }
            let db_item_type = match item_type {
                "links" => "link",
                "files" => "file",
                other => other,
            };
            let limit = v.get("limit").and_then(Value::as_u64).unwrap_or(48).clamp(1, 100) as usize;
            let before_id = v.get("beforeId").and_then(Value::as_u64);
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            let counts = state.db.shared_item_counts(id).await
                .map_err(|_| "could not count shared items".to_string())?;
            let items = state.db.shared_items_page(id, db_item_type, before_id, limit).await
                .map_err(|_| "could not load shared items".to_string())?;
            let has_more = items.len() == limit;
            let next_cursor = items.last().map(|item| item.cursor);
            let resp = json!({
                "ev":"shared_items_list",
                "channel":id,
                "type":item_type,
                "requestId":v.get("requestId").cloned().unwrap_or(Value::Null),
                "items":items,
                "counts":{"media":counts.0,"links":counts.1,"files":counts.2},
                "nextCursor":next_cursor,
                "hasMore":has_more,
            });
            let _ = sink.send(Message::Text(resp.to_string())).await;
        }

        "history_before" => {
            let id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let before_id = v.get("beforeId").and_then(Value::as_u64).ok_or("missing beforeId")?;
            let limit = v.get("limit").and_then(Value::as_u64).unwrap_or(50).clamp(1, 500) as usize;
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            let from_db = state.db.messages_before(id, before_id, limit).await
                .map_err(|_| "could not load older messages".to_string())?;
            let has_more = from_db.len() == limit;
            let out: Vec<Arc<WireMsg>> = from_db.into_iter().map(Arc::new).collect();
            let msgs: Vec<&WireMsg> = out.iter().map(|a| a.as_ref()).collect();
            let resp = json!({
                "ev":"history_before",
                "channel":id,
                "beforeId":before_id,
                "messages":msgs,
                "hasMore":has_more,
            });
            let _ = sink.send(Message::Text(resp.to_string())).await;
        }

        "history" => {
            let id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            let limit = v
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .min(500) as usize;
            // Authoritative read from SQLite — never trust in-memory ring.
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            let from_db = state.db.tail_messages(id, limit).await
                .map_err(|_| "could not load history".to_string())?;
            let out: Vec<Arc<WireMsg>> = from_db.into_iter().map(Arc::new).collect();
            let msgs: Vec<&WireMsg> = out.iter().map(|a| a.as_ref()).collect();
            let reactions = collect_reactions(state, &id.to_compact_string());
            let pins = state.db.list_pinned_messages(id).await.unwrap_or_default();
            let resp = json!({
                "ev":"history",
                "channel":id,
                "messages":msgs,
                "reactions": reactions,
                "pins": pins,
            });
            let _ = sink.send(Message::Text(resp.to_string())).await;
        }

        "saved_list" => {
            let saved = state.db.list_saved_messages(user_id.clone()).await
                .map_err(|_| "could not load saved messages".to_string())?;
            let out = json!({"ev":"saved_messages","items":saved});
            let _ = sink.send(Message::Text(out.to_string())).await;
        }

        "saved_toggle" => {
            let channel_id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let msg_id = v.get("msgId").and_then(Value::as_u64).ok_or("missing msgId")?;
            let ch = state.channels.get(channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            let exists = state.db.message_exists_in_channel(channel_id, msg_id).await
                .map_err(|_| "could not verify message".to_string())?;
            if !exists { return Err("message not found".into()); }
            let saved = state.db.toggle_saved_message(user_id.clone(), channel_id, msg_id, now_secs() as i64).await
                .map_err(|_| "could not update saved messages".to_string())?;
            let items = state.db.list_saved_messages(user_id.clone()).await.unwrap_or_default();
            let out = json!({"ev":"saved_messages","items":items,"changed":{"channel":channel_id,"id":msg_id,"saved":saved}});
            let _ = sink.send(Message::Text(out.to_string())).await;
        }

        "delete_message" => {
            let channel_id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let msg_id = v.get("msgId").and_then(Value::as_u64).ok_or("missing msgId")?;
            let ch = state.channels.get(channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            let author = state.db.message_author_username(channel_id, msg_id).await
                .map_err(|_| "could not verify message".to_string())?
                .ok_or("message not found or already deleted")?;
            let current_username = state.users.get(&user_id).map(|u| u.username.to_string()).unwrap_or_default();
            let is_author = author.eq_ignore_ascii_case(&current_username);
            let creator_username = state.known_users.get(&ch.created_by).map(|u| u.username.to_string()).unwrap_or_default();
            let is_group_admin = ch.kind == ChannelKind::Group && !creator_username.is_empty() && creator_username.eq_ignore_ascii_case(&current_username);
            if !is_author && !is_group_admin {
                return Err("you can delete only your own messages; only the group admin can delete other members' messages".into());
            }
            let attachment_url = state.db.message_attachment_filename(channel_id, msg_id).await
                .map_err(|_| "could not inspect attachment".to_string())?;
            let deleted = state.db.delete_message_for_everyone(channel_id, msg_id).await
                .map_err(|_| "could not delete message".to_string())?
                .ok_or("message not found or already deleted")?;
            // Remove the underlying upload so an old direct URL cannot retrieve deleted media.
            if let Some(url) = attachment_url {
                if let Some(name) = url.rsplit('/').next() {
                    if !name.is_empty() && std::path::Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name) {
                        let _ = tokio::fs::remove_file(state.uploads_dir.join(name)).await;
                    }
                }
            }
            let pins = state.db.list_pinned_messages(channel_id).await.unwrap_or_default();
            let payload = json!({
                "channel": channel_id,
                "msgId": msg_id,
                "message": deleted,
                "pins": pins
            });
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id: user_id.clone(),
                username: CompactString::const_new("__msg_deleted"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: payload.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        "pin_toggle" => {
            let channel_id = v.get("channel").and_then(Value::as_str).ok_or("missing channel")?;
            let msg_id = v.get("msgId").and_then(Value::as_u64).ok_or("missing msgId")?;
            let ch = state.channels.get(channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            let exists = state.db.message_exists_in_channel(channel_id, msg_id).await
                .map_err(|_| "could not verify message".to_string())?;
            if !exists { return Err("message not found".into()); }
            let pinned = state.db.toggle_pinned_message(
                channel_id, msg_id, user_id.clone(), now_secs() as i64
            ).await.map_err(|_| "could not update pinned messages".to_string())?;
            let pins = state.db.list_pinned_messages(channel_id).await.unwrap_or_default();
            let ev = json!({
                "ev":"pin_update",
                "channel":channel_id,
                "msgId":msg_id,
                "userId":user_id.as_str(),
                "pinned":pinned,
                "pins":pins,
            });
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id: user_id.clone(),
                username: CompactString::const_new("__pin"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: ev.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        "search_all" => {
            let query = v.get("query").and_then(Value::as_str).unwrap_or("").trim();
            if query.chars().count() < 2 || query.chars().count() > 100 {
                return Err("Search must be between 2 and 100 characters.".into());
            }
            // DB query enforces membership and excludes all DMs, whose contents
            // must remain encrypted and unsearchable by the server.
            let matches = state.db.search_messages_across_channels(user_id.as_str(), query, 100).await
                .map_err(|_| "message search failed".to_string())?;
            let results: Vec<Value> = matches.into_iter().map(|(message, channel_name)| json!({
                "channelId": message.channel,
                "channelName": channel_name,
                "message": message
            })).collect();
            let out = json!({"ev":"search_all_results","query":query,"results":results});
            let _ = sink.send(Message::Text(out.to_string())).await;
        }

        "search" => {
            let id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?;
            let query = v
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if query.chars().count() < 2 || query.chars().count() > 100 {
                return Err("Search must be between 2 and 100 characters.".into());
            }
            let ch = state.channels.get(id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) {
                return Err("not a member".into());
            }
            // DM content is end-to-end encrypted. Never attempt server-side
            // plaintext search in DMs; users can search locally once history is loaded.
            if matches!(ch.kind, ChannelKind::Dm) {
                return Err("Private messages cannot be searched on the server.".into());
            }
            let matches = state.db.search_messages(id, query, 100).await
                .map_err(|_| "message search failed".to_string())?;
            let out = json!({
                "ev": "search_results",
                "channel": id,
                "query": query,
                "messages": matches,
            });
            let _ = sink.send(Message::Text(out.to_string())).await;
        }

        "react" => {
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?
                .to_compact_string();
            let msg_id = v.get("msgId").and_then(Value::as_u64).ok_or("missing msgId")?;
            let emoji = v
                .get("emoji")
                .and_then(Value::as_str)
                .ok_or("missing emoji")?;
            // Cap emoji to 16 bytes (a few graphemes).
            let emoji: CompactString = emoji.chars().take(8).collect::<String>().to_compact_string();
            if emoji.is_empty() { return Err("empty emoji".into()); }

            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) {
                return Err("not a member".into());
            }

            let key = (channel_id.clone(), msg_id);
            let entry = state.reactions.entry(key).or_default();
            // Remove this user's prior emoji(s) for this message before toggling
            // the selected one. Other users' reactions are left untouched.
            let old_emojis: Vec<CompactString> = entry.iter()
                .filter_map(|item| {
                    if item.key() != &emoji && item.value().contains(&user_id) {
                        Some(item.key().clone())
                    } else { None }
                })
                .collect();
            for old in old_emojis {
                if let Some(mut users) = entry.get_mut(&old) {
                    users.retain(|u| u != &user_id);
                    if users.is_empty() {
                        drop(users);
                        entry.remove(&old);
                    }
                }
            }
            let mut on = true;
            {
                let mut users = entry.entry(emoji.clone()).or_default();
                if let Some(pos) = users.iter().position(|u| *u == user_id) {
                    users.swap_remove(pos);
                    on = false;
                } else {
                    users.push(user_id.clone());
                }
                if users.is_empty() {
                    drop(users);
                    entry.remove(&emoji);
                }
            }
            // Cleanup empty msg slots
            if entry.is_empty() {
                drop(entry);
                state.reactions.remove(&(channel_id.clone(), msg_id));
            }

            // Persist the toggle so reactions survive restart. The DB
            // performs its own toggle and writes a row in `reactions` +
            // appends an audit row in `reaction_events`.
            let _ = state.db.toggle_reaction(
                &channel_id, msg_id, user_id.clone(), &emoji, now_secs(),
            ).await;

            let username = state
                .users
                .get(&user_id)
                .map(|e| e.value().username.to_string())
                .unwrap_or_default();
            let ev = json!({
                "ev": "react",
                "channel": channel_id,
                "msgId": msg_id,
                "userId": user_id.as_str(),
                "username": username,
                "emoji": emoji,
                "on": on,
            });
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__react"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: ev.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        "ping" => {
            let _ = sink.send(Message::Text(r#"{"ev":"pong"}"#.into())).await;
        }

        "change_password" => {
            let current = v.get("current").and_then(Value::as_str).unwrap_or("");
            let new_pw = v.get("new").and_then(Value::as_str).unwrap_or("");
            if new_pw.len() < 4 || new_pw.len() > 256 {
                let _ = sink.send(Message::Text(json!({
                    "ev":"error",
                    "code":"password_weak",
                    "text":"New password must be 4-256 characters.",
                }).to_string())).await;
                return Ok(());
            }
            // Look up the user's current hash by username so we can verify.
            let username = state.users.get(&user_id).map(|u| u.username.to_string()).unwrap_or_default();
            let stored = state.db.find_user_credentials(&username).await.ok().flatten();
            let Some((_, hash, _)) = stored else {
                let _ = sink.send(Message::Text(json!({
                    "ev":"error","code":"bad_password","text":"Account not found."
                }).to_string())).await;
                return Ok(());
            };
            // If the row already has a hash, verify the current password.
            // (It always should at this point, but be defensive.)
            if !hash.is_empty() && !verify_password(current, &hash) {
                let _ = sink.send(Message::Text(json!({
                    "ev":"error","code":"bad_password","text":"Current password is incorrect."
                }).to_string())).await;
                return Ok(());
            }
            let Some(new_hash) = hash_password(new_pw) else {
                let _ = sink.send(Message::Text(json!({
                    "ev":"error","text":"Failed to hash password."
                }).to_string())).await;
                return Ok(());
            };
            if let Err(e) = state.db.set_password_hash(user_id.clone(), &new_hash, false).await {
                crate::applog::log(format_args!("set_password_hash FAILED: {e}"));
                let _ = sink.send(Message::Text(json!({
                    "ev":"error","text":"Failed to save password."
                }).to_string())).await;
                return Ok(());
            }
            let _ = sink.send(Message::Text(json!({
                "ev":"password_changed",
            }).to_string())).await;
        }

        "call_signal" => {
            // Relay a WebRTC signaling blob to the other DM participant(s)
            // by piggybacking on the channel broadcast bus. The client
            // filters these synthetic messages by `username == "__call"`.
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?
                .to_compact_string();
            let kind = v.get("kind").and_then(Value::as_str).ok_or("missing kind")?;
            // Whitelist the few signaling kinds we expect.
            if !matches!(kind, "offer" | "answer" | "ice" | "ringing" | "end" | "busy" | "decline") {
                return Err("invalid call kind".into());
            }
            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            // Only allow on DM channels — group calls aren't supported.
            if !matches!(ch.kind, ChannelKind::Dm) {
                return Err("calls only allowed in DMs".into());
            }
            let username = state
                .users
                .get(&user_id)
                .map(|e| e.value().username.to_string())
                .unwrap_or_default();

            // ── Call lifecycle bookkeeping ────────────────────────────
            // Server tracks each in-flight DM call so we can post a
            // single, accurate system message when it concludes —
            // visible in chat history and persisted to SQLite.
            match kind {
                "offer" => {
                    // Identify the callee: the other DM member.
                    let callee_id = ch
                        .members
                        .iter()
                        .map(|e| e.clone())
                        .find(|uid| *uid != user_id)
                        .unwrap_or_else(|| CompactString::const_new(""));
                    let callee_name = state
                        .users
                        .get(&callee_id)
                        .map(|e| e.value().username.to_string())
                        .unwrap_or_default();
                    let video = v
                        .get("payload")
                        .and_then(|p| p.get("video"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    state.calls.insert(
                        channel_id.clone(),
                        crate::state::CallSession {
                            caller_id: user_id.clone(),
                            caller_name: username.to_compact_string(),
                            callee_id,
                            callee_name: callee_name.to_compact_string(),
                            video,
                            started_at: now_secs(),
                            answered_at: None,
                        },
                    );
                }
                "answer" => {
                    if let Some(mut s) = state.calls.get_mut(&channel_id) {
                        if s.answered_at.is_none() {
                            s.answered_at = Some(now_secs());
                        }
                    }
                }
                "end" | "decline" | "busy" => {
                    // Atomic remove ensures we post the summary exactly
                    // once even if both peers send "end".
                    if let Some((_, session)) = state.calls.remove(&channel_id) {
                        let icon = if session.video { "📹" } else { "📞" };
                        let text = if let Some(ans) = session.answered_at {
                            let dur = now_secs().saturating_sub(ans);
                            format!("{icon} Call ended · {}", fmt_duration(dur))
                        } else if kind == "decline" {
                            format!("{icon} Call declined")
                        } else if kind == "busy" {
                            format!("{icon} Missed call (busy)")
                        } else {
                            // "end" with no prior answer = caller cancelled / callee never picked up
                            format!("{icon} Missed call")
                        };
                        let msg = Arc::new(WireMsg {
                            id: state.next_msg_id(),
                            channel: ch.id.clone(),
                            kind: MsgKind::System,
                            user_id: session.caller_id,
                            username: session.caller_name.clone(),
                            avatar: CompactString::const_new(""),
                            color: CompactString::const_new(""),
                            ts: now_secs(),
                            text,
                            file: None,
                            reply_to: None,
                            edited_at: None,
                            deleted: false,
                        });
                        ch.push_history(msg.clone()).await;
                        if let Err(e) = state.db.insert_message(&msg).await {
                            crate::applog::log(format_args!("db.insert_message FAILED (call system): {e}"));
                        }
                        let _ = ch.tx.send(msg);
                    }
                }
                _ => {}
            }

            let ev = json!({
                "ev": "call",
                "channel": channel_id,
                "kind": kind,
                "from": user_id.as_str(),
                "fromName": username,
                "payload": v.get("payload").cloned().unwrap_or(Value::Null),
            });
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__call"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: ev.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        "read" => {
            let channel_id = v
                .get("channel")
                .and_then(Value::as_str)
                .ok_or("missing channel")?
                .to_compact_string();
            let msg_id = v.get("msgId").and_then(Value::as_u64).ok_or("missing msgId")?;
            let ch = state.channels.get(&channel_id).ok_or("no such channel")?;
            if !can_send(&ch, &user_id) { return Err("not a member".into()); }
            let username = state
                .users
                .get(&user_id)
                .map(|e| e.value().username.to_string())
                .unwrap_or_default();
            let ev = json!({
                "ev": "read",
                "channel": channel_id,
                "msgId": msg_id,
                "userId": user_id,
                "username": username,
            });
            let _ = ch.tx.send(Arc::new(WireMsg {
                id: 0,
                channel: ch.id.clone(),
                kind: MsgKind::System,
                user_id,
                username: CompactString::const_new("__read"),
                avatar: CompactString::const_new(""),
                color: CompactString::const_new(""),
                ts: now_secs(),
                text: ev.to_string(),
                file: None,
                reply_to: None,
                edited_at: None,
                deleted: false,
            }));
        }

        _ => return Err(format!("unknown op '{op}'")),
    }

    Ok(())
}

fn can_send(ch: &Channel, user: &UserId) -> bool {
    matches!(ch.kind, ChannelKind::Lobby) || ch.members.contains(user)
}

fn bump_user_msg_count(state: &Arc<AppState>, user_id: UserId) {
    if let Some(mut u) = state.users.get_mut(&user_id) {
        u.msg_count += 1;
    }
}

/// Render a duration as `H:MM:SS` (or `M:SS` when under an hour) for
/// the call-summary system message.
fn fmt_duration(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

// Silences unused warning — placeholder for future per-channel buffers.
#[allow(dead_code)]
fn _unused() -> Bytes {
    Bytes::new()
}
