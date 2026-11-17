//! The Windows production mTLS connector: a CA-issued client certificate bound to a
//! NON-EXPORTABLE CNG key (device-design §2.1 step 4). No private key bytes exist anywhere
//! on this path — the certificate arrives as DER and is linked to the persisted key by
//! CONTAINER NAME, so `tls.rs`'s PKCS#12 identity (which needs the scalar) is not used.
//!
//! THREE MEASURED PLATFORM FACTS, each one edit away from being silently lost:
//!  * `CERT_KEY_PROV_INFO_PROP_ID` must leave `dwKeySpec` at its default **0**. Setting
//!    `AT_SIGNATURE` or `AT_KEYEXCHANGE` makes crypt32 take the legacy CSP lookup and fail
//!    with NTE_KEYSET_NOT_DEF ("密钥集不存在"), even though the CNG key opens fine by name.
//!    Measured across both key specs, with and without CRYPT_ACQUIRE_COMPARE_KEY_FLAG.
//!  * `CERT_NCRYPT_KEY_HANDLE_PROP_ID` is NOT a working alternative: both pvData conventions
//!    (the handle value, and a pointer to it) fail with CRYPT_E_NO_DECRYPT_CERT.
//!  * `CertCreateSelfSignCertificate` segfaulted with a NULL subject blob under
//!    x86_64-pc-windows-gnu, with and without CRYPT_KEY_PROV_INFO. It is not used; the
//!    certificate comes from the device CA, which is the production shape anyway.
//!
//! Unlike `native-tls`, schannel CAN pin the protocol floor: `enabled_protocols([Tls13])`
//! becomes `TLS_PARAMETERS.grbitDisabledProtocols = !SP_PROT_TLS1_3_CLIENT`, matching the
//! gateway listener's `MinVersion: tls.VersionTLS13`. That closes the second boundary
//! registered in `tls.rs`.
//!
//! The async adapter follows the same contract `tokio-native-tls` uses: schannel's
//! `TlsStream` documents that a `WouldBlock` error expects another call starting with the
//! same input data, so `Poll::Pending` is translated to `WouldBlock` for the duration of
//! one blocking call and back afterwards.

use std::future::Future;
use std::io::{self, Read, Write};
use std::pin::Pin;
use std::ptr::null_mut;
use std::task::{Context, Poll};

use http::Uri;
use hyper_util::rt::TokioIo;
use schannel::cert_context::CertContext;
use schannel::cert_store::{CertStore, Memory};
use schannel::schannel_cred::{Builder as CredBuilder, Direction, Protocol, SchannelCred};
use schannel::tls_stream::{
    Builder as StreamBuilder, HandshakeError, MidHandshakeTlsStream, TlsStream,
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tower_service::Service;

use super::tls::TlsError;

type ConnectError = Box<dyn std::error::Error + Send + Sync>;

/// The ALPN protocol gRPC requires. tonic drives hyper's HTTP/2 client directly and assumes
/// h2 was negotiated, so a peer that picked http/1.1 would hang rather than fail cleanly.
const ALPN_H2: &[u8] = b"h2";

/// Bridges tokio's poll-based readiness to schannel's blocking `Read`/`Write` bounds. The
/// context pointer is only non-null for the duration of one call, and is cleared afterwards.
struct AllowStd {
    inner: TcpStream,
    context: *mut (),
}

// The raw context pointer is neither Send nor Sync, but it is never dereferenced outside
// the call that installed it, and the stream itself is Send.
unsafe impl Send for AllowStd {}
unsafe impl Sync for AllowStd {}

impl AllowStd {
    fn with_context<F, R>(&mut self, f: F) -> io::Result<R>
    where
        F: FnOnce(&mut Context<'_>, Pin<&mut TcpStream>) -> Poll<io::Result<R>>,
    {
        unsafe {
            assert!(!self.context.is_null());
            let waker = &mut *(self.context as *mut Context<'_>);
            match f(waker, Pin::new(&mut self.inner)) {
                Poll::Ready(result) => result,
                Poll::Pending => Err(io::Error::from(io::ErrorKind::WouldBlock)),
            }
        }
    }
}

impl Read for AllowStd {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut read_buf = ReadBuf::new(buf);
        self.with_context(|ctx, stream| stream.poll_read(ctx, &mut read_buf))?;
        Ok(read_buf.filled().len())
    }
}

impl Write for AllowStd {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.with_context(|ctx, stream| stream.poll_write(ctx, buf))
    }

    fn flush(&mut self) -> io::Result<()> {
        self.with_context(|ctx, stream| stream.poll_flush(ctx))
    }
}

/// The first `connect` call, deferred until a poll context exists. schannel performs I/O
/// inside `connect` itself, so calling it from the connector's async block would reach
/// `AllowStd` with a null waker and panic. The handshake error is boxed because it carries
/// the whole mid-handshake stream by value.
type ConnectFn =
    Box<dyn FnOnce(AllowStd) -> Result<TlsStream<AllowStd>, Box<HandshakeError<AllowStd>>> + Send>;

enum State {
    Start(Option<(AllowStd, ConnectFn)>),
    /// `handshake` consumes the mid-handshake stream, so it is held in an Option to be
    /// taken per poll and put back when the handshake is still interrupted.
    Handshake(Option<MidHandshakeTlsStream<AllowStd>>),
    Ready(TlsStream<AllowStd>),
    Failed,
}

/// A schannel TLS stream over a tokio TcpStream, usable as a hyper transport.
pub struct CngTlsStream {
    state: State,
}

impl CngTlsStream {
    fn poll_handshake(&mut self, ctx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // The state is moved out so the finish step can borrow self mutably.
        let result = match std::mem::replace(&mut self.state, State::Failed) {
            State::Ready(stream) => {
                self.state = State::Ready(stream);
                return Poll::Ready(Ok(()));
            }
            State::Failed => {
                return Poll::Ready(Err(io::Error::other("tls handshake already failed")))
            }
            State::Start(mut slot) => {
                let (mut allow, connect) = match slot.take() {
                    Some(pair) => pair,
                    None => {
                        return Poll::Ready(Err(io::Error::other("tls handshake already failed")))
                    }
                };
                allow.context = ctx as *mut _ as *mut ();
                connect(allow)
            }
            State::Handshake(mut slot) => {
                let mut mid = match slot.take() {
                    Some(mid) => mid,
                    None => {
                        return Poll::Ready(Err(io::Error::other("tls handshake already failed")))
                    }
                };
                mid.get_mut().context = ctx as *mut _ as *mut ();
                mid.handshake().map_err(Box::new)
            }
        };
        self.finish(result)
    }

    fn finish(
        &mut self,
        result: Result<TlsStream<AllowStd>, Box<HandshakeError<AllowStd>>>,
    ) -> Poll<io::Result<()>> {
        match result {
            Ok(mut stream) => {
                stream.get_mut().context = null_mut();
                // A negotiated protocol other than h2 would hang tonic rather than fail.
                match stream.negotiated_application_protocol() {
                    Ok(Some(protocol)) if protocol == ALPN_H2 => {}
                    Ok(other) => {
                        self.state = State::Failed;
                        return Poll::Ready(Err(io::Error::other(format!(
                            "gateway negotiated {other:?}, want h2"
                        ))));
                    }
                    Err(err) => {
                        self.state = State::Failed;
                        return Poll::Ready(Err(err));
                    }
                }
                self.state = State::Ready(stream);
                Poll::Ready(Ok(()))
            }
            Err(err) => match *err {
                HandshakeError::Interrupted(mut mid) => {
                    mid.get_mut().context = null_mut();
                    self.state = State::Handshake(Some(mid));
                    Poll::Pending
                }
                HandshakeError::Failure(err) => {
                    self.state = State::Failed;
                    Poll::Ready(Err(err))
                }
            },
        }
    }

    fn with_context<F, R>(&mut self, ctx: &mut Context<'_>, f: F) -> Poll<io::Result<R>>
    where
        F: FnOnce(&mut TlsStream<AllowStd>) -> io::Result<R>,
    {
        let stream = match &mut self.state {
            State::Ready(stream) => stream,
            _ => return Poll::Ready(Err(io::Error::other("tls stream is not established"))),
        };
        stream.get_mut().context = ctx as *mut _ as *mut ();
        let result = f(stream);
        stream.get_mut().context = null_mut();
        match result {
            Ok(value) => Poll::Ready(Ok(value)),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => Poll::Pending,
            Err(err) => Poll::Ready(Err(err)),
        }
    }
}

impl AsyncRead for CngTlsStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        ctx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.poll_handshake(ctx) {
            Poll::Ready(Ok(())) => {}
            other => return other,
        }
        self.with_context(ctx, |stream| {
            let read = stream.read(buf.initialize_unfilled())?;
            buf.advance(read);
            Ok(())
        })
    }
}

impl AsyncWrite for CngTlsStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        ctx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.poll_handshake(ctx) {
            Poll::Ready(Ok(())) => {}
            Poll::Ready(Err(err)) => return Poll::Ready(Err(err)),
            Poll::Pending => return Poll::Pending,
        }
        self.with_context(ctx, |stream| stream.write(buf))
    }

    fn poll_flush(mut self: Pin<&mut Self>, ctx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.poll_handshake(ctx) {
            Poll::Ready(Ok(())) => {}
            other => return other,
        }
        self.with_context(ctx, |stream| stream.flush())
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, ctx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.poll_handshake(ctx) {
            Poll::Ready(Ok(())) => {}
            other => return other,
        }
        self.with_context(ctx, |stream| stream.shutdown())
    }
}

/// A dial-ready connector whose client identity is bound to a non-exportable CNG key.
/// Build once, clone per connection.
#[derive(Clone)]
pub struct CngTlsConnector {
    cred: SchannelCred,
    trust: CertStore,
    server_name: String,
}

impl std::fmt::Debug for CngTlsConnector {
    /// Never prints key material or the credential handle.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CngTlsConnector")
            .field("server_name", &self.server_name)
            .finish_non_exhaustive()
    }
}

impl CngTlsConnector {
    /// Build from the CA root PEM, the CA-issued certificate chain (leaf first, DER) and
    /// the persisted CNG key's container name. `server_name` is verified against the
    /// gateway's server certificate; it is NOT taken from the URI the connector is called
    /// with, because the gateway certificate is issued for a fixed name.
    pub fn new(
        ca_pem: &[u8],
        cert_der_chain: &[Vec<u8>],
        container: &str,
        provider: &str,
        server_name: &str,
    ) -> Result<Self, TlsError> {
        // An empty buffer handed to the platform certificate APIs is not a clean error on
        // every path, so refuse before calling them (the same guard tls.rs carries).
        if ca_pem.is_empty() || cert_der_chain.is_empty() || container.is_empty() {
            return Err(TlsError::Identity);
        }
        let leaf_der = &cert_der_chain[0];
        if leaf_der.is_empty() {
            return Err(TlsError::Identity);
        }

        // The identity store holds the whole chain so schannel can build it, and the leaf
        // context is the store-resident one returned by add_encoded_certificate.
        let mut identity = Memory::new().map_err(|_| TlsError::Identity)?;
        let leaf = identity
            .add_encoded_certificate(leaf_der)
            .map_err(|_| TlsError::Identity)?;
        for der in &cert_der_chain[1..] {
            identity
                .add_encoded_certificate(der)
                .map_err(|_| TlsError::Identity)?;
        }
        // dwKeySpec is deliberately NOT set: see the module doc for the measured reason.
        leaf.set_key_prov_info()
            .container(container)
            .provider(provider)
            .silent(true)
            .set()
            .map_err(|_| TlsError::Identity)?;

        let mut cred = CredBuilder::new();
        cred.cert(leaf).enabled_protocols(&[Protocol::Tls13]);
        let cred = cred
            .acquire(Direction::Outbound)
            .map_err(|_| TlsError::Build)?;

        let ca_pem = std::str::from_utf8(ca_pem).map_err(|_| TlsError::Ca)?;
        let ca = CertContext::from_pem(ca_pem).map_err(|_| TlsError::Ca)?;
        let mut trust = Memory::new().map_err(|_| TlsError::Ca)?;
        trust
            .add_encoded_certificate(ca.to_der())
            .map_err(|_| TlsError::Ca)?;

        Ok(Self {
            cred,
            trust: trust.into_store(),
            server_name: server_name.to_string(),
        })
    }
}

impl Service<Uri> for CngTlsConnector {
    type Response = TokioIo<CngTlsStream>;
    type Error = ConnectError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let host = uri.host().unwrap_or_default().to_string();
        let port = uri.port_u16().unwrap_or(443);
        let cred = self.cred.clone();
        let trust = self.trust.clone();
        let server_name = self.server_name.clone();
        Box::pin(async move {
            let tcp = TcpStream::connect((host.as_str(), port)).await?;
            tcp.set_nodelay(true)?;
            let connect: ConnectFn = Box::new(move |allow| {
                let mut builder = StreamBuilder::new();
                builder
                    .domain(&server_name)
                    .cert_store(trust)
                    .request_application_protocols(&[ALPN_H2]);
                builder.connect(cred, allow).map_err(Box::new)
            });
            Ok(TokioIo::new(CngTlsStream {
                state: State::Start(Some((
                    AllowStd {
                        inner: tcp,
                        context: null_mut(),
                    },
                    connect,
                ))),
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROVIDER: &str = "Microsoft Software Key Storage Provider";

    #[test]
    fn empty_key_material_is_refused_before_the_platform_call() {
        let der = vec![1u8, 2, 3];
        // Each guard must fire on its own, not only when everything is empty at once.
        assert!(
            CngTlsConnector::new(b"", std::slice::from_ref(&der), "c", PROVIDER, "localhost")
                .is_err()
        );
        assert!(CngTlsConnector::new(b"ca", &[], "c", PROVIDER, "localhost").is_err());
        assert!(CngTlsConnector::new(b"ca", &[Vec::new()], "c", PROVIDER, "localhost").is_err());
        assert!(CngTlsConnector::new(b"ca", &[der], "", PROVIDER, "localhost").is_err());
    }

    #[test]
    fn a_non_certificate_leaf_is_refused_as_an_identity_failure() {
        // Not a DER certificate: the platform store must refuse it, and the connector must
        // surface that as Identity rather than panicking or dialing without a client cert.
        let err = CngTlsConnector::new(
            b"-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----\n",
            &[vec![0u8; 8]],
            "container",
            PROVIDER,
            "localhost",
        );
        assert!(err.is_err());
    }
}
