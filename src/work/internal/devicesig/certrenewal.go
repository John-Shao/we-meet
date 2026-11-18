package devicesig

// CertRenewalDomain is the domain prefix of the certificate-renewal covered string.
// device-design §2.1 requires a NEW challenge for renewal and forbids reusing a
// signature domain across pairing/permit/receipt, so renewal cannot ride the pairing
// domain. The design names only the pairing domain; this one is the implementation's
// choice, registered as such in the GW20 plan note. SQL 0058
// confirm_device_certificate_renewal rebuilds the same string.
const CertRenewalDomain = "work-device-cert-renew-v2"

// CertRenewalCoveredString rebuilds the pipe-delimited renewal preimage from the
// server-held values, in the same field order as the pairing form.
func CertRenewalCoveredString(pairingID, challenge, thumbprint, orgID, subjectID string) string {
	return CertRenewalDomain + "|" + pairingID + "|" + challenge + "|" + thumbprint + "|" + orgID + "|" + subjectID
}

// VerifyCertRenewal verifies the device's ES256 signature over the renewal covered
// string. The public key comes from the database via device_renewal_signing_key,
// never from the request body.
func VerifyCertRenewal(pub *PublicKey, pairingID, challenge, orgID, subjectID, signatureB64 string) bool {
	covered := CertRenewalCoveredString(pairingID, challenge, pub.Thumbprint, orgID, subjectID)
	return VerifyES256(pub.Key, []byte(covered), signatureB64)
}