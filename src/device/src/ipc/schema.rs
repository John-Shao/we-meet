//! Closed IPC method sets (device-design §1 :20 and §1.1 :33). The shell→Broker
//! and viewer message sets are closed; every schema is closed with no arbitrary
//! `command`/`path`/`url` field. Unknown methods and forbidden top-level fields
//! are refused with an explicit error, never silently downgraded. Per-method
//! payload schemas land with their feature batches; this batch validates the
//! method-name closure and the forbidden-field rule.

use serde_json::Value;

/// The shell→Broker IPC method closure (device-design §1 :20, 13 members).
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
    fn shell_closure_has_thirteen_members() {
        assert_eq!(SHELL_METHODS.len(), 13);
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
