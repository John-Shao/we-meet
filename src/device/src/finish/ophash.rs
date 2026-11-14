//! `final_operation_set_hash` (device-design §3.4 O-16=甲; source SQL 0042
//! `work.local_operation_set_hash`). All Operations of the Run (including
//! superseded ones), sorted by `operation_id` text ascending; each element is the
//! raw concatenation `{"operation_id":"…","state":"…","result_hash":"…"}` in that
//! key order with no whitespace and NO JSON escaping (the SQL builds it by string
//! concatenation, not jsonb); `result_hash` is the latest completed receipt value
//! (empty string if none); the whole is `sha256('[' || join(elements, ',') || ']')`.
//! An empty set hashes `[]`. This must NOT use JCS or PG jsonb key order.

use crate::sha256_hex;

/// One Operation's contribution to the set hash. `result_hash` is the latest
/// completed receipt's result hash, or empty when there is none.
#[derive(Clone, Debug)]
pub struct OperationSummary {
    pub operation_id: String,
    pub state: String,
    pub result_hash: String,
}

/// Compute the run's final operation-set hash, matching SQL 0042 byte for byte.
pub fn final_operation_set_hash(operations: &[OperationSummary]) -> String {
    let mut sorted: Vec<&OperationSummary> = operations.iter().collect();
    sorted.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
    let elements: Vec<String> = sorted
        .iter()
        .map(|op| {
            format!(
                "{{\"operation_id\":\"{}\",\"state\":\"{}\",\"result_hash\":\"{}\"}}",
                op.operation_id, op.state, op.result_hash
            )
        })
        .collect();
    let body = format!("[{}]", elements.join(","));
    sha256_hex(body.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(id: &str, state: &str, result_hash: &str) -> OperationSummary {
        OperationSummary {
            operation_id: id.into(),
            state: state.into(),
            result_hash: result_hash.into(),
        }
    }

    #[test]
    fn empty_set_hashes_brackets() {
        assert_eq!(final_operation_set_hash(&[]), sha256_hex(b"[]"));
    }

    #[test]
    fn single_element_exact_body() {
        let ops = [op("op-1", "succeeded", "abcd")];
        let expected_body =
            "[{\"operation_id\":\"op-1\",\"state\":\"succeeded\",\"result_hash\":\"abcd\"}]";
        assert_eq!(
            final_operation_set_hash(&ops),
            sha256_hex(expected_body.as_bytes())
        );
    }

    #[test]
    fn sorted_by_operation_id_text() {
        // Input out of order; the hash must equal the sorted-order body.
        let ops = [op("op-2", "failed", ""), op("op-1", "succeeded", "h1")];
        let sorted_body =
            "[{\"operation_id\":\"op-1\",\"state\":\"succeeded\",\"result_hash\":\"h1\"},\
             {\"operation_id\":\"op-2\",\"state\":\"failed\",\"result_hash\":\"\"}]";
        assert_eq!(
            final_operation_set_hash(&ops),
            sha256_hex(sorted_body.as_bytes())
        );
    }

    #[test]
    fn empty_result_hash_when_no_completed() {
        let ops = [op("op-1", "unknown", "")];
        let body = "[{\"operation_id\":\"op-1\",\"state\":\"unknown\",\"result_hash\":\"\"}]";
        assert_eq!(final_operation_set_hash(&ops), sha256_hex(body.as_bytes()));
    }

    #[test]
    fn order_independent() {
        let a = [op("op-1", "succeeded", "h1"), op("op-2", "failed", "h2")];
        let b = [op("op-2", "failed", "h2"), op("op-1", "succeeded", "h1")];
        assert_eq!(final_operation_set_hash(&a), final_operation_set_hash(&b));
    }

    #[test]
    fn result_hash_change_changes_hash() {
        let a = [op("op-1", "succeeded", "h1")];
        let b = [op("op-1", "succeeded", "h2")];
        assert_ne!(final_operation_set_hash(&a), final_operation_set_hash(&b));
    }
}
