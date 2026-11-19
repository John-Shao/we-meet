//! Closed IPC method sets (device-design §1 :20 and §1.1 :33). The shell→Broker
//! and viewer message sets are closed; every schema is closed with no arbitrary
//! `command`/`path`/`url` field. Unknown methods and forbidden top-level fields
//! are refused with an explicit error, never silently downgraded. Per-method
//! payload schemas land with their feature batches; this batch validates the
//! method-name closure and the forbidden-field rule.

use serde_json::Value;

/// The shell→Broker IPC method closure (device-design §1 :20, 20 members).
/// `deliverDeviceSessionTicket` was added in GW17: §2.2 requires a single-use device-session
/// ticket minted from the main process's native Bearer session, and the closed set had no member
/// that could carry it to the Broker — the same "required but no carrier" gap GW12/GW15 found on
/// the wire side. The design line is annotated in place; the original wording is preserved.
///
/// GW21 adds five more for §2.1's Broker side, which had no carrier at all: the main process must
/// obtain the public JWK/thumbprint (step 1), ask for a signature over the pairing covered string
/// (step 3) and over the renewal covered string (step 4), hand back the CA-issued chain, and learn
/// when the renewal window opens. The two signing methods are separate on purpose: §2.1 forbids
/// reusing a signature domain across purposes, so the Broker builds each preimage itself from
/// closed fields and the shell can never make it sign arbitrary bytes.
///
/// M2b adds `redeliverDeviceCertificate`: §2.1's restart path re-delivers the stored chain to a
/// FRESH Broker process, which has no signing history, so `deliverDeviceCertificate`'s signed-org
/// gate refused it (`no_pairing`) and the shell lost its record. The re-delivery carrier declares
/// the org explicitly; the CA-signed OU must equal it. F5 甲 (2026-11-19) adds the subject to the
/// same carrier: the certificate carries no subject field (CN=device, OU=org only), so the permit
/// identity gate's `subject_id` anchor must be re-supplied on restart. The design line is annotated
/// in place.
pub const SHELL_METHODS: &[&str] = &[
    "chooseWorkspace",
    "inspectWorkspace",
    "revokeWorkspace",
    "rebindRunWorkspace",
    "stageLocalInput",
    "confirmLocalSubmission",
    "openLocalContent",
    "exportArtifactVersion",
    "resendUndeliveredModelRequest",
    "configureLocalModel",
    "probeLocalModel",
    "rotateLocalModelCredential",
    "revokeLocalModelBinding",
    "deliverDeviceSessionTicket",
    "getDeviceIdentity",
    "signDevicePairing",
    "signDeviceCertificateRenewal",
    "deliverDeviceCertificate",
    "redeliverDeviceCertificate",
    "getDeviceCertificateStatus",
];

/// The viewer→main-process message closure (device-design §1.1 :33, 6 members).
pub const VIEWER_METHODS: &[&str] = &[
    "decideLocalApproval",
    "prepareUserArtifactVersion",
    "confirmLocalWrite",
    "confirmDisclosureDecision",
    "signObjectProof",
    "close",
];

/// Top-level fields no IPC message may carry (no arbitrary command/path/url).
const FORBIDDEN_FIELDS: &[&str] = &["command", "path", "url"];

/// Which closed message set a channel uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Shell,
    Viewer,
}

/// A schema-validation failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaError {
    MissingMethod,
    UnknownMethod,
    ForbiddenField,
}

impl Channel {
    fn methods(self) -> &'static [&'static str] {
        match self {
            Channel::Shell => SHELL_METHODS,
            Channel::Viewer => VIEWER_METHODS,
        }
    }
}

/// Validate that `method` belongs to the channel's closed set.
pub fn validate_method(channel: Channel, method: &str) -> Result<(), SchemaError> {
    if channel.methods().contains(&method) {
        Ok(())
    } else {
        Err(SchemaError::UnknownMethod)
    }
}

/// Validate a whole IPC message: a known `method` for the channel and no
/// forbidden top-level field.
pub fn validate_message(channel: Channel, message: &Value) -> Result<(), SchemaError> {
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .ok_or(SchemaError::MissingMethod)?;
    validate_method(channel, method)?;
    for field in FORBIDDEN_FIELDS {
        if message.get(*field).is_some() {
            return Err(SchemaError::ForbiddenField);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shell_closure_has_twenty_members() {
        assert_eq!(SHELL_METHODS.len(), 20);
    }

    #[test]
    fn viewer_closure_has_six_members() {
        assert_eq!(VIEWER_METHODS.len(), 6);
    }

    #[test]
    fn shell_methods_accepted() {
        for method in SHELL_METHODS {
            assert_eq!(validate_method(Channel::Shell, method), Ok(()));
        }
    }

    #[test]
    fn viewer_methods_accepted() {
        for method in VIEWER_METHODS {
            assert_eq!(validate_method(Channel::Viewer, method), Ok(()));
        }
    }

    #[test]
    fn unknown_method_rejected() {
        assert_eq!(
            validate_method(Channel::Shell, "executeArbitrary"),
            Err(SchemaError::UnknownMethod)
        );
    }

    #[test]
    fn cross_channel_method_rejected() {
        // A viewer method is not valid on the shell channel and vice versa.
        assert_eq!(
            validate_method(Channel::Shell, "signObjectProof"),
            Err(SchemaError::UnknownMethod)
        );
        assert_eq!(
            validate_method(Channel::Viewer, "chooseWorkspace"),
            Err(SchemaError::UnknownMethod)
        );
    }

    #[test]
    fn message_with_known_method_passes() {
        let msg = json!({"method": "chooseWorkspace", "request_id": "r1"});
        assert_eq!(validate_message(Channel::Shell, &msg), Ok(()));
    }

    #[test]
    fn missing_method_rejected() {
        assert_eq!(
            validate_message(Channel::Shell, &json!({"request_id": "r1"})),
            Err(SchemaError::MissingMethod)
        );
    }

    #[test]
    fn forbidden_fields_rejected() {
        for field in ["command", "path", "url"] {
            let msg = json!({"method": "chooseWorkspace", field: "anything"});
            assert_eq!(
                validate_message(Channel::Shell, &msg),
                Err(SchemaError::ForbiddenField)
            );
        }
    }
}
