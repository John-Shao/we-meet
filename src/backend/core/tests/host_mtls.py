"""Runtime-generated mTLS material shared by the Work Host wire tests."""

from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

IDENTITY = "work-control-plane"


def _make_ca():
    now = datetime.now(timezone.utc)
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "E2E Work Host CA")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(hours=1))
        .not_valid_after(now + timedelta(hours=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(key, hashes.SHA256())
    )
    return key, cert


def _make_client(ca_key, ca_cert, common_name, *, valid=True):
    now = datetime.now(timezone.utc)
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(
            now - timedelta(hours=2) if not valid else now - timedelta(hours=1)
        )
        .not_valid_after(
            now - timedelta(hours=1) if not valid else now + timedelta(hours=1)
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]),
            critical=False,
        )
    )
    cert = builder.sign(ca_key, hashes.SHA256())
    return cert.public_bytes(serialization.Encoding.PEM).decode("utf-8")


CA_KEY, CA_CERT = _make_ca()
CA_PEM = CA_CERT.public_bytes(serialization.Encoding.PEM).decode("utf-8")
CLIENT_PEM = _make_client(CA_KEY, CA_CERT, IDENTITY)
OTHER_CN_PEM = _make_client(CA_KEY, CA_CERT, "someone-else")
EXPIRED_PEM = _make_client(CA_KEY, CA_CERT, IDENTITY, valid=False)
WRONG_CA_KEY, WRONG_CA_CERT = _make_ca()
WRONG_CA_CLIENT_PEM = _make_client(WRONG_CA_KEY, WRONG_CA_CERT, IDENTITY)


def cert_headers(pem):
    return {"HTTP_SSL_CLIENT_CERT": quote(pem)}
