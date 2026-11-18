//! The A1 link loop (device-design §2.2, §3.1, §3.3, §6.3).
//!
//! Dial mTLS → send the signed hello with a single-use ticket → parse hello_ack → heartbeat on
//! the server's cadence → apply lease renewals → forward every other downlink verbatim. On a
//! clock discontinuity, an OS resume, or a lost stream the held leases are invalidated and the
//! session is dropped; the loop then redials with a FRESH ticket, because
//! `work.activate_device_session` always mints a new session (see the parent module doc).
//!
//! The loop is async, but the sync core is not: it feeds tickets and commands in and reads
//! events out through `tokio::sync::mpsc`, so the journal/permit/recovery code keeps its
//! blocking shape. Nothing here consumes an offer, a command, a cancel or an ack — those frames
//! reach the core as [`LinkEvent::Downlink`] untouched (the A2/A3 boundary).

use std::sync::{Arc, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use http::uri::PathAndQuery;
use http::Uri;
use serde_json::Value;
use tokio::sync::mpsc;
use tonic::client::Grpc;
use tonic::codec::Streaming;
use tonic::codegen::tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Channel, Endpoint};
use tonic::Request;

use crate::frame::envelope::{Envelope, SCHEMA_VERSION};
use crate::frame::hello::{HelloBody, FRAME_TYPE as HELLO_FRAME_TYPE};
use crate::frame::lease::{HeartbeatBody, LeaseBody, HEARTBEAT_FRAME_TYPE};
use crate::frame::rfc3339::format_utc_seconds;
use crate::frame::sign::SignError;
use crate::key::DeviceKey;

use super::codec::{FrameCodec, MAX_FRAME_BYTES};
use super::tls::{DeviceTlsConnector, TlsError};
use super::{
    clock_discontinuity, is_lease_frame, parse_hello_ack, reconnect_delay, AckError,
    ClientIdentity, HelloAck, LeaseLoss, LeaseSet, LinkCommand, LinkConfig, LinkEvent,
    CONNECT_PATH, PROTOCOL_MAJOR, PROTOCOL_MINOR, REQUIRED_FEATURES,
};

/// How many uplink frames may be queued for the gRPC writer before the loop waits. §3.1 caps
/// non-content frames at 20/s with a 40 burst, so this is comfortably above one cadence window.
const UPLINK_BUFFER: usize = 64;

/// Why a dial or an exchange failed.
#[derive(Debug)]
pub enum LinkError {
    /// The platform TLS stack refused the key material.
    Tls(TlsError),
    /// The device key could not sign the hello.
    Sign(SignError),
    /// The wall clock is before the epoch or beyond the four-digit year the wire grammar allows.
    Clock,
    /// The gateway's hello_ack was refused.
    Ack(AckError),
    /// The endpoint, the dial, the stream or the JSON encoding failed.
    Transport(String),
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Tls(err) => write!(f, "tls: {err}"),
            Self::Sign(err) => write!(f, "hello signature: {err:?}"),
            Self::Clock => write!(f, "wall clock outside the wire timestamp grammar"),
            Self::Ack(err) => write!(f, "hello_ack refused: {err:?}"),
            Self::Transport(reason) => write!(f, "transport: {reason}"),
        }
    }
}

impl std::error::Error for LinkError {}

/// The device-side live link.
pub struct Link {
    config: LinkConfig,
    key: Arc<dyn DeviceKey + Send + Sync>,
}

impl Link {
    /// Build a link. The key is shared with the sync core, which signs receipts and verdicts
    /// with the SAME device key the mTLS certificate binds (§2.1: the CA only sees the public
    /// key, and SQL forbids a key change on renewal or ticket mint).
    pub fn new(config: LinkConfig, key: Arc<dyn DeviceKey + Send + Sync>) -> Self {
        Self { config, key }
    }

    /// Run until stopped. `tickets` supplies one fresh single-use ticket per dial attempt;
    /// `commands` carries the core's lease and discontinuity instructions; `events` reports
    /// everything back. Closing either input channel stops the loop.
    pub async fn run(
        mut self,
        mut tickets: mpsc::Receiver<String>,
        mut commands: mpsc::Receiver<LinkCommand>,
        events: mpsc::Sender<LinkEvent>,
    ) {
        let mut leases = LeaseSet::default();
        let mut attempt: u32 = 0;
        loop {
            // Tell the core this dial attempt needs a ticket, but ONLY when none is buffered. The
            // GW18 pump withdraws from the single-use slot on exactly this signal, so emitting it
            // with a ticket already queued would spend a second ticket the link does not need.
            if tickets.is_empty() && events.send(LinkEvent::AwaitingTicket).await.is_err() {
                return;
            }
            let ticket = loop {
                tokio::select! {
                    incoming = tickets.recv() => match incoming {
                        Some(ticket) => break ticket,
                        None => { let _ = events.send(LinkEvent::Stopped).await; return; }
                    },
                    command = commands.recv() => match command {
                        Some(LinkCommand::Stop) | None => {
                            let _ = events.send(LinkEvent::Stopped).await;
                            return;
                        }
                        Some(LinkCommand::Discontinuity(cause)) => {
                            let ids = leases.invalidate_all();
                            if !ids.is_empty()
                                && events.send(LinkEvent::LeasesInvalidated { ids, cause: cause.into() }).await.is_err()
                            {
                                return;
                            }
                        }
                        Some(LinkCommand::TrackLease { lease_id, fence, ttl, round_trip }) => {
                            leases.track(&lease_id, Instant::now(), ttl, round_trip, fence);
                        }
                        Some(LinkCommand::ReleaseLease { lease_id }) => { leases.release(&lease_id); }
                        Some(LinkCommand::ReplaceIdentity(identity)) => { self.config.identity = identity; }
                    },
                }
            };

            attempt += 1;
            let session = match establish(&self.config, self.key.as_ref(), &ticket).await {
                Ok(session) => session,
                Err(err) => {
                    if events
                        .send(LinkEvent::Disconnected {
                            reason: err.to_string(),
                            attempt,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    tokio::time::sleep(reconnect_delay(attempt, self.config.reconnect)).await;
                    continue;
                }
            };
            attempt = 0;
            if events
                .send(LinkEvent::SessionEstablished(Box::new(session.ack.clone())))
                .await
                .is_err()
            {
                return;
            }

            let outcome = self
                .drive(session, &mut leases, &mut commands, &events)
                .await;
            // Whatever ended the session, the leases it owned are now unrenewable: 0051 binds a
            // renewal to the lease's ORIGINAL session, and a reconnect mints a new one.
            let ids = leases.invalidate_all();
            if !ids.is_empty()
                && events
                    .send(LinkEvent::LeasesInvalidated {
                        ids,
                        cause: LeaseLoss::SessionLost,
                    })
                    .await
                    .is_err()
            {
                return;
            }
            match outcome {
                Drive::Stop => {
                    let _ = events.send(LinkEvent::Stopped).await;
                    return;
                }
                Drive::CoreGone => return,
                Drive::Lost(reason) => {
                    attempt += 1;
                    if events
                        .send(LinkEvent::Disconnected { reason, attempt })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    tokio::time::sleep(reconnect_delay(attempt, self.config.reconnect)).await;
                }
            }
        }
    }

    /// One established session: heartbeat, read downlinks, service commands, until something
    /// ends it. Returns why it ended.
    async fn drive(
        &mut self,
        session: Session,
        leases: &mut LeaseSet,
        commands: &mut mpsc::Receiver<LinkCommand>,
        events: &mpsc::Sender<LinkEvent>,
    ) -> Drive {
        let Session {
            _channel,
            uplink,
            mut downlink,
            ack,
        } = session;
        let mut tick = tokio::time::interval(ack.heartbeat_interval);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // interval's first tick fires immediately; the hello was this session's first uplink.
        tick.tick().await;
        let mut last_mono = Instant::now();
        let mut last_wall = SystemTime::now();
        let mut last_heartbeat_sent: Option<Instant> = None;

        loop {
            tokio::select! {
                _ = tick.tick() => {
                    let now = Instant::now();
                    let monotonic = now.duration_since(last_mono);
                    let wall = SystemTime::now().duration_since(last_wall).ok();
                    if clock_discontinuity(monotonic, wall) {
                        let ids = leases.invalidate_all();
                        if !ids.is_empty()
                            && events.send(LinkEvent::LeasesInvalidated { ids, cause: LeaseLoss::ClockJump }).await.is_err()
                        {
                            return Drive::CoreGone;
                        }
                        return Drive::Lost("clock discontinuity".into());
                    }
                    last_mono = now;
                    last_wall = SystemTime::now();
                    let body = heartbeat_body(&self.config, leases, now);
                    let env = match uplink_envelope(&self.config, &ack.session_id, HEARTBEAT_FRAME_TYPE, body.to_value()) {
                        Ok(env) => env,
                        Err(err) => return Drive::Lost(err.to_string()),
                    };
                    let raw = match serde_json::to_vec(&env) {
                        Ok(raw) => raw,
                        Err(err) => return Drive::Lost(format!("heartbeat encode: {err}")),
                    };
                    if uplink.send(Bytes::from(raw)).await.is_err() {
                        return Drive::Lost("uplink closed".into());
                    }
                    // Every lease renewal the server sends in answer to this heartbeat is
                    // measured from THIS send instant, not from each frame's arrival (§3.3).
                    last_heartbeat_sent = Some(now);
                }
                message = downlink.message() => {
                    let raw = match message {
                        Ok(Some(raw)) => raw,
                        Ok(None) => return Drive::Lost("gateway closed the stream".into()),
                        Err(status) => return Drive::Lost(status.to_string()),
                    };
                    let env: Envelope = match serde_json::from_slice(&raw) {
                        Ok(env) => env,
                        Err(err) => return Drive::Lost(format!("downlink envelope: {err}")),
                    };
                    if !downlink_acceptable(&env, &self.config.device_id, &ack.session_id) {
                        return Drive::Lost("downlink identity mismatch".into());
                    }
                    if is_lease_frame(&env) {
                        let body: LeaseBody = match serde_json::from_value(env.body.clone()) {
                            Ok(body) => body,
                            Err(err) => return Drive::Lost(format!("lease body: {err}")),
                        };
                        let now = Instant::now();
                        let sent = last_heartbeat_sent.unwrap_or(now);
                        let round_trip = now.duration_since(sent);
                        match leases.apply_renewal(sent, round_trip, &body) {
                            Some(state) => {
                                if events.send(LinkEvent::LeaseRenewal(state)).await.is_err() {
                                    return Drive::CoreGone;
                                }
                            }
                            // A renewal for a lease the link does not hold is forwarded, never
                            // treated as an acquisition (§3.1: leases come from run_start).
                            None => {
                                if events.send(LinkEvent::Downlink(Box::new(env))).await.is_err() {
                                    return Drive::CoreGone;
                                }
                            }
                        }
                    } else if events.send(LinkEvent::Downlink(Box::new(env))).await.is_err() {
                        return Drive::CoreGone;
                    }
                }
                command = commands.recv() => match command {
                    Some(LinkCommand::Stop) | None => return Drive::Stop,
                    Some(LinkCommand::TrackLease { lease_id, fence, ttl, round_trip }) => {
                        leases.track(&lease_id, Instant::now(), ttl, round_trip, fence);
                    }
                    Some(LinkCommand::ReleaseLease { lease_id }) => { leases.release(&lease_id); }
                    Some(LinkCommand::ReplaceIdentity(identity)) => { self.config.identity = identity; }
                    Some(LinkCommand::Discontinuity(cause)) => {
                        let ids = leases.invalidate_all();
                        if !ids.is_empty()
                            && events.send(LinkEvent::LeasesInvalidated { ids, cause: cause.into() }).await.is_err()
                        {
                            return Drive::CoreGone;
                        }
                        return Drive::Lost(format!("discontinuity: {cause:?}"));
                    }
                },
            }
        }
    }
}

/// Why one session ended.
enum Drive {
    /// The core asked to stop, or closed the command channel.
    Stop,
    /// The core closed the event channel; there is nobody left to report to.
    CoreGone,
    /// The stream or the protocol broke; redial with a fresh ticket.
    Lost(String),
}

/// One established Connect stream.
struct Session {
    /// Kept alive for the stream's lifetime: dropping the channel handle would tear down the
    /// HTTP/2 connection the response body is still reading from.
    _channel: Channel,
    uplink: mpsc::Sender<Bytes>,
    downlink: Streaming<Bytes>,
    ack: HelloAck,
}

/// Dial, open the Connect stream, send the signed hello and read hello_ack.
async fn establish(
    config: &LinkConfig,
    // The auto traits are part of the parameter type: a plain `&dyn DeviceKey` is not Send, and
    // this future is held across the dial await inside a spawned task.
    key: &(dyn DeviceKey + Send + Sync),
    ticket: &str,
) -> Result<Session, LinkError> {
    let origin: Uri = config
        .endpoint
        .parse()
        .map_err(|err: http::uri::InvalidUri| LinkError::Transport(err.to_string()))?;
    let endpoint = Endpoint::from_shared(config.endpoint.clone())
        .map_err(|err| LinkError::Transport(err.to_string()))?
        .connect_timeout(config.connect_timeout)
        .tcp_nodelay(true);
    // Both connectors erase into the same Channel, so the identity shape is chosen here and
    // nowhere else. CngBound is the production Windows path and never touches private bytes.
    let channel = match &config.identity {
        ClientIdentity::Pkcs12 { der, password } => {
            let connector =
                DeviceTlsConnector::new(&config.ca_pem, der, password, &config.server_name)
                    .map_err(LinkError::Tls)?;
            endpoint
                .connect_with_connector(connector)
                .await
                .map_err(|err| LinkError::Transport(err.to_string()))?
        }
        #[cfg(windows)]
        ClientIdentity::CngBound {
            cert_der_chain,
            container,
            provider,
        } => {
            let connector = super::schannel::CngTlsConnector::new(
                &config.ca_pem,
                cert_der_chain,
                container,
                provider,
                &config.server_name,
            )
            .map_err(LinkError::Tls)?;
            endpoint
                .connect_with_connector(connector)
                .await
                .map_err(|err| LinkError::Transport(err.to_string()))?
        }
        #[cfg(not(windows))]
        ClientIdentity::CngBound { .. } => {
            return Err(LinkError::Transport(
                "a CNG-bound identity requires Windows".into(),
            ));
        }
    };
    let mut grpc = Grpc::with_origin(channel.clone(), origin)
        .max_decoding_message_size(MAX_FRAME_BYTES)
        .max_encoding_message_size(MAX_FRAME_BYTES);

    let (uplink, rx) = mpsc::channel::<Bytes>(UPLINK_BUFFER);
    // The hello MUST be queued before `streaming` is awaited. grpc-go's connect handler calls
    // RecvMsg before it sends anything, so it emits no response headers until the hello arrives;
    // `streaming` resolves on those headers. Sending the hello only after it returns deadlocks
    // both sides. The channel is buffered, so this send completes without a receiver polling.
    let hello = hello_envelope(config, key, ticket)?;
    let raw = serde_json::to_vec(&hello)
        .map_err(|err| LinkError::Transport(format!("hello encode: {err}")))?;
    uplink
        .send(Bytes::from(raw))
        .await
        .map_err(|_| LinkError::Transport("uplink closed before hello".into()))?;
    // `Grpc::streaming` does NOT reserve capacity itself: tonic's generated clients call
    // `ready()` first. Skipping it panics inside tower's Buffer ("send_item called without
    // first calling poll_reserve") rather than returning an error.
    grpc.ready()
        .await
        .map_err(|err| LinkError::Transport(err.to_string()))?;
    let response = grpc
        .streaming(
            Request::new(ReceiverStream::new(rx)),
            PathAndQuery::from_static(CONNECT_PATH),
            FrameCodec,
        )
        .await
        .map_err(|status| LinkError::Transport(status.to_string()))?;
    let mut downlink = response.into_inner();

    let ack_raw = downlink
        .message()
        .await
        .map_err(|status| LinkError::Transport(status.to_string()))?
        .ok_or_else(|| LinkError::Transport("gateway closed before hello_ack".into()))?;
    let ack = parse_hello_ack(&ack_raw, &config.device_id).map_err(LinkError::Ack)?;
    Ok(Session {
        _channel: channel,
        uplink,
        downlink,
        ack,
    })
}

/// The signed hello. `session_id` stays empty (the server allocates it); `challenge_response`
/// stays empty because `activate_device_session` has no such parameter and always mints a new
/// session — §2.2's same-session resume is unreachable server-side today (registered gap).
fn hello_envelope(
    config: &LinkConfig,
    key: &dyn DeviceKey,
    ticket: &str,
) -> Result<Envelope, LinkError> {
    let mut body = HelloBody {
        client_version: crate::version().to_string(),
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: PROTOCOL_MINOR,
        required_features: REQUIRED_FEATURES.iter().map(|f| f.to_string()).collect(),
        tool_manifest_hash: config.tool_manifest_hash.clone(),
        runtime_digest: config.runtime_digest.clone(),
        profile_id: config.profile_id.clone(),
        journal_epoch: config.journal_epoch.clone(),
        last_receipt_seq: config.last_receipt_seq,
        ticket: ticket.to_string(),
        challenge_response: String::new(),
        signature: None,
    };
    body.sign(key).map_err(LinkError::Sign)?;
    let mut env = Envelope::new(HELLO_FRAME_TYPE, &config.device_id, body.to_value());
    env.boot_id = config.boot_id.clone();
    env.agent_instance_id = config.agent_instance_id.clone();
    env.recovery_generation = config.recovery_generation;
    env.sent_at = now_rfc3339()?;
    Ok(env)
}

/// An uplink envelope for an established session. The identity fields are the SAME on every
/// frame of a reconnect (§3.1: a reconnect re-sends the same identity); only session_id changes,
/// because the server allocated a new one.
fn uplink_envelope(
    config: &LinkConfig,
    session_id: &str,
    frame_type: &str,
    body: Value,
) -> Result<Envelope, LinkError> {
    let mut env = Envelope::new(frame_type, &config.device_id, body);
    env.session_id = session_id.to_string();
    env.boot_id = config.boot_id.clone();
    env.agent_instance_id = config.agent_instance_id.clone();
    env.recovery_generation = config.recovery_generation;
    env.sent_at = now_rfc3339()?;
    Ok(env)
}

/// The heartbeat body: the monotonic reading, the leases still worth extending, the watermark.
fn heartbeat_body(config: &LinkConfig, leases: &mut LeaseSet, now: Instant) -> HeartbeatBody {
    HeartbeatBody {
        monotonic_ms: monotonic_ms(),
        lease_ids: leases.live_ids(now),
        last_receipt_seq: config.last_receipt_seq,
    }
}

/// Whether a downlink belongs to this device and this session. Fail-closed: a frame addressed
/// to another session is a protocol break, not something to forward.
fn downlink_acceptable(env: &Envelope, device_id: &str, session_id: &str) -> bool {
    env.schema_version == SCHEMA_VERSION
        && env.device_id == device_id
        && env.session_id == session_id
}

/// Milliseconds since this process started, from a monotonic origin fixed once. §3.1's
/// `monotonic_ms` is a device clock reading, never a server deadline.
fn monotonic_ms() -> u64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// The current wall clock in the exact whole-second UTC form the wire grammar allows.
fn now_rfc3339() -> Result<String, LinkError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| LinkError::Clock)?
        .as_secs();
    format_utc_seconds(seconds).ok_or(LinkError::Clock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::hello::FRAME_TYPE;
    use crate::frame::sign::verify_frame;
    use crate::key::SoftwareKey;
    use serde_json::json;
    use std::time::Duration;

    fn config() -> LinkConfig {
        LinkConfig {
            endpoint: "https://localhost:8443".into(),
            server_name: "localhost".into(),
            ca_pem: Vec::new(),
            identity: ClientIdentity::Pkcs12 {
                der: Vec::new(),
                password: String::new(),
            },
            device_id: "dev-1".into(),
            boot_id: "boot-1".into(),
            agent_instance_id: "agent-1".into(),
            journal_epoch: "epoch-1".into(),
            profile_id: "profile-1".into(),
            tool_manifest_hash: "a".repeat(64),
            runtime_digest: "b".repeat(64),
            recovery_generation: 0,
            last_receipt_seq: 7,
            connect_timeout: Duration::from_secs(5),
            reconnect: super::super::Reconnect::default(),
        }
    }

    #[test]
    fn hello_is_signed_under_its_own_frame_type_and_carries_the_identity() {
        let key = SoftwareKey::random();
        let env = hello_envelope(&config(), &key, "ticket-1").unwrap();
        assert_eq!(env.frame_type, FRAME_TYPE);
        assert_eq!(env.schema_version, SCHEMA_VERSION);
        assert_eq!(env.device_id, "dev-1");
        assert_eq!(env.boot_id, "boot-1");
        assert_eq!(env.agent_instance_id, "agent-1");
        // The server allocates the session; the hello must not claim one.
        assert_eq!(env.session_id, "");
        assert!(!env.message_id.is_empty());
        assert!(crate::frame::rfc3339::parse_utc_seconds(&env.sent_at).is_some());

        let body: HelloBody = serde_json::from_value(env.body.clone()).unwrap();
        assert_eq!(body.ticket, "ticket-1");
        assert_eq!(body.last_receipt_seq, 7);
        assert_eq!(body.protocol_major, 2);
        assert_eq!(body.required_features, vec!["journal".to_string()]);
        // activate_device_session has no challenge_response parameter, so the field is carried
        // empty rather than inventing a resume the server would supersede.
        assert_eq!(body.challenge_response, "");
        let signature = body.signature.clone().unwrap();
        assert!(verify_frame(
            &key.public_jwk(),
            FRAME_TYPE,
            &env.body,
            &signature
        ));
        // The signature is domain-separated: the same bytes must not verify as another frame.
        assert!(!verify_frame(
            &key.public_jwk(),
            HEARTBEAT_FRAME_TYPE,
            &env.body,
            &signature
        ));
        // The outer transport fields are NOT signed: changing sent_at must not break verify.
        let mut tampered = env.body.clone();
        tampered["ticket"] = json!("ticket-2");
        assert!(!verify_frame(
            &key.public_jwk(),
            FRAME_TYPE,
            &tampered,
            &signature
        ));
    }

    #[test]
    fn hello_serializes_to_a_frame_the_gateway_can_parse() {
        let key = SoftwareKey::random();
        let env = hello_envelope(&config(), &key, "ticket-1").unwrap();
        let raw = serde_json::to_vec(&env).unwrap();
        let value: Value = serde_json::from_slice(&raw).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "agent_instance_id",
                "body",
                "boot_id",
                "device_id",
                "message_id",
                "recovery_generation",
                "schema_version",
                "sent_at",
                "session_id",
                "type"
            ]
        );
        // uint64 crosses as a decimal string, never a number and never "".
        assert_eq!(value["recovery_generation"], "0");
        assert!(raw.len() <= MAX_FRAME_BYTES);
    }

    #[test]
    fn uplink_envelope_stamps_the_allocated_session_and_keeps_the_identity() {
        let env = uplink_envelope(&config(), "sess-9", HEARTBEAT_FRAME_TYPE, json!({})).unwrap();
        assert_eq!(env.session_id, "sess-9");
        assert_eq!(env.device_id, "dev-1");
        assert_eq!(env.boot_id, "boot-1");
        assert_eq!(env.agent_instance_id, "agent-1");
        assert_eq!(env.frame_type, HEARTBEAT_FRAME_TYPE);
        assert!(crate::frame::rfc3339::parse_utc_seconds(&env.sent_at).is_some());
    }

    #[test]
    fn heartbeat_names_only_live_leases_and_reports_the_watermark() {
        let start = Instant::now();
        let mut leases = LeaseSet::default();
        let body = heartbeat_body(&config(), &mut leases, start);
        assert!(body.lease_ids.is_empty());
        assert_eq!(body.last_receipt_seq, 7);

        leases.track("short", start, Duration::from_secs(5), Duration::ZERO, 1);
        leases.track("long", start, Duration::from_secs(30), Duration::ZERO, 1);
        let later = start + Duration::from_secs(10);
        let body = heartbeat_body(&config(), &mut leases, later);
        assert_eq!(body.lease_ids, vec!["long".to_string()]);
        // The expired lease was pruned, so a later heartbeat does not name it either.
        assert_eq!(leases.len(), 1);
        let value = body.to_value();
        assert_eq!(value["last_receipt_seq"], "7");
        assert!(value["monotonic_ms"].is_string());
    }

    #[test]
    fn monotonic_ms_never_goes_backwards() {
        let first = monotonic_ms();
        std::thread::sleep(Duration::from_millis(2));
        assert!(monotonic_ms() >= first);
    }

    #[test]
    fn downlink_must_match_the_device_and_the_allocated_session() {
        let mut env = Envelope::new("command", "dev-1", json!({}));
        env.session_id = "sess-1".into();
        assert!(downlink_acceptable(&env, "dev-1", "sess-1"));
        assert!(!downlink_acceptable(&env, "dev-2", "sess-1"));
        // A frame from an OLD session is a protocol break after a reconnect minted a new one.
        assert!(!downlink_acceptable(&env, "dev-1", "sess-2"));
        env.schema_version = 1;
        assert!(!downlink_acceptable(&env, "dev-1", "sess-1"));
    }

    #[test]
    fn now_rfc3339_round_trips_through_the_strict_parser() {
        let text = now_rfc3339().unwrap();
        assert!(crate::frame::rfc3339::parse_utc_seconds(&text).is_some());
        assert_eq!(text.len(), 20);
        assert!(text.ends_with('Z'));
    }

    #[test]
    fn link_errors_name_the_failed_stage() {
        assert!(LinkError::Tls(TlsError::Ca).to_string().starts_with("tls:"));
        assert!(LinkError::Clock.to_string().contains("wall clock"));
        assert!(LinkError::Ack(AckError::SameKey)
            .to_string()
            .contains("SameKey"));
        assert!(LinkError::Transport("dial".into())
            .to_string()
            .contains("dial"));
        assert!(LinkError::Sign(SignError::Canonicalize)
            .to_string()
            .contains("signature"));
    }

    #[tokio::test]
    async fn a_closed_ticket_channel_stops_the_link_without_dialing() {
        let (ticket_tx, ticket_rx) = mpsc::channel(1);
        let (command_tx, command_rx) = mpsc::channel(1);
        let (event_tx, mut event_rx) = mpsc::channel(8);
        drop(ticket_tx);
        drop(command_tx);
        let link = Link::new(config(), Arc::new(SoftwareKey::random()));
        link.run(ticket_rx, command_rx, event_tx).await;
        // An empty channel announces the wait before the closed channel ends the loop.
        assert!(matches!(
            event_rx.recv().await,
            Some(LinkEvent::AwaitingTicket)
        ));
        assert!(matches!(event_rx.recv().await, Some(LinkEvent::Stopped)));
        assert!(event_rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn a_stop_command_stops_the_link_while_it_awaits_a_ticket() {
        let (_ticket_tx, ticket_rx) = mpsc::channel(1);
        let (command_tx, command_rx) = mpsc::channel(1);
        let (event_tx, mut event_rx) = mpsc::channel(8);
        command_tx.send(LinkCommand::Stop).await.unwrap();
        let link = Link::new(config(), Arc::new(SoftwareKey::random()));
        link.run(ticket_rx, command_rx, event_tx).await;
        assert!(matches!(
            event_rx.recv().await,
            Some(LinkEvent::AwaitingTicket)
        ));
        assert!(matches!(event_rx.recv().await, Some(LinkEvent::Stopped)));
    }

    #[tokio::test]
    async fn a_discontinuity_while_awaiting_a_ticket_invalidates_the_held_leases() {
        let (_ticket_tx, ticket_rx) = mpsc::channel(1);
        let (command_tx, command_rx) = mpsc::channel(4);
        let (event_tx, mut event_rx) = mpsc::channel(8);
        command_tx
            .send(LinkCommand::TrackLease {
                lease_id: "lease-1".into(),
                fence: 2,
                ttl: Duration::from_secs(30),
                round_trip: Duration::ZERO,
            })
            .await
            .unwrap();
        command_tx
            .send(LinkCommand::Discontinuity(
                super::super::Discontinuity::OsResume,
            ))
            .await
            .unwrap();
        command_tx.send(LinkCommand::Stop).await.unwrap();
        let link = Link::new(config(), Arc::new(SoftwareKey::random()));
        link.run(ticket_rx, command_rx, event_tx).await;
        assert!(matches!(
            event_rx.recv().await,
            Some(LinkEvent::AwaitingTicket)
        ));
        match event_rx.recv().await {
            Some(LinkEvent::LeasesInvalidated { ids, cause }) => {
                assert_eq!(ids, vec!["lease-1".to_string()]);
                assert_eq!(cause, LeaseLoss::OsResume);
            }
            other => panic!("expected LeasesInvalidated, got {other:?}"),
        }
        assert!(matches!(event_rx.recv().await, Some(LinkEvent::Stopped)));
    }

    #[tokio::test]
    async fn an_unreachable_gateway_reports_the_disconnect_and_the_ladder() {
        let (ticket_tx, ticket_rx) = mpsc::channel(1);
        let (command_tx, command_rx) = mpsc::channel(1);
        let (event_tx, mut event_rx) = mpsc::channel(8);
        // The empty CA material is refused before any dial, so this asserts the failure path
        // and the attempt counter without a network round trip.
        ticket_tx.send("ticket-1".into()).await.unwrap();
        let mut cfg = config();
        cfg.reconnect = super::super::Reconnect {
            base: Duration::from_millis(1),
            max: Duration::from_millis(2),
        };
        let link = Link::new(cfg, Arc::new(SoftwareKey::random()));
        let handle = tokio::spawn(link.run(ticket_rx, command_rx, event_tx));
        match event_rx.recv().await {
            Some(LinkEvent::Disconnected { reason, attempt }) => {
                assert_eq!(attempt, 1);
                assert!(reason.starts_with("tls:"), "{reason}");
            }
            other => panic!("expected Disconnected, got {other:?}"),
        }
        // Stop only AFTER the disconnect is observed: with both channels ready tokio::select!
        // picks either branch, so pre-loading Stop would race the ticket and prove nothing.
        command_tx.send(LinkCommand::Stop).await.unwrap();
        // The redial has no buffered ticket left, so it announces the wait before stopping.
        assert!(matches!(
            event_rx.recv().await,
            Some(LinkEvent::AwaitingTicket)
        ));
        assert!(matches!(event_rx.recv().await, Some(LinkEvent::Stopped)));
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn a_buffered_ticket_is_not_announced_as_a_wait() {
        let (ticket_tx, ticket_rx) = mpsc::channel(1);
        let (command_tx, command_rx) = mpsc::channel(1);
        let (event_tx, mut event_rx) = mpsc::channel(8);
        ticket_tx.send("ticket-1".into()).await.unwrap();
        let mut cfg = config();
        cfg.reconnect = super::super::Reconnect {
            base: Duration::from_millis(1),
            max: Duration::from_millis(2),
        };
        let link = Link::new(cfg, Arc::new(SoftwareKey::random()));
        let handle = tokio::spawn(link.run(ticket_rx, command_rx, event_tx));
        // The FIRST event is the dial failure, not a wait: a ticket was already queued, and
        // announcing a wait would make the GW18 pump spend a second single-use ticket.
        match event_rx.recv().await {
            Some(LinkEvent::Disconnected { attempt, .. }) => assert_eq!(attempt, 1),
            other => panic!("expected Disconnected without a prior wait, got {other:?}"),
        }
        command_tx.send(LinkCommand::Stop).await.unwrap();
        // Only the next attempt, with the channel now empty, announces the wait.
        assert!(matches!(
            event_rx.recv().await,
            Some(LinkEvent::AwaitingTicket)
        ));
        assert!(matches!(event_rx.recv().await, Some(LinkEvent::Stopped)));
        handle.await.unwrap();
    }
}
