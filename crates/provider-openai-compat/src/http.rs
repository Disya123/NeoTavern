//! Minimal blocking HTTP/1.1 client with optional TLS (rustls), used by the
//! OpenAI-compatible adapter (ТЗ §9.3, Этап 2.5).
//!
//! Deliberately small: the kernel is a synchronous single-writer process and
//! the adapter contract ([`ProviderAdapter::generate`]) is blocking, so no
//! async runtime is pulled in. Features:
//!
//! - plain `http://` over [`std::net::TcpStream`];
//! - `https://` over a rustls [`ClientConnection`] verified against the OS
//!   trust store (`rustls-platform-verifier`) — no bundled root bundle, no
//!   vendored OpenSSL;
//! - bounded reads (SEC-04): the body is capped at a configurable budget and
//!   the connection is dropped immediately when the cap is exceeded;
//! - `Content-Length`, `Transfer-Encoding: chunked` and read-until-close
//!   response bodies;
//! - a single POST with `Connection: close` — keep-alive is out of scope for
//!   provider calls (each attempt is one fresh connection).

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

/// Maximum accepted response head (status line + headers).
const MAX_HEAD_BYTES: u64 = 8 * 1024;

/// An open HTTP connection: plain TCP or TLS-wrapped TCP.
pub(crate) enum Connection {
    /// Plaintext connection.
    Plain(TcpStream),
    /// TLS connection over TCP (boxed: the TLS handshake state is large).
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Read for Connection {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Connection::Plain(stream) => stream.read(buf),
            Connection::Tls(stream) => stream.read(buf),
        }
    }
}

impl Write for Connection {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Connection::Plain(stream) => stream.write(buf),
            Connection::Tls(stream) => stream.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Connection::Plain(stream) => stream.flush(),
            Connection::Tls(stream) => stream.flush(),
        }
    }
}

/// One outgoing HTTP request (POST with a body).
pub(crate) struct HttpRequest<'a> {
    /// Request path (e.g. `/v1/chat/completions`).
    pub path: &'a str,
    /// Host header value / TLS SNI.
    pub host: &'a str,
    /// Connection port.
    pub port: u16,
    /// Whether to use TLS.
    pub tls: bool,
    /// Extra headers, already framed as `"Name: value"` lines.
    pub headers: Vec<String>,
    /// Request body bytes.
    pub body: &'a [u8],
}

/// An HTTP response: status plus a bounded body reader.
pub(crate) struct HttpResponse {
    /// Numeric status code (e.g. 200).
    pub status: u16,
    /// Bounded body reader.
    pub body: BoundedBody<BufReader<Connection>>,
}

/// Establishes a connection (optionally TLS) and sends the request.
pub(crate) fn send(
    request: &HttpRequest<'_>,
    connect_timeout: Duration,
    read_timeout: Option<Duration>,
) -> io::Result<HttpResponse> {
    let addr = resolve(request.host, request.port)?;
    let stream = TcpStream::connect_timeout(&addr, connect_timeout)?;
    stream.set_read_timeout(read_timeout)?;
    stream.set_nodelay(true)?;

    let connection = if request.tls {
        Connection::Tls(Box::new(wrap_tls(request.host, stream)?))
    } else {
        Connection::Plain(stream)
    };
    let mut writer = connection;
    let head = build_request_head(request);
    writer.write_all(&head)?;
    writer.write_all(request.body)?;
    writer.flush()?;

    let mut reader = BufReader::new(writer);
    let (status, headers) = read_head(&mut reader)?;
    let body = BoundedBody::new(reader, &headers);
    Ok(HttpResponse { status, body })
}

/// Resolves `host:port` to one socket address (first answer, IPv4-preferred).
fn resolve(host: &str, port: u16) -> io::Result<SocketAddr> {
    (host, port)
        .to_socket_addrs()?
        .find(|addr| addr.is_ipv4())
        .or_else(|| {
            (host, port)
                .to_socket_addrs()
                .ok()
                .and_then(|mut it| it.next())
        })
        .ok_or_else(|| io::Error::new(io::ErrorKind::AddrNotAvailable, "no address for host"))
}

/// Wraps a TCP stream in a rustls client connection verified against the OS
/// trust store.
fn wrap_tls(
    host: &str,
    stream: TcpStream,
) -> io::Result<rustls::StreamOwned<rustls::ClientConnection, TcpStream>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier =
        rustls_platform_verifier::Verifier::new(Arc::clone(&provider)).map_err(io::Error::other)?;
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    use rustls::pki_types::ServerName;
    let server_name = match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ServerName::IpAddress(rustls::pki_types::IpAddr::from(ip)),
        Err(_) => ServerName::try_from(host.to_string()).map_err(io::Error::other)?,
    };
    let connection =
        rustls::ClientConnection::new(Arc::new(config), server_name).map_err(io::Error::other)?;
    Ok(rustls::StreamOwned::new(connection, stream))
}

/// Renders the request head (status line + headers + blank line).
fn build_request_head(request: &HttpRequest<'_>) -> Vec<u8> {
    let host_header = if request.port == 80 && !request.tls || request.port == 443 && request.tls {
        request.host.to_string()
    } else {
        format!("{}:{}", request.host, request.port)
    };
    let mut head = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        request.path,
        host_header,
        request.body.len()
    );
    for header in &request.headers {
        head.push_str(header);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    head.into_bytes()
}

/// Reads the status line and headers (bounded by [`MAX_HEAD_BYTES`]).
fn read_head(
    reader: &mut BufReader<Connection>,
) -> io::Result<(u16, std::collections::HashMap<String, String>)> {
    let mut head = Vec::new();
    let mut line = Vec::new();
    let mut bytes = 0u64;
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before response head",
            ));
        }
        bytes += n as u64;
        if bytes > MAX_HEAD_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "response head exceeds byte budget",
            ));
        }
        head.extend_from_slice(&line);
        if line == b"\r\n" || line == b"\n" {
            break;
        }
    }
    let head = String::from_utf8_lossy(&head);
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or_default();
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed HTTP status line"))?;
    let mut headers = std::collections::HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    Ok((status, headers))
}

/// Bounded HTTP response body: enforces the SEC-04 byte budget, decodes
/// `chunked` transfer encoding, and honors `Content-Length`.
pub(crate) struct BoundedBody<R: BufRead> {
    inner: R,
    /// Remaining byte budget; exceeding it destroys the read (error).
    budget: u64,
    /// `Content-Length` when the server sent one.
    content_length: Option<u64>,
    /// Chunked transfer state.
    chunked: bool,
    /// Bytes remaining in the current chunk.
    chunk_remaining: u64,
    /// Whether the body is finished.
    done: bool,
}

impl<R: BufRead> BoundedBody<R> {
    fn new(inner: R, headers: &std::collections::HashMap<String, String>) -> Self {
        let chunked = headers
            .get("transfer-encoding")
            .map(|v| v.to_ascii_lowercase().contains("chunked"))
            .unwrap_or(false);
        let content_length = headers
            .get("content-length")
            .and_then(|v| v.trim().parse::<u64>().ok());
        Self {
            inner,
            budget: u64::MAX, // the caller replaces the budget via `with_budget`
            content_length,
            chunked,
            chunk_remaining: 0,
            done: false,
        }
    }

    /// Replaces the default (unbounded) budget with the configured cap.
    pub(crate) fn with_budget(mut self, budget: u64) -> Self {
        self.budget = budget;
        self
    }

    fn read_chunked(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.chunk_remaining == 0 {
            // Read the next chunk-size line.
            let mut line = Vec::new();
            let n = self.inner.read_until(b'\n', &mut line)?;
            if n == 0 {
                return Ok(0);
            }
            if n > 64 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "chunk size line too long",
                ));
            }
            let text = String::from_utf8_lossy(&line);
            let size_text = text.trim().split(';').next().unwrap_or_default().trim();
            let size = u64::from_str_radix(size_text, 16)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed chunk size"))?;
            if size == 0 {
                self.done = true;
                return Ok(0);
            }
            self.chunk_remaining = size;
        }
        let want = buf.len().min(self.chunk_remaining as usize);
        let n = self.inner.read(&mut buf[..want])?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed mid-chunk",
            ));
        }
        self.chunk_remaining -= n as u64;
        if self.chunk_remaining == 0 {
            // Consume the CRLF after the chunk data.
            let mut crlf = [0u8; 2];
            let read = self.inner.read(&mut crlf)?;
            if read == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "connection closed before chunk trailer",
                ));
            }
        }
        Ok(n)
    }
}

impl<R: BufRead> Read for BoundedBody<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done {
            return Ok(0);
        }
        if self.content_length.is_some_and(|len| len == 0) && !self.chunked {
            self.done = true;
            return Ok(0);
        }
        if self.budget == 0 {
            self.done = true;
            return Err(io::Error::other(
                "response exceeded max_response_bytes budget",
            ));
        }
        let want = buf.len().min(self.budget as usize);
        let n = if self.chunked {
            self.read_chunked(&mut buf[..want])?
        } else {
            self.inner.read(&mut buf[..want])?
        };
        if n == 0 {
            self.done = true;
        }
        self.budget -= n as u64;
        Ok(n)
    }
}
