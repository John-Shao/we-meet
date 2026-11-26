package devicesig

// UserVersionProofType is the signing domain for a user-saved local artifact version.
const UserVersionProofType = "user_version_proof"

// VerifyUserVersion verifies the device signature over the closed 21-key proof.
// The signature is transported in X-Device-Signature and is never a proof field.
func VerifyUserVersion(pub *PublicKey, proofJSON []byte, signatureB64 string) bool {
	return VerifyFrame(pub, UserVersionProofType, proofJSON, signatureB64)
}
