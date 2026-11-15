package devicesig

// PairingDomain is the domain prefix of the pairing covered string
// (device-design §2.1 step 3; SQL 0040 confirm_device_pairing v_canonical).
const PairingDomain = "work-device-pair-v2"

// PairingCoveredString rebuilds the pipe-delimited pairing preimage byte for byte
// from the server-held values: pairing_id, challenge, the device key thumbprint,
// org_id and subject_id. This is the pipe form reconstructed by SQL 0040:1356,
// NOT the RFC 8785 JCS form (JCS applies to JSON frame bodies; the pairing
// covered string is the SQL-rebuilt pipe form — the batch-1 authority resolution).
func PairingCoveredString(pairingID, challenge, thumbprint, orgID, subjectID string) string {
	return PairingDomain + "|" + pairingID + "|" + challenge + "|" + thumbprint + "|" + orgID + "|" + subjectID
}

// VerifyPairing verifies the device's ES256 signature over the pairing covered
// string, using the thumbprint of the parsed (server-held) public key. The public
// key comes from the database, never from the request body (m1a §12 judgment 5).
func VerifyPairing(pub *PublicKey, pairingID, challenge, orgID, subjectID, signatureB64 string) bool {
	covered := PairingCoveredString(pairingID, challenge, pub.Thumbprint, orgID, subjectID)
	return VerifyES256(pub.Key, []byte(covered), signatureB64)
}
