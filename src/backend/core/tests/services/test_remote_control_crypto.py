"""Crypto contracts run without a database or external service."""

import time
import unittest

import jwt
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from core.services.remote_control_crypto import (
    AUDIENCE,
    InvalidProof,
    canonical,
    decode64,
    digest,
    encode64,
    issue_lease,
    public_key,
    verify_consent,
)


class ConsentCryptoTests(unittest.TestCase):
    def setUp(self):
        self.private = ec.generate_private_key(ec.SECP256R1())
        numbers = self.private.public_key().public_numbers()
        self.jwk = {
            "kty": "EC",
            "crv": "P-256",
            "x": encode64(numbers.x.to_bytes(32, "big")),
            "y": encode64(numbers.y.to_bytes(32, "big")),
        }
        self.body = {
            "v": 1,
            "audience": AUDIENCE,
            "purpose": "approve",
            "requestId": "request",
            "challengeId": "single-use",
            "requestDigest": "immutable",
            "epoch": 1,
            "stateVersion": 2,
            "binding": {"trackSid": "TR_bound"},
        }

    def sign(self, body):
        der = self.private.sign(canonical(body), ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        return encode64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))

    def test_p1363_signature_and_binding_mutations(self):
        signature = self.sign(self.body)
        verify_consent(self.jwk, self.body, signature)
        for field, value in [
            ("audience", "other"),
            ("purpose", "lease"),
            ("epoch", 2),
            ("stateVersion", 3),
            ("challengeId", "replayed"),
            ("binding", {"trackSid": "TR_other"}),
        ]:
            with self.subTest(field=field), self.assertRaises(InvalidProof):
                verify_consent(self.jwk, {**self.body, field: value}, signature)

    def test_canonical_determinism_and_unicode(self):
        self.assertEqual(
            canonical({"b": "中文", "a": 1}), '{"a":1,"b":"中文"}'.encode()
        )
        self.assertEqual(digest({"b": 2, "a": 1}), digest({"a": 1, "b": 2}))
        for bad in [
            1.5,
            float("nan"),
            2**53,
            "\ud800",
            {"non-ascii-键": 1},
            {1: "key"},
        ]:
            with self.subTest(bad=repr(bad)), self.assertRaises(InvalidProof):
                canonical(bad)

    def test_private_key_and_invalid_curve_rejected(self):
        with self.assertRaises(InvalidProof):
            public_key({**self.jwk, "d": "do-not-accept-private-keys"})
        with self.assertRaises(InvalidProof):
            public_key({**self.jwk, "crv": "P-384"})
        with self.assertRaises(InvalidProof):
            public_key({**self.jwk, "x": encode64(bytes(32)), "y": encode64(bytes(32))})
        with self.assertRaises(InvalidProof):
            decode64(self.jwk["x"] + "=", 32)

    def test_lease_audience_duration_and_reserved_claims(self):
        pem = self.private.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        now = int(time.time())
        token = issue_lease(
            {"sessionId": "bound", "exp": now + 999},
            pem=pem,
            kid="remote-v1",
            issued_at=now,
            expires_at=now + 15,
        )
        claims = jwt.decode(
            token, self.private.public_key(), algorithms=["ES256"], audience=AUDIENCE
        )
        self.assertEqual(claims["exp"], now + 15)
        self.assertEqual(claims["binding"]["sessionId"], "bound")
        with self.assertRaises(jwt.InvalidAudienceError):
            jwt.decode(
                token,
                self.private.public_key(),
                algorithms=["ES256"],
                audience="livekit",
            )
        for ttl in [0, -1, 16, 1800]:
            with self.assertRaises(InvalidProof):
                issue_lease(
                    {}, pem=pem, kid="remote-v1", issued_at=now, expires_at=now + ttl
                )


if __name__ == "__main__":
    unittest.main()
