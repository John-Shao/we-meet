//! The device mTLS connector (device-design §2.1). A tower `Service<Uri>` that dials TCP and
//! then wraps it in the platform TLS stack — schannel on Windows, OpenSSL on Linux,
//! Security.framework on macOS — via `native-tls`, so the device presents the SAME client
//! certificate the gateway maps to (deviceID, orgID) (`internal/deviceca.DeviceIdentity`).
//!
//! ALPN `h2` is requested explicitly: tonic drives `hyper`'s HTTP/2 client connection directly
//! and assumes h2 was negotiated, so a connector that let the peer pick http/1.1 would hang
//! rather than fail cleanly.
//!
//! TWO PRODUCTION BOUNDARIES, registered not papered over:
//!  * The client identity is loaded from a PKCS#12 archive, which requires the private key
//!    BYTES. §2.1 keeps the production device key NON-EXPORTABLE in CNG, so production cannot
//!    use this path — it needs a certificate-store selection or an SSPI credential handle bound
//!    to the CNG key. That is a J39 surface (production device CA / key provenance), deferred.
//!    The test CA path here is what the cross-language interop probe exercises.
//!
//!    PKCS#12 rather than PKCS#8 PEM is a MEASURED platform constraint, not a preference:
//!    native-tls's schannel `Identity::from_pkcs8` hardcodes `ProviderType::rsa_full()` and
//!    `KeySpec::key_exchange()` (imp/schannel.rs), so it can only import an RSA key. The device
//!    identity is EC P-256, and that path fails with "identity did not parse". `from_pkcs12`
//!    goes through PFXImportCertStore, which preserves the key type and works for EC on both
//!    schannel and OpenSSL.
//!  * `native-tls` exposes no minimum-protocol-version knob, so the device cannot pin the
//!    TLS 1.3 floor the gateway's listener sets (`deviceca.ServerTLSConfig`). It relies on the
//!    backend default and on the server refusing anything lower.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use http::Uri;
use hyper_util::rt::TokioIo;
use native_tls::{Certificate, Identity, TlsConnector};
use tokio::net::TcpStream;
use tokio_native_tls::TlsStream;
use tower_service::Service;

/// The error type tonic's connector bounds name as `BoxError`. tonic keeps that alias
/// `pub(crate)`, so the equivalent boxed trait object is spelled out here.
type ConnectError = Box<dyn std::error::Error + Send + Sync>;

/// The ALPN protocol gRPC requires.
const ALPN_H2: &[&str] = &["h2"];

/// Why the connector could not be built from the supplied key material.
#[derive(Debug)]
pub enum TlsError {
    /// The CA PEM did not parse into a certificate.
    Ca,
    /// The PKCS#12 archive did not parse, or carried no usable private key.
    Identity,
    /// The platform TLS stack refused the configuration.
    Build,
}

impl std::fmt::Display for TlsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ca => write!(f, "device ca certificate did not parse"),
            Self::Identity => write!(f, "device client identity did not parse"),
            Self::Build => write!(f, "platform tls connector build failed"),
        }
    }
}

impl std::error::Error for TlsError {}

/// A dial-ready mTLS connector. Build once, clone per connection.
#[derive(Clone)]
pub struct DeviceTlsConnector {
    inner: tokio_native_tls::TlsConnector,
    server_name: String,
}

impl std::fmt::Debug for DeviceTlsConnector {
    /// Never prints key material: the connector holds the client identity.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceTlsConnector")
            .field("server_name", &self.server_name)
            .finish_non_exhaustive()
    }
}

impl DeviceTlsConnector {
    /// Build from the CA root PEM and the device's PKCS#12 client identity. `server_name` is
    /// the name verified against the gateway's server certificate; it is NOT taken from the
    /// dial URI, so a redirect cannot move the trust anchor.
    pub fn new(
        ca_pem: &[u8],
        client_pkcs12: &[u8],
        pkcs12_password: &str,
        server_name: &str,
    ) -> Result<Self, TlsError> {
        // Refuse empty material BEFORE it reaches the platform stack: schannel's
        // Certificate::from_pem hands the buffer to CryptStringToBinaryA with its length, and
        // a zero-length PEM crashes the process (STATUS_ACCESS_VIOLATION) rather than returning
        // an error. The config arrives from outside the crate, so this is a real boundary.
        if client_pkcs12.is_empty() {
            return Err(TlsError::Identity);
        }
        if ca_pem.is_empty() {
            return Err(TlsError::Ca);
        }
        let ca = Certificate::from_pem(ca_pem).map_err(|_| TlsError::Ca)?;
        let identity = Identity::from_pkcs12(client_pkcs12, pkcs12_password)
            .map_err(|_| TlsError::Identity)?;
        let inner = TlsConnector::builder()
            .add_root_certificate(ca)
            .identity(identity)
            .request_alpns(ALPN_H2)
            .build()
            .map_err(|_| TlsError::Build)?;
        Ok(Self {
            inner: tokio_native_tls::TlsConnector::from(inner),
            server_name: server_name.to_string(),
        })
    }

    /// The name this connector verifies the server certificate against.
    pub fn server_name(&self) -> &str {
        &self.server_name
    }
}

impl Service<Uri> for DeviceTlsConnector {
    // tonic 0.13 drives hyper 1.x, whose rt::Read/rt::Write are hyper's OWN traits rather than
    // tokio's AsyncRead/AsyncWrite, so the TLS stream is handed over through hyper-util's
    // TokioIo adapter. Without it the connector compiles but fails the connect_with_connector
    // bound.
    type Response = TokioIo<TlsStream<TcpStream>>;
    type Error = ConnectError;
    // tonic's `Channel::connect` additionally requires the future to be Unpin, which a boxed
    // future is; the concrete async-block type would not be.
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let inner = self.inner.clone();
        let server_name = self.server_name.clone();
        Box::pin(async move {
            let host = uri
                .host()
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, "endpoint has no host")
                })?
                .to_string();
            let port = uri.port_u16().unwrap_or(443);
            let tcp = TcpStream::connect((host.as_str(), port)).await?;
            tcp.set_nodelay(true)?;
            let tls = inner.connect(&server_name, tcp).await?;
            Ok(TokioIo::new(tls))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_ca_pem_that_is_not_a_certificate() {
        let err = DeviceTlsConnector::new(b"not a pem", b"pfx", "", "localhost").unwrap_err();
        assert!(matches!(err, TlsError::Ca));
    }

    #[test]
    fn refuses_empty_key_material_before_the_platform_stack_sees_it() {
        // schannel's CryptStringToBinaryA crashes on a zero-length PEM, so an empty CA must be
        // refused here rather than handed down. Measured: without the guard this call is a
        // STATUS_ACCESS_VIOLATION, not an Err.
        let err = DeviceTlsConnector::new(b"", b"pfx", "", "localhost").unwrap_err();
        assert!(matches!(err, TlsError::Ca));
        let err = DeviceTlsConnector::new(b"not a pem", b"", "", "localhost").unwrap_err();
        assert!(matches!(err, TlsError::Identity));
        // Both empty: the identity guard runs first, so the reported failure names the identity.
        let err = DeviceTlsConnector::new(b"", b"", "", "localhost").unwrap_err();
        assert!(matches!(err, TlsError::Identity));
    }

    #[test]
    fn connector_is_send_sync_and_clone() {
        fn assert_send_sync<T: Send + Sync + Clone + 'static>() {}
        assert_send_sync::<DeviceTlsConnector>();
    }

    #[test]
    fn error_display_names_the_failed_material() {
        assert!(TlsError::Ca.to_string().contains("ca"));
        assert!(TlsError::Identity.to_string().contains("identity"));
        assert!(TlsError::Build.to_string().contains("tls"));
    }
}
