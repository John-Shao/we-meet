//! The ticket pump between the shell pipe and the live link (device-design §2.2, §1; GW18).
//!
//! GW17 landed the two halves separately: the Broker's single-use ticket slot
//! ([`crate::ipc::ticket`]) and the A1 link ([`crate::transport::link::Link`]), with nothing
//! connecting them. This module is that connection, and it is deliberately the ONLY new state:
//! the sync core keeps its blocking shape and the link keeps its channel signature.
//!
//! Why a pump and not a queue. A device-session ticket is single-use with a 60s TTL, and
//! `work.activate_device_session` always mints a new session, so the link needs exactly one fresh
//! ticket per dial attempt. Withdrawing one when the shell happens to deliver it would burn or
//! expire tickets the link does not need yet — `ipc::ticket` already records that the Broker never
//! queues ahead of need. So the slot is withdrawn from ONLY while a link request is outstanding:
//! the link emits [`LinkEvent::AwaitingTicket`] when it is about to wait with an empty ticket
//! channel, and the pump satisfies that request either immediately (a ticket is pending) or when
//! the next delivery arrives.
//!
//! Single ownership, no lock. The pump is one async task that owns the `TicketSlot`; the Windows
//! pipe loop (`ipc::service`) is a blocking thread that hands over already-framed messages and
//! waits for the closed reply. Validation is not duplicated: the pump calls
//! [`crate::ipc::ticket::deliver_message`], the one closure-then-slot entry the design names.
//!
//! Scope (GW18, ruled): the ticket path only. Every other link event is forwarded to the core
//! VERBATIM — no downlink is verified, journaled or dispatched here. A2 consumption stays deferred
//! because the device side has no sync core yet, so a downlink router would have no caller.

use std::time::Instant;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::ipc::dispatch::{delivery_code, Reply};
use crate::ipc::ticket::{self, TicketSlot};
use crate::transport::LinkEvent;

/// One framed shell message plus the channel the pipe loop waits on for its reply.
pub struct DeliveryRequest {
    /// The decoded JSON message, not yet validated: the pump runs the whole closure.
    pub message: Value,
    /// The closed reply. Dropping it without sending is a pipe-loop error, not a silent accept.
    pub reply: oneshot::Sender<Reply>,
}

/// Why the pump stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BridgeOutcome {
    /// The link reported [`LinkEvent::Stopped`].
    LinkStopped,
    /// The link's event channel closed, or it stopped reading tickets: there is no link to serve.
    LinkGone,
    /// The core stopped reading forwarded events.
    CoreGone,
    /// The shell pipe is gone AND no ticket can satisfy the outstanding request, so the link
    /// could wait forever. The caller decides whether to stop the link; the pump does not.
    ShellGone,
}

/// What one withdrawal attempt achieved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pump {
    /// A ticket was withdrawn and handed to the link; the request is satisfied.
    Supplied,
    /// Nothing spendable is pending, or no request is outstanding. The request stays as it was.
    Waiting,
    /// The link is no longer reading tickets.
    LinkGone,
}

/// Run the pump until the link, the core or the shell ends it.
///
/// `deliveries` comes from the pipe loop, `link_events` from the link, `tickets` goes back to the
/// link, and `core_events` carries every event the pump does not consume. The pump consumes ONLY
/// [`LinkEvent::AwaitingTicket`]; forwarding it would make the core treat a normal wait as a
/// failure (the GW17 probe does exactly that).
///
/// Backpressure is intentional: if the core stops reading `core_events`, the pump blocks and the
/// pipe loop's reply waits with it. Nothing is dropped to keep the pipe moving.
pub async fn run_ticket_bridge(
    mut slot: TicketSlot,
    mut deliveries: mpsc::Receiver<DeliveryRequest>,
    mut link_events: mpsc::Receiver<LinkEvent>,
    tickets: mpsc::Sender<String>,
    core_events: mpsc::Sender<LinkEvent>,
) -> BridgeOutcome {
    let mut awaiting = false;
    let mut deliveries_open = true;
    loop {
        tokio::select! {
            request = deliveries.recv(), if deliveries_open => {
                match request {
                    Some(request) => {
                        let reply = match ticket::deliver_message(&mut slot, &request.message, Instant::now()) {
                            Ok(()) => Reply::accepted(&request.message),
                            Err(err) => Reply::refused(&request.message, delivery_code(err)),
                        };
                        // A dropped reply means the pipe client went away mid-call. The slot has
                        // already recorded the delivery, which is the honest outcome: the ticket
                        // is pending whether or not the shell stayed to hear about it.
                        let _ = request.reply.send(reply);
                        if awaiting {
                            // This arm only runs while the delivery channel is open (the select
                            // guard), so a failed withdrawal just leaves the request outstanding.
                            if withdraw(&mut slot, &tickets, &mut awaiting, Instant::now()).await
                                == Pump::LinkGone
                            {
                                return BridgeOutcome::LinkGone;
                            }
                        }
                    }
                    None => {
                        // The shell pipe is gone. Keep serving a live session — heartbeats and
                        // downlinks must not stop just because no new ticket can arrive — but stop
                        // polling a closed channel, which would otherwise spin this loop.
                        deliveries_open = false;
                        if awaiting && !slot.has_live_ticket(Instant::now()) {
                            return BridgeOutcome::ShellGone;
                        }
                    }
                }
            }
            event = link_events.recv() => {
                match event {
                    Some(LinkEvent::AwaitingTicket) => {
                        awaiting = true;
                        match withdraw(&mut slot, &tickets, &mut awaiting, Instant::now()).await {
                            Pump::LinkGone => return BridgeOutcome::LinkGone,
                            Pump::Waiting if !deliveries_open => return BridgeOutcome::ShellGone,
                            _ => {}
                        }
                    }
                    Some(LinkEvent::Stopped) => {
                        let _ = core_events.send(LinkEvent::Stopped).await;
                        return BridgeOutcome::LinkStopped;
                    }
                    Some(other) => {
                        if core_events.send(other).await.is_err() {
                            return BridgeOutcome::CoreGone;
                        }
                    }
                    None => return BridgeOutcome::LinkGone,
                }
            }
        }
    }
}

/// Withdraw one ticket for the outstanding request, if the slot has one. The `awaiting` guard is
/// what keeps a single-use ticket from being spent ahead of need: without a request this never
/// touches the slot. `now` is a parameter so the expiry path is testable without waiting out the
/// real 60s holding window.
async fn withdraw(
    slot: &mut TicketSlot,
    tickets: &mpsc::Sender<String>,
    awaiting: &mut bool,
    now: Instant,
) -> Pump {
    if !*awaiting {
        return Pump::Waiting;
    }
    match slot.take(now) {
        Ok(ticket) => {
            if tickets.send(ticket).await.is_err() {
                return Pump::LinkGone;
            }
            *awaiting = false;
            Pump::Supplied
        }
        // Empty or Expired: the link keeps waiting. An expired pending id was already retired into
        // the consumed set by `prune`, so the shell's next re-delivery of it is refused explicitly
        // with `already_consumed` rather than silently starting a fresh holding window.
        Err(_) => Pump::Waiting,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::envelope::Envelope;
    use crate::ipc::ticket::{TicketError, TICKET_TTL};
    use crate::key::{DeviceKey, SoftwareKey};
    use crate::permit::lease::LeaseMode;
    use crate::transport::{HelloAck, LeaseLoss, LeaseState};
    use serde_json::json;
    use std::time::Duration;

    const TICKET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    fn delivery(ticket: &str, row: &str) -> Value {
        json!({
            "method": ticket::METHOD,
            "request_id": "req-1",
            "ticket": ticket,
            "device_id": "dev-1",
            "session_ticket_id": row,
        })
    }

    /// A pump plus the four channel ends a caller needs. The link side stays manual so a test
    /// decides exactly when the link asks for a ticket. Ends are `Option` so a test can close one
    /// without partially moving the harness.
    struct Harness {
        deliveries: Option<mpsc::Sender<DeliveryRequest>>,
        link_events: Option<mpsc::Sender<LinkEvent>>,
        tickets: Option<mpsc::Receiver<String>>,
        core_events: Option<mpsc::Receiver<LinkEvent>>,
        handle: tokio::task::JoinHandle<BridgeOutcome>,
    }

    impl Harness {
        fn new() -> Self {
            let (delivery_tx, delivery_rx) = mpsc::channel(4);
            let (link_tx, link_rx) = mpsc::channel(8);
            let (ticket_tx, ticket_rx) = mpsc::channel(1);
            let (core_tx, core_rx) = mpsc::channel(8);
            let handle = tokio::spawn(run_ticket_bridge(
                TicketSlot::new("dev-1"),
                delivery_rx,
                link_rx,
                ticket_tx,
                core_tx,
            ));
            Self {
                deliveries: Some(delivery_tx),
                link_events: Some(link_tx),
                tickets: Some(ticket_rx),
                core_events: Some(core_rx),
                handle,
            }
        }

        /// Deliver one message and return the closed reply the pipe loop would write.
        async fn deliver(&mut self, message: Value) -> Reply {
            let (reply_tx, reply_rx) = oneshot::channel();
            self.deliveries
                .as_ref()
                .expect("shell pipe is open")
                .send(DeliveryRequest {
                    message,
                    reply: reply_tx,
                })
                .await
                .unwrap();
            reply_rx.await.unwrap()
        }

        async fn ask(&mut self) {
            self.link_events
                .as_ref()
                .expect("link is running")
                .send(LinkEvent::AwaitingTicket)
                .await
                .unwrap();
        }

        async fn send_event(&mut self, event: LinkEvent) {
            self.link_events
                .as_ref()
                .expect("link is running")
                .send(event)
                .await
                .unwrap();
        }

        /// The next ticket the link received, or None if the pump supplied nothing.
        async fn next_ticket(&mut self) -> Option<String> {
            let rx = self.tickets.as_mut().expect("link reads tickets");
            tokio::time::timeout(Duration::from_millis(200), rx.recv())
                .await
                .ok()
                .flatten()
        }

        async fn next_core_event(&mut self) -> LinkEvent {
            let rx = self.core_events.as_mut().expect("core reads events");
            tokio::time::timeout(Duration::from_millis(500), rx.recv())
                .await
                .expect("the pump forwarded nothing in time")
                .expect("core event channel closed")
        }

        fn close_shell(&mut self) {
            self.deliveries = None;
        }

        fn close_link(&mut self) {
            self.link_events = None;
        }

        fn close_tickets(&mut self) {
            self.tickets = None;
        }

        fn close_core(&mut self) {
            self.core_events = None;
        }

        async fn outcome(self) -> BridgeOutcome {
            self.handle.await.unwrap()
        }

        /// End the link side only. Closing the shell at the same instant would make the outcome a
        /// race between two true facts (LinkGone / ShellGone); the link is the one under test here.
        async fn finish(mut self) -> BridgeOutcome {
            self.link_events = None;
            self.handle.await.unwrap()
        }
    }

    #[tokio::test]
    async fn a_delivery_without_a_request_leaves_the_ticket_pending() {
        let mut h = Harness::new();
        let reply = h.deliver(delivery(TICKET, "row-1")).await;
        assert_eq!(reply.result, "accepted");
        assert_eq!(reply.code, None);
        assert_eq!(reply.request_id, "req-1");
        // Nothing was withdrawn: the link never asked, so spending it now would burn a single-use
        // ticket or let it expire in the channel.
        assert_eq!(h.next_ticket().await, None);
        // The request that comes later is satisfied from the pending slot.
        h.ask().await;
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_request_without_a_ticket_is_satisfied_by_the_next_delivery() {
        let mut h = Harness::new();
        h.ask().await;
        assert_eq!(h.next_ticket().await, None);
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        // The request is satisfied, so a second delivery stays pending instead of being pushed.
        assert_eq!(h.deliver(delivery(OTHER, "row-2")).await.result, "accepted");
        assert_eq!(h.next_ticket().await, None);
        h.ask().await;
        assert_eq!(h.next_ticket().await.as_deref(), Some(OTHER));
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn each_dial_attempt_gets_a_fresh_ticket_and_never_the_same_one_twice() {
        let mut h = Harness::new();
        for (index, ticket) in [TICKET, OTHER].iter().enumerate() {
            h.ask().await;
            let row = format!("row-{index}");
            assert_eq!(h.deliver(delivery(ticket, &row)).await.result, "accepted");
            assert_eq!(h.next_ticket().await.as_deref(), Some(*ticket));
        }
        // A third attempt with no new delivery gets nothing: both ids are consumed and the slot is
        // empty, so the pump waits rather than re-supplying a spent ticket.
        h.ask().await;
        assert_eq!(h.next_ticket().await, None);
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_refused_delivery_never_reaches_the_link() {
        let mut h = Harness::new();
        h.ask().await;
        let mut message = delivery(TICKET, "row-1");
        message["device_id"] = json!("dev-2");
        assert_eq!(h.deliver(message).await.code, Some("foreign_device"));
        assert_eq!(h.next_ticket().await, None);

        let mut message = delivery(TICKET, "row-1");
        message["url"] = json!("https://example.test");
        assert_eq!(h.deliver(message).await.code, Some("schema"));
        assert_eq!(h.next_ticket().await, None);

        assert_eq!(
            h.deliver(delivery("not-hex", "row-1")).await.code,
            Some("shape")
        );
        assert_eq!(h.next_ticket().await, None);

        // The outstanding request survived every refusal: a good delivery satisfies it.
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_spent_ticket_id_is_refused_on_re_delivery() {
        let mut h = Harness::new();
        h.ask().await;
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        // The mint returns null on replay (0040:1429), so re-handing the spent id is pointless.
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.code,
            Some("already_consumed")
        );
        h.ask().await;
        assert_eq!(h.next_ticket().await, None);
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn an_expired_pending_ticket_is_not_supplied_and_cannot_be_revived() {
        // Drive the withdrawal at an instant past the holding window: the pump must supply nothing
        // and must leave the request outstanding, and the expired id must be retired so the shell
        // cannot revive it by re-handing it.
        let start = Instant::now();
        let late = start + TICKET_TTL + Duration::from_secs(1);
        let mut slot = TicketSlot::new("dev-1");
        ticket::deliver_message(&mut slot, &delivery(TICKET, "row-1"), start).unwrap();
        let (ticket_tx, mut ticket_rx) = mpsc::channel(1);
        let mut awaiting = true;
        assert_eq!(
            withdraw(&mut slot, &ticket_tx, &mut awaiting, late).await,
            Pump::Waiting
        );
        assert!(
            awaiting,
            "an expired ticket must not clear the outstanding request"
        );
        assert!(ticket_rx.try_recv().is_err());
        assert_eq!(
            ticket::deliver_message(&mut slot, &delivery(TICKET, "row-1"), late),
            Err(TicketError::AlreadyConsumed)
        );
        // A fresh id is still spendable on the same outstanding request.
        assert_eq!(
            withdraw(&mut slot, &ticket_tx, &mut awaiting, late).await,
            Pump::Waiting
        );
        ticket::deliver_message(&mut slot, &delivery(OTHER, "row-2"), late).unwrap();
        assert_eq!(
            withdraw(&mut slot, &ticket_tx, &mut awaiting, late).await,
            Pump::Supplied
        );
        assert!(!awaiting);
        assert_eq!(ticket_rx.recv().await.as_deref(), Some(OTHER));
    }

    #[tokio::test]
    async fn withdraw_without_a_request_never_touches_the_slot() {
        let start = Instant::now();
        let mut slot = TicketSlot::new("dev-1");
        ticket::deliver_message(&mut slot, &delivery(TICKET, "row-1"), start).unwrap();
        let (ticket_tx, mut ticket_rx) = mpsc::channel(1);
        let mut awaiting = false;
        assert_eq!(
            withdraw(&mut slot, &ticket_tx, &mut awaiting, start).await,
            Pump::Waiting
        );
        assert!(ticket_rx.try_recv().is_err());
        // The ticket is still pending, not spent.
        assert!(slot.has_live_ticket(start));
        assert_eq!(slot.take(start).unwrap(), TICKET);
    }

    #[tokio::test]
    async fn every_other_link_event_is_forwarded_verbatim() {
        let mut h = Harness::new();
        let mut env = Envelope::new("command", "dev-1", json!({"command_id": "c-1"}));
        env.session_id = "sess-1".into();
        h.send_event(LinkEvent::Downlink(Box::new(env))).await;
        match h.next_core_event().await {
            LinkEvent::Downlink(got) => {
                assert_eq!(got.frame_type, "command");
                assert_eq!(got.session_id, "sess-1");
                assert_eq!(got.body["command_id"], "c-1");
            }
            other => panic!("expected a verbatim Downlink, got {other:?}"),
        }
        h.send_event(LinkEvent::LeasesInvalidated {
            ids: vec!["lease-1".into()],
            cause: LeaseLoss::SessionLost,
        })
        .await;
        match h.next_core_event().await {
            LinkEvent::LeasesInvalidated { ids, cause } => {
                assert_eq!(ids, vec!["lease-1".to_string()]);
                assert_eq!(cause, LeaseLoss::SessionLost);
            }
            other => panic!("expected LeasesInvalidated, got {other:?}"),
        }
        h.send_event(LinkEvent::Disconnected {
            reason: "stream lost".into(),
            attempt: 2,
        })
        .await;
        match h.next_core_event().await {
            LinkEvent::Disconnected { reason, attempt } => {
                assert_eq!(reason, "stream lost");
                assert_eq!(attempt, 2);
            }
            other => panic!("expected Disconnected, got {other:?}"),
        }
        // A downlink is NOT verified, journaled or dispatched here (A2 stays deferred), and no
        // ticket was withdrawn because the link never asked.
        assert_eq!(h.next_ticket().await, None);
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_session_established_event_reaches_the_core_with_both_keys() {
        let mut h = Harness::new();
        let ack = HelloAck {
            session_id: "sess-1".into(),
            server_time: "2026-11-17T05:30:52.123456+00:00".into(),
            generation: 7,
            lease_ttl: Duration::from_secs(30),
            heartbeat_interval: Duration::from_secs(10),
            resync_required: true,
            server_jwk: SoftwareKey::random().public_jwk(),
            permit_jwk: SoftwareKey::random().public_jwk(),
        };
        h.send_event(LinkEvent::SessionEstablished(Box::new(ack.clone())))
            .await;
        match h.next_core_event().await {
            LinkEvent::SessionEstablished(got) => {
                assert_eq!(got.session_id, "sess-1");
                assert_eq!(got.generation, 7);
                assert_eq!(got.server_jwk, ack.server_jwk);
                assert_eq!(got.permit_jwk, ack.permit_jwk);
                assert_ne!(got.server_jwk, got.permit_jwk);
            }
            other => panic!("expected SessionEstablished, got {other:?}"),
        }
        h.send_event(LinkEvent::LeaseRenewal(LeaseState {
            lease_id: "lease-1".into(),
            extended: true,
            fence: 2,
            mode: LeaseMode::Active,
            deadline: Instant::now(),
        }))
        .await;
        match h.next_core_event().await {
            LinkEvent::LeaseRenewal(state) => {
                assert_eq!(state.lease_id, "lease-1");
                assert!(state.extended);
                assert_eq!(state.fence, 2);
            }
            other => panic!("expected LeaseRenewal, got {other:?}"),
        }
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn awaiting_ticket_is_consumed_not_forwarded() {
        let mut h = Harness::new();
        h.ask().await;
        // The core must not see it: the GW17 probe treats AwaitingTicket as a failure, and a
        // normal wait for a shell-minted ticket is not a failure.
        let rx = h.core_events.as_mut().unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), rx.recv())
                .await
                .is_err(),
            "the pump forwarded a wait it should consume"
        );
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_stopped_link_stops_the_pump_and_reports_it() {
        let mut h = Harness::new();
        h.send_event(LinkEvent::Stopped).await;
        assert!(matches!(h.next_core_event().await, LinkEvent::Stopped));
        assert_eq!(h.outcome().await, BridgeOutcome::LinkStopped);
    }

    #[tokio::test]
    async fn a_closed_link_channel_stops_the_pump() {
        let mut h = Harness::new();
        h.close_link();
        assert_eq!(h.outcome().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_core_that_stops_reading_stops_the_pump() {
        let mut h = Harness::new();
        h.close_core();
        h.send_event(LinkEvent::Disconnected {
            reason: "x".into(),
            attempt: 1,
        })
        .await;
        assert_eq!(h.outcome().await, BridgeOutcome::CoreGone);
    }

    #[tokio::test]
    async fn a_link_that_stops_reading_tickets_stops_the_pump() {
        let mut h = Harness::new();
        h.ask().await;
        h.close_tickets();
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        assert_eq!(h.outcome().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_gone_shell_with_an_unsatisfiable_request_ends_the_pump() {
        let mut h = Harness::new();
        h.ask().await;
        h.close_shell();
        // No ticket can ever arrive, so waiting forever would hang the link's dial.
        assert_eq!(h.outcome().await, BridgeOutcome::ShellGone);
    }

    #[tokio::test]
    async fn a_gone_shell_still_serves_a_live_session() {
        let mut h = Harness::new();
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        h.close_shell();
        // A pending ticket is still spendable, and events keep flowing: losing the shell pipe must
        // not tear down a session that is already alive.
        h.ask().await;
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        h.send_event(LinkEvent::Disconnected {
            reason: "x".into(),
            attempt: 1,
        })
        .await;
        assert!(matches!(
            h.next_core_event().await,
            LinkEvent::Disconnected { .. }
        ));
        // But a later request that nothing can satisfy ends the pump instead of hanging.
        h.ask().await;
        assert_eq!(h.outcome().await, BridgeOutcome::ShellGone);
    }

    #[tokio::test]
    async fn a_closed_delivery_channel_does_not_spin_the_loop() {
        let mut h = Harness::new();
        h.close_shell();
        // With no outstanding request the pump stays alive and must still forward events promptly
        // rather than busy-looping on a closed receiver.
        for attempt in 1..=3 {
            h.send_event(LinkEvent::Disconnected {
                reason: "x".into(),
                attempt,
            })
            .await;
            match h.next_core_event().await {
                LinkEvent::Disconnected { attempt: got, .. } => assert_eq!(got, attempt),
                other => panic!("event {attempt} did not flow: {other:?}"),
            }
        }
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }
}
