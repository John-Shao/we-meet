package devicesig

// GrantSuccessionProofType is the signing domain for a workspace rebind proof.
const GrantSuccessionProofType = "workspace_grant_succession"

// VerifyGrantSuccession verifies the device signature over a GrantSuccessionProof.
func VerifyGrantSuccession(pub *PublicKey, proofJSON []byte, signatureB64 string) bool {
	return VerifyFrame(pub, GrantSuccessionProofType, proofJSON, signatureB64)
}
