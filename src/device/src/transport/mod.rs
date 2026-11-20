//! The device-side live link to the control plane (device-design §2.2, §3.1, §3.3, §6.3).
//!
//! Scope A1 — the LINK only. This module establishes the mTLS gRPC `Connect` stream, sends the
//! signed hello with a single-use ticket, parses `hello_ack` and provisions the two server
//! public keys, keeps the session alive with heartbeats, applies lease renewals to the leases
//! the sync core tracks here, and invalidates them on a clock discontinuity. Every OTHER
//! downlink frame is forwarded verbatim as an event and is NOT consumed: offer/ready/start,
//! command, cancel, resolution and the ack family stay with the later production-consumption
//! batches (A2/A3). Nothing here spawns a sidecar or kills a process — §3.3's "kill or pause
//! controllable processes first" is the Node batch's duty; this module only makes the lease
//! unusable and drops the session so the core must reconcile and re-authorize.
//!
//! The sync core is untouched: it talks to the link through two channels (commands in, events
//! out), so the journal/permit/recovery code keeps its blocking, single-threaded shape.
//!
//! TWO MEASURED SERVER FACTS shape this module:
//!  * `work.activate_device_session` (0040:1572-1668) has NO challenge_response parameter and
//!    always mints a NEW session, terminalizing the previous active one. So §2.2's "TCP
//!    reconnect may resume the same active session with a fresh challenge" is unreachable
//!    server-side today: EVERY reconnect needs a fresh single-use ticket and a fresh hello,
//!    and the device gets a new session_id. Registered as a gap (same class as J12), not
//!    papered over with a device-side resume that the server would supersede anyway.
//!  * `hello_ack.server_time` is Postgres `now()` rendered with fractional seconds and a
//!    `+00:00` offset, NOT the whole-second `...Z` form `frame::rfc3339` accepts. It is carried
//!    as an opaque diagnostic string and NEVER used for arithmetic: §3.3 makes the local
//!    deadline monotonic (send instant + server TTL − round trip), so a wall-clock rollback
//!    cannot extend a lease.

pub mod codec;
pub mod link;
pub mod tls;

#[cfg(windows)]
pub mod schannel;

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;

use crate::frame::envelope::{Envelope, SCHEMA_VERSION};
use crate::frame::lease::{LeaseBody, LEASE_FRAME_TYPE};
use crate::jwk::{self, EcP256Jwk};
use crate::permit::lease::{Lease, LeaseMode, DEFAULT_LEASE_TTL, HEARTBEAT_INTERVAL};

/// The hand-written v2 service path (`internal/gateway/service.go` serviceDesc).
pub const CONNECT_PATH: &str = "/work.device.v2.DeviceGateway/Connect";

/// The hello_ack frame type tag.
pub const HELLO_ACK_FRAME_TYPE: &str = "hello_ack";

/// The only security feature the gateway's closed set knows (`internal/gateway/frame.go`
/// knownFeatures). Advertising anything else is refused, never ignored-then-executed.
pub const REQUIRED_FEATURES: &[&str] = &["journal"];

/// The wire protocol version this device speaks (§3.1 schema_version=2).
pub const PROTOCOL_MAJOR: u32 = 2;
/// The wire protocol minor version.
pub const PROTOCOL_MINOR: u32 = 0;

/// How long the link waits before redialing after a failed attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reconnect {
    /// The first delay; doubles per consecutive failed attempt.
    pub base: Duration,
    /// The ceiling, so a long outage does not back off into hours.
    pub max: Duration,
}

impl Default for Reconnect {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(1),
            max: Duration::from_secs(30),
        }
    }
}

/// The delay before attempt `attempt` (1-based). Pure so the ladder is testable without a
/// network: `base * 2^(attempt-1)`, capped at `max`, saturating rather than overflowing.
pub fn reconnect_delay(attempt: u32, policy: Reconnect) -> Duration {
    let exponent = attempt.saturating_sub(1).min(32);
    let factor = 2u32.saturating_pow(exponent);
    policy.base.saturating_mul(factor).min(policy.max)
}

/// The client identity the link presents at mTLS. Two shapes, because the platform stacks
/// accept different material and §2.1 forbids the production key from ever being exported:
/// `CngBound` is the production Windows shape (a CA-issued certificate plus the persisted
/// key's container name, no private bytes); `Pkcs12` needs the private scalar and therefore
/// exists ONLY for the test CA and the Linux cross-language interop.
#[derive(Clone, Debug)]
pub enum ClientIdentity {
    /// A PKCS#12 archive and its password. Test/Linux only — see `tls.rs`.
    Pkcs12 { der: Vec<u8>, password: String },
    /// A CA-issued certificate chain (leaf first, DER) bound to a non-exportable CNG key.
    CngBound {
        cert_der_chain: Vec<Vec<u8>>,
        container: String,
        provider: String,
    },
}

/// Everything the link needs to dial and to introduce itself. The ticket is NOT here: it is
/// single-use with a 60s TTL (§2.2) and is supplied per attempt, because every reconnect mints
/// a new session (see the module doc).
#[derive(Clone, Debug)]
pub struct LinkConfig {
    /// `https://host:port` of the gateway listener.
    pub endpoint: String,
    /// The name verified against the gateway's server certificate.
    pub server_name: String,
    /// The device CA root, PEM.
    pub ca_pem: Vec<u8>,
    /// The client identity presented at mTLS.
    pub identity: ClientIdentity,
    /// The CA-bound device id; the envelope must carry exactly this (the gateway refuses a
    /// body that tries to override the certificate-mapped identity).
    pub device_id: String,
    /// The OS boot identity (§2.2), stable across agent restarts within one boot.
    pub boot_id: String,
    /// Random per agent start (§2.2).
    pub agent_instance_id: String,
    /// The local journal epoch the hello introduces.
    pub journal_epoch: String,
    /// The runtime profile this agent runs.
    pub profile_id: String,
    /// The tool manifest hash the hello attests.
    pub tool_manifest_hash: String,
    /// The sidecar runtime digest the hello attests.
    pub runtime_digest: String,
    /// The recovery generation to carry in the envelope (§2.3 recovery is out of phase, so
    /// this stays 0 until that card lands).
    pub recovery_generation: u64,
    /// The receipt watermark the hello reports so the server can decide resync.
    pub last_receipt_seq: u64,
    /// How long a dial may take before it is abandoned.
    pub connect_timeout: Duration,
    /// The redial ladder.
    pub reconnect: Reconnect,
}

impl LinkConfig {
    /// The heartbeat interval to use before hello_ack arrives. The server's own value
    /// supersedes it once the session is established.
    pub fn bootstrap_heartbeat(&self) -> Duration {
        HEARTBEAT_INTERVAL
    }

    /// The lease TTL to use before hello_ack arrives.
    pub fn bootstrap_lease_ttl(&self) -> Duration {
        DEFAULT_LEASE_TTL
    }
}

/// Why a hello_ack was refused. Fail-closed: a session the device cannot fully attribute is
/// never entered, because every later downlink is verified against the keys it provisions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AckError {
    /// Not a JSON envelope, or not schema_version 2, or a uint64 field off the decimal-string
    /// boundary (the server used to emit `recovery_generation:""`, which is not a uint64).
    Envelope,
    /// The first frame after hello was not hello_ack.
    FrameType,
    /// The ack addresses another device.
    Device,
    /// No session was allocated, or the envelope and body disagree about which one.
    Session,
    /// The body is not the closed activate_device_session result plus the two JWKs.
    Body,
    /// A non-positive TTL/heartbeat, or a heartbeat that cannot fit inside the lease TTL.
    Cadence,
    /// server_public_jwk is not a closed four-member EC P-256 JWK.
    ServerKey,
    /// permit_public_jwk is not a closed four-member EC P-256 JWK.
    PermitKey,
    /// The two keys are the same key. §3.3 requires an INDEPENDENT permit key, and GW14
    /// asserts on both sides that a frame key cannot verify a permit and vice versa.
    SameKey,
}

/// The parsed hello_ack: the `activate_device_session` result plus the two bootstrap keys.
#[derive(Clone, Debug)]
pub struct HelloAck {
    /// The freshly allocated session. Every uplink envelope carries it.
    pub session_id: String,
    /// The server's wall clock, OPAQUE (see the module doc: fractional seconds + offset).
    pub server_time: String,
    /// The org's access_epoch at activation. A JSON number, not a decimal string: it comes
    /// straight from `jsonb_build_object('generation', COALESCE(v_generation, 0))` (0040:1666).
    pub generation: u64,
    /// The server-granted lease TTL.
    pub lease_ttl: Duration,
    /// The server-granted heartbeat cadence.
    pub heartbeat_interval: Duration,
    /// Whether the server wants a reconcile before new work. Always true on a fresh session.
    pub resync_required: bool,
    /// The frame key: verifies receipt_ack/reconcile_ack/resolution/offer/start/finish_ack/command.
    pub server_jwk: EcP256Jwk,
    /// The INDEPENDENT permit key: verifies the nested permit document of a command.
    pub permit_jwk: EcP256Jwk,
}

/// The closed body shape, deserialized strictly so a missing or mistyped member is refused
/// rather than defaulted.
#[derive(Deserialize)]
struct AckBody {
    session_id: String,
    server_time: String,
    generation: u64,
    lease_ttl_ms: u64,
    heartbeat_ms: u64,
    resync_required: bool,
    server_public_jwk: Value,
    permit_public_jwk: Value,
}

/// Parse and validate a hello_ack addressed to `device_id`.
pub fn parse_hello_ack(raw: &[u8], device_id: &str) -> Result<HelloAck, AckError> {
    let env: Envelope = serde_json::from_slice(raw).map_err(|_| AckError::Envelope)?;
    if env.schema_version != SCHEMA_VERSION {
        return Err(AckError::Envelope);
    }
    if env.frame_type != HELLO_ACK_FRAME_TYPE {
        return Err(AckError::FrameType);
    }
    if env.device_id != device_id {
        return Err(AckError::Device);
    }
    if env.session_id.is_empty() {
        return Err(AckError::Session);
    }
    let body: AckBody = serde_json::from_value(env.body).map_err(|_| AckError::Body)?;
    if body.session_id != env.session_id {
        return Err(AckError::Session);
    }
    if body.lease_ttl_ms == 0 || body.heartbeat_ms == 0 || body.heartbeat_ms >= body.lease_ttl_ms {
        return Err(AckError::Cadence);
    }
    let server_jwk =
        jwk::validate_json(&body.server_public_jwk.to_string()).map_err(|_| AckError::ServerKey)?;
    let permit_jwk =
        jwk::validate_json(&body.permit_public_jwk.to_string()).map_err(|_| AckError::PermitKey)?;
    if server_jwk == permit_jwk {
        return Err(AckError::SameKey);
    }
    Ok(HelloAck {
        session_id: env.session_id,
        server_time: body.server_time,
        generation: body.generation,
        lease_ttl: Duration::from_millis(body.lease_ttl_ms),
        heartbeat_interval: Duration::from_millis(body.heartbeat_ms),
        resync_required: body.resync_required,
        server_jwk,
        permit_jwk,
    })
}

/// What broke the monotonic clock's agreement with the wall clock (§3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Discontinuity {
    /// The OS suspended and resumed the agent.
    OsResume,
    /// The wall clock jumped relative to the monotonic clock (NTP step, manual change, or a
    /// suspend the monotonic clock did not count).
    ClockJump,
}

/// Why every held lease became unusable. Besides expiry and clock discontinuities, a lost
/// session invalidates leases: `execution_lease.session_id` is immutable and `renew_device_lease` binds the
/// renewal to the lease's ORIGINAL device AND session (0051), so a reconnect's new hello session
/// can never renew the old lease — it must reconcile and re-acquire (§6.3, GW10 boundary).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseLoss {
    /// The OS resumed the agent.
    OsResume,
    /// The wall clock jumped.
    ClockJump,
    /// The session that owned the leases ended.
    SessionLost,
    /// A held lease reached its monotonic deadline; the owning session must end.
    Expired,
}

impl From<Discontinuity> for LeaseLoss {
    fn from(cause: Discontinuity) -> Self {
        match cause {
            Discontinuity::OsResume => Self::OsResume,
            Discontinuity::ClockJump => Self::ClockJump,
        }
    }
}

/// How far the wall clock may drift from the monotonic clock across one heartbeat interval
/// before the link treats it as a discontinuity. Normal scheduler jitter and NTP slewing stay
/// well inside this; a step or a suspend does not.
pub const CLOCK_JUMP_TOLERANCE: Duration = Duration::from_secs(5);

/// Whether the wall/monotonic pair observed across one interval proves a discontinuity.
/// `wall` is None when the wall clock went BACKWARDS, which is itself a discontinuity.
pub fn clock_discontinuity(monotonic: Duration, wall: Option<Duration>) -> bool {
    match wall {
        None => true,
        Some(wall) => wall.abs_diff(monotonic) > CLOCK_JUMP_TOLERANCE,
    }
}

/// The leases the sync core has asked the link to keep alive. The link owns them because the
/// renewal deadline is measured from the heartbeat's SEND instant, which only the link knows.
/// Every judgment (fence match, Active-only, TTL minus round trip) stays in the sync
/// `permit::lease::Lease` state machine — this is a keyed holder, not a second state machine.
#[derive(Default)]
pub struct LeaseSet {
    leases: BTreeMap<String, Lease>,
}

impl LeaseSet {
    /// Start keeping a lease alive. Called by the core once a run_start has been verified and
    /// the lease acquired; `sent_at` is the instant the acquiring exchange was sent.
    pub fn track(
        &mut self,
        lease_id: &str,
        sent_at: Instant,
        server_ttl: Duration,
        round_trip: Duration,
        fence: u64,
    ) {
        // Re-delivering TrackLease is not a new acquisition and cannot erase an unreported
        // expiry or reset its deadline. Re-authorization acquires a different lease id.
        self.leases
            .entry(lease_id.to_string())
            .or_insert_with(|| Lease::acquire(sent_at, server_ttl, round_trip, fence));
    }

    /// Stop keeping a lease alive (the Run finished or was canceled). Without this a released
    /// lease would still be named in the heartbeat, and the gateway renews all-or-nothing in
    /// one transaction (GW10), so one dead lease would refuse the whole frame.
    pub fn release(&mut self, lease_id: &str) -> bool {
        self.leases.remove(lease_id).is_some()
    }

    /// Apply a `lease` downlink. Returns the lease's state after the attempt, or None when the
    /// link does not hold that lease — a renewal for an unheld lease is not an acquisition
    /// (§3.1: a lease is acquired through run_ready/run_start, never inferred from a renewal).
    pub fn apply_renewal(
        &mut self,
        sent_at: Instant,
        round_trip: Duration,
        body: &LeaseBody,
    ) -> Option<LeaseState> {
        let lease = self.leases.get_mut(&body.lease_id)?;
        let extended = lease.apply_renewal(sent_at, round_trip, body);
        Some(LeaseState {
            lease_id: body.lease_id.clone(),
            extended,
            fence: lease.fence(),
            mode: lease.mode(),
            deadline: lease.deadline(),
        })
    }

    /// Invalidate every held lease (§3.3 sleep/clock discontinuity/OS resume, or the session
    /// that owned them ending). Returns the ids so the core knows exactly which Runs must
    /// reconcile and re-authorize, then drops them: an invalidated lease can never be revived
    /// (`Lease::apply_renewal` refuses a non-Active mode), so holding it would only name a dead
    /// lease in the next heartbeat. The caller kills or pauses the controllable processes; this
    /// module does not.
    pub fn invalidate_all(&mut self) -> Vec<String> {
        let ids: Vec<String> = self.leases.keys().cloned().collect();
        for lease in self.leases.values_mut() {
            lease.invalidate();
        }
        self.leases.clear();
        ids
    }

    /// The ids to name in the next heartbeat: only leases still usable at `now`.
    /// Filtering must NOT forget expired ids: they still need an invalidation event, even if
    /// a heartbeat races the expiry timer. Only release or reported invalidation removes them.
    pub fn live_ids(&self, now: Instant) -> Vec<String> {
        self.leases
            .iter()
            .filter(|(_, lease)| lease.is_valid(now))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// The nearest held deadline, including an already expired lease awaiting reporting.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.leases.values().map(Lease::deadline).min()
    }

    /// How many leases are held, live or not.
    pub fn len(&self) -> usize {
        self.leases.len()
    }

    /// Whether nothing is held.
    pub fn is_empty(&self) -> bool {
        self.leases.is_empty()
    }
}

/// A lease's state after a renewal attempt, reported to the sync core.
#[derive(Clone, Debug)]
pub struct LeaseState {
    /// Which lease.
    pub lease_id: String,
    /// Whether the deadline actually moved (fence mismatch or a non-Active mode refuses).
    pub extended: bool,
    /// The fence the lease is bound to (read, never incremented device-side).
    pub fence: u64,
    /// Active / HistoryReturn / Invalid.
    pub mode: LeaseMode,
    /// The monotonic deadline.
    pub deadline: Instant,
}

/// What the link tells the sync core. Downlink frames arrive VERBATIM and unconsumed (A1).
#[derive(Clone, Debug)]
pub enum LinkEvent {
    /// The session is established and both server keys are provisioned.
    SessionEstablished(Box<HelloAck>),
    /// A downlink frame the link does not consume. `lease` is the one exception: it is applied
    /// to the held lease set and reported as [`LinkEvent::LeaseRenewal`] instead.
    Downlink(Box<Envelope>),
    /// A lease renewal was applied (or refused) for a held lease.
    LeaseRenewal(LeaseState),
    /// Every held lease was invalidated; the session is being dropped.
    LeasesInvalidated {
        /// Which leases.
        ids: Vec<String>,
        /// What made them unusable.
        cause: LeaseLoss,
    },
    /// The stream ended or failed. `attempt` counts consecutive failures, so the core can see
    /// the ladder; a successful hello resets it.
    Disconnected {
        /// The transport or protocol reason, for the journal/diagnostics.
        reason: String,
        /// The consecutive-failure count this disconnect belongs to.
        attempt: u32,
    },
    /// This dial attempt needs a ticket and none is buffered. Emitted once per attempt, before the
    /// link waits, and ONLY when the ticket channel is empty — the GW18 pump
    /// ([`crate::broker`]) withdraws one single-use ticket from the slot on this signal, so a
    /// spurious emission would spend a ticket the link does not need. §2.2 tickets are minted by
    /// the desktop shell from its native Bearer session and delivered over the ACL-protected pipe.
    AwaitingTicket,
    /// The link was asked to stop and has stopped.
    Stopped,
}

/// What the sync core tells the link.
#[derive(Clone, Debug)]
pub enum LinkCommand {
    /// Keep this lease alive (after a verified run_start).
    TrackLease {
        /// The lease id from run_start.
        lease_id: String,
        /// The fence from run_start.
        fence: u64,
        /// The acquiring exchange's original send instant, not the command's dequeue time.
        sent_at: Instant,
        /// The server-granted TTL.
        ttl: Duration,
        /// The measured round trip of the exchange that acquired it.
        round_trip: Duration,
    },
    /// Stop keeping this lease alive.
    ReleaseLease {
        /// The lease id to drop.
        lease_id: String,
    },
    /// The OS or the clock proved a discontinuity: invalidate every lease and drop the session.
    Discontinuity(Discontinuity),
    /// Replace the client identity the NEXT dial presents. GW21: a renewed certificate must take
    /// effect without rebuilding the link, because the pump's channel ends are fixed for its
    /// lifetime. The current session is not dropped — the old certificate stays valid until its
    /// own NotAfter, and §2.1 renewals happen inside that last hour.
    ReplaceIdentity(ClientIdentity),
    /// Advance the receipt watermark the heartbeat reports. The sync core owns the journal watermark
    /// (it advances on a verified receipt_ack/reconcile_ack); the link's heartbeat must carry the LIVE
    /// value, never the static hello baseline, or renew_device_lease refuses the regression (0051).
    ReceiptWatermark(u64),
    /// Stop the link.
    Stop,
}

/// An uplink frame the sync core produced and already signed under its own frame type. The link
/// stamps the transport identity (device/boot/agent/session/sent_at) and sends it on the current
/// session; it does NOT sign the body — the core signs receipts and verdicts with the SAME device
/// key the mTLS certificate binds (§2.1, §3.1). Keeping the signature in the core means a frame's
/// signed bytes are fixed before the link sees them, so a reconnect re-sends identical bytes under
/// a new session_id rather than re-signing (§3.4 step 3: re-send the same finish_id and bytes).
#[derive(Clone, Debug)]
pub struct UplinkFrame {
    /// The frame domain the body was signed under (e.g. "cancel_ack", "run_ready", "run_started").
    pub frame_type: String,
    /// The signed frame body. The link carries it verbatim into the envelope.
    pub body: Value,
}

/// Whether a downlink frame is the one the link consumes itself.
pub fn is_lease_frame(env: &Envelope) -> bool {
    env.frame_type == LEASE_FRAME_TYPE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::{DeviceKey, SoftwareKey};
    use serde_json::json;

    fn ack_json(server: &EcP256Jwk, permit: &EcP256Jwk) -> Value {
        json!({
            "schema_version": 2,
            "type": "hello_ack",
            "message_id": "11111111-1111-4111-8111-111111111111",
            "device_id": "dev-1",
            "session_id": "sess-1",
            "agent_instance_id": "",
            "boot_id": "",
            "recovery_generation": "0",
            "sent_at": "",
            "body": {
                "session_id": "sess-1",
                "server_time": "2026-11-17T05:30:52.123456+00:00",
                "generation": 7,
                "lease_ttl_ms": 30000,
                "heartbeat_ms": 10000,
                "resync_required": true,
                "server_public_jwk": server,
                "permit_public_jwk": permit,
            }
        })
    }

    fn keys() -> (EcP256Jwk, EcP256Jwk) {
        (
            SoftwareKey::random().public_jwk(),
            SoftwareKey::random().public_jwk(),
        )
    }

    fn parse(value: Value) -> Result<HelloAck, AckError> {
        parse_hello_ack(value.to_string().as_bytes(), "dev-1")
    }

    #[test]
    fn parses_the_landed_server_shape() {
        let (server, permit) = keys();
        let ack = parse(ack_json(&server, &permit)).unwrap();
        assert_eq!(ack.session_id, "sess-1");
        assert_eq!(ack.generation, 7);
        assert_eq!(ack.lease_ttl, Duration::from_secs(30));
        assert_eq!(ack.heartbeat_interval, Duration::from_secs(10));
        assert!(ack.resync_required);
        assert_eq!(ack.server_jwk, server);
        assert_eq!(ack.permit_jwk, permit);
        // server_time is Postgres now(), NOT the whole-second form frame::rfc3339 accepts. It
        // is carried opaquely and never parsed, so the strict parser must not be applied to it.
        assert!(crate::frame::rfc3339::parse_utc_seconds(&ack.server_time).is_none());
        assert_eq!(ack.server_time, "2026-11-17T05:30:52.123456+00:00");
    }

    #[test]
    fn refuses_the_empty_recovery_generation_the_server_used_to_emit() {
        let (server, permit) = keys();
        let mut value = ack_json(&server, &permit);
        value["recovery_generation"] = json!("");
        assert_eq!(parse(value).unwrap_err(), AckError::Envelope);
        // A float is off the uint64 boundary too.
        let mut value = ack_json(&server, &permit);
        value["recovery_generation"] = json!(0.0);
        assert_eq!(parse(value).unwrap_err(), AckError::Envelope);
    }

    #[test]
    fn refuses_a_wrong_type_device_or_session() {
        let (server, permit) = keys();
        let mut value = ack_json(&server, &permit);
        value["type"] = json!("receipt_ack");
        assert_eq!(parse(value).unwrap_err(), AckError::FrameType);

        let mut value = ack_json(&server, &permit);
        value["device_id"] = json!("dev-2");
        assert_eq!(parse(value).unwrap_err(), AckError::Device);

        let mut value = ack_json(&server, &permit);
        value["session_id"] = json!("");
        assert_eq!(parse(value).unwrap_err(), AckError::Session);

        // The envelope and the body must name the SAME session: a body that disagrees would
        // let the device stamp uplinks with a session the server did not allocate.
        let mut value = ack_json(&server, &permit);
        value["body"]["session_id"] = json!("sess-2");
        assert_eq!(parse(value).unwrap_err(), AckError::Session);

        let mut value = ack_json(&server, &permit);
        value["schema_version"] = json!(1);
        assert_eq!(parse(value).unwrap_err(), AckError::Envelope);
    }

    #[test]
    fn refuses_a_body_missing_a_closed_member() {
        let (server, permit) = keys();
        for key in [
            "session_id",
            "server_time",
            "generation",
            "lease_ttl_ms",
            "heartbeat_ms",
            "resync_required",
            "server_public_jwk",
            "permit_public_jwk",
        ] {
            let mut value = ack_json(&server, &permit);
            value["body"].as_object_mut().unwrap().remove(key);
            assert_eq!(
                parse(value).unwrap_err(),
                AckError::Body,
                "accepted a body without {key}"
            );
        }
        // generation is a JSON number from jsonb_build_object; a decimal string is not the
        // landed shape and must not be silently coerced.
        let mut value = ack_json(&server, &permit);
        value["body"]["generation"] = json!("7");
        assert_eq!(parse(value).unwrap_err(), AckError::Body);
    }

    #[test]
    fn refuses_a_cadence_that_cannot_keep_a_lease_alive() {
        let (server, permit) = keys();
        for (ttl, heartbeat) in [(0u64, 10000u64), (30000, 0), (30000, 30000), (10000, 30000)] {
            let mut value = ack_json(&server, &permit);
            value["body"]["lease_ttl_ms"] = json!(ttl);
            value["body"]["heartbeat_ms"] = json!(heartbeat);
            assert_eq!(
                parse(value).unwrap_err(),
                AckError::Cadence,
                "accepted {ttl}/{heartbeat}"
            );
        }
    }

    #[test]
    fn refuses_bad_or_shared_server_keys() {
        let (server, permit) = keys();
        let mut value = ack_json(&server, &permit);
        value["body"]["server_public_jwk"] =
            json!({"kty": "EC", "crv": "P-256", "x": "short", "y": permit.y});
        assert_eq!(parse(value).unwrap_err(), AckError::ServerKey);

        let mut value = ack_json(&server, &permit);
        value["body"]["permit_public_jwk"] = json!({"kty": "RSA", "n": "x", "e": "AQAB"});
        assert_eq!(parse(value).unwrap_err(), AckError::PermitKey);

        // §3.3's independent permit key: one key serving both roles is a protocol break, and
        // GW14 asserts on both sides that the two are not interchangeable.
        let mut value = ack_json(&server, &permit);
        value["body"]["permit_public_jwk"] = json!(server);
        assert_eq!(parse(value).unwrap_err(), AckError::SameKey);
    }

    #[test]
    fn reconnect_ladder_doubles_and_caps() {
        let policy = Reconnect::default();
        let delays: Vec<u64> = (1..=8)
            .map(|a| reconnect_delay(a, policy).as_millis() as u64)
            .collect();
        assert_eq!(
            delays,
            vec![1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]
        );
        // A huge attempt count saturates instead of overflowing the shift.
        assert_eq!(reconnect_delay(u32::MAX, policy), policy.max);
        assert_eq!(reconnect_delay(0, policy), policy.base);
        let tight = Reconnect {
            base: Duration::from_millis(50),
            max: Duration::from_millis(200),
        };
        assert_eq!(reconnect_delay(3, tight), Duration::from_millis(200));
    }

    #[test]
    fn clock_discontinuity_catches_a_step_a_rollback_and_a_suspend() {
        let interval = Duration::from_secs(10);
        // Normal jitter: the wall and monotonic clocks agree within tolerance.
        assert!(!clock_discontinuity(interval, Some(interval)));
        assert!(!clock_discontinuity(
            interval,
            Some(interval + Duration::from_secs(2))
        ));
        assert!(!clock_discontinuity(
            interval,
            Some(interval - Duration::from_secs(2))
        ));
        // A forward step (NTP, manual change) or a suspend the monotonic clock did not count.
        assert!(clock_discontinuity(
            interval,
            Some(interval + CLOCK_JUMP_TOLERANCE + Duration::from_secs(1))
        ));
        // A backward step: the wall clock went backwards, so there is no positive delta.
        assert!(clock_discontinuity(interval, None));
        // Exactly at tolerance is still agreement, not a discontinuity.
        assert!(!clock_discontinuity(
            interval,
            Some(interval + CLOCK_JUMP_TOLERANCE)
        ));
    }

    fn renewal(lease_id: &str, fence: u64, ttl_ms: u64) -> LeaseBody {
        LeaseBody {
            lease_id: lease_id.into(),
            run_id: "run-1".into(),
            fence,
            expires_at: "2026-11-17T00:00:30Z".into(),
            ttl_ms,
        }
    }

    #[test]
    fn lease_set_renews_only_a_held_lease_with_a_matching_fence() {
        let start = Instant::now();
        let mut set = LeaseSet::default();
        assert!(set.is_empty());
        set.track("lease-1", start, Duration::from_secs(30), Duration::ZERO, 2);
        assert_eq!(set.len(), 1);

        let sent = start + Duration::from_secs(10);
        let state = set
            .apply_renewal(sent, Duration::from_secs(1), &renewal("lease-1", 2, 30_000))
            .unwrap();
        assert!(state.extended);
        assert_eq!(state.mode, LeaseMode::Active);
        assert_eq!(state.deadline, sent + Duration::from_secs(29));

        // A renewal for a lease the link does not hold is NOT an acquisition.
        assert!(set
            .apply_renewal(sent, Duration::ZERO, &renewal("lease-2", 2, 30_000))
            .is_none());
        assert_eq!(set.len(), 1);

        // A different fence is not this lease's renewal: reported, but nothing moves.
        let state = set
            .apply_renewal(sent, Duration::ZERO, &renewal("lease-1", 3, 30_000))
            .unwrap();
        assert!(!state.extended);
        assert_eq!(state.deadline, sent + Duration::from_secs(29));
    }

    #[test]
    fn lease_set_invalidate_all_names_every_lease_and_drops_them() {
        let start = Instant::now();
        let mut set = LeaseSet::default();
        set.track("lease-1", start, Duration::from_secs(30), Duration::ZERO, 2);
        set.track("lease-2", start, Duration::from_secs(30), Duration::ZERO, 5);
        let ids = set.invalidate_all();
        assert_eq!(ids, vec!["lease-1".to_string(), "lease-2".to_string()]);
        // The leases are gone, so a late renewal for one is not applied and cannot revive it.
        assert!(set
            .apply_renewal(start, Duration::ZERO, &renewal("lease-1", 2, 30_000))
            .is_none());
        assert!(set.live_ids(start).is_empty());
        assert!(set.is_empty());
        // Idempotent: a second invalidation reports nothing new.
        assert!(set.invalidate_all().is_empty());
    }

    #[test]
    fn live_ids_preserve_expired_ids_until_reported_and_release_drops_finished_ones() {
        let start = Instant::now();
        let mut set = LeaseSet::default();
        set.track("short", start, Duration::from_secs(5), Duration::ZERO, 1);
        set.track("long", start, Duration::from_secs(30), Duration::ZERO, 1);
        let later = start + Duration::from_secs(10);
        assert_eq!(set.live_ids(later), vec!["long".to_string()]);
        assert_eq!(set.len(), 2);
        // Even a duplicate tracking command must not erase the expired, unreported lease.
        set.track("short", later, Duration::from_secs(30), Duration::ZERO, 1);
        assert_eq!(set.next_deadline(), Some(start + Duration::from_secs(5)));
        assert!(set.release("long"));
        assert!(!set.release("long"));
        assert_eq!(set.invalidate_all(), vec!["short".to_string()]);
        assert!(set.next_deadline().is_none());
        assert!(set.is_empty());
    }

    #[test]
    fn a_late_renewal_does_not_hide_an_expired_id() {
        let start = Instant::now();
        let mut set = LeaseSet::default();
        set.track("short", start, Duration::from_secs(5), Duration::ZERO, 1);
        let state = set
            .apply_renewal(start, Duration::from_secs(5), &renewal("short", 1, 30_000))
            .unwrap();
        assert!(!state.extended);
        assert_eq!(state.mode, LeaseMode::Invalid);
        assert!(set.live_ids(start + Duration::from_secs(5)).is_empty());
        assert_eq!(set.invalidate_all(), vec!["short".to_string()]);
    }

    #[test]
    fn lease_loss_covers_the_clock_causes_and_the_lost_session() {
        assert_eq!(
            LeaseLoss::from(Discontinuity::OsResume),
            LeaseLoss::OsResume
        );
        assert_eq!(
            LeaseLoss::from(Discontinuity::ClockJump),
            LeaseLoss::ClockJump
        );
        // A lost session is its own cause: 0051 binds a renewal to the lease's original
        // session, so a reconnect can never extend the old lease.
        assert_ne!(LeaseLoss::SessionLost, LeaseLoss::OsResume);
        assert_ne!(LeaseLoss::SessionLost, LeaseLoss::ClockJump);
    }

    #[test]
    fn lease_frame_is_the_only_downlink_the_link_consumes() {
        let mut env = Envelope::new("lease", "dev-1", json!({}));
        assert!(is_lease_frame(&env));
        for other in [
            "run_offer",
            "run_start",
            "command",
            "cancel",
            "operation_resolution",
            "receipt_ack",
            "reconcile_ack",
            "checkpoint_ack",
            "run_finish_ack",
            "action_prepared",
        ] {
            env.frame_type = other.into();
            assert!(
                !is_lease_frame(&env),
                "{other} must be forwarded, not consumed"
            );
        }
    }
}
