//! Sign-in sessions for connections whose manifest auth is `{"login": …}`: qBittorrent's
//! SID cookie, Frigate's authenticated port, Dispatcharr's JWT. Dashledge posts the
//! sign-in form with the saved username and key, keeps the session it returns in memory
//! per connection, and puts it on later requests to that connection only. Package code
//! never sees the form, the reply or the session.
use crate::package_connector::{Credential, Secret, Target};
use crate::package_manifest::{Login, LoginBody, LoginSession};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

/// After a failed sign-in, wait this long before posting the form again.
const RETRY_AFTER: Duration = Duration::from_secs(15);

#[derive(Default)]
struct Store {
    sessions: HashMap<String, Credential>,
    failed: HashMap<String, Instant>,
}
static STORE: LazyLock<Mutex<Store>> = LazyLock::new(Default::default);

fn key(kind: &str, account: &reqwest::Url) -> String {
    format!("{kind}|{account}")
}

/// Forget a connection's session, as when its saved credential changes.
pub fn forget(kind: &str, account: &reqwest::Url) {
    let mut store = STORE.lock().unwrap();
    let key = key(kind, account);
    store.sessions.remove(&key);
    store.failed.remove(&key);
}

/// The session already signed in for a connection, if any.
#[cfg(test)]
fn cached(kind: &str, account: &reqwest::Url) -> Option<Credential> {
    STORE.lock().unwrap().sessions.get(&key(kind, account)).cloned()
}

/// The form fields with `{user}` and `{key}` filled in.
fn fields(login: &Login, secret: &Secret) -> Vec<(String, String)> {
    login.fields.iter().map(|(name, value)| (name.clone(), value.replace("{user}", &secret.user).replace("{key}", &secret.key))).collect()
}

/// The session a sign-in reply carries.
fn session_from(session: &LoginSession, cookies: &[String], body: &[u8]) -> Result<Credential, String> {
    match session {
        LoginSession::Cookie => {
            let pairs: Vec<&str> = cookies.iter().filter_map(|c| c.split(';').next()).map(str::trim).filter(|p| p.contains('=') && !p.ends_with('=')).collect();
            if pairs.is_empty() {
                return Err("Sign-in didn’t start a session. Check the username and password.".into());
            }
            Ok(Credential::Header("Cookie".into(), pairs.join("; ")))
        }
        LoginSession::Token { pointer, header, format } => {
            let reply: Value = serde_json::from_slice(body).map_err(|_| "Sign-in didn’t return JSON.")?;
            let token = reply.pointer(pointer).and_then(Value::as_str).filter(|t| !t.is_empty())
                .ok_or("Sign-in didn’t return a session token. Check the username and password.")?;
            let value = format.as_deref().map_or_else(|| token.to_string(), |f| f.replace("{token}", token));
            Ok(Credential::Header(header.clone(), value))
        }
    }
}

/// The connection's session: the cached one, or a fresh sign-in when there is none or
/// `renew` is set (the server refused the last one).
pub async fn credential(kind: &str, target: &Target, login: &Login, secret: &Secret, client: &reqwest::Client, renew: bool) -> Result<Credential, String> {
    let key = key(kind, &target.account);
    {
        let store = STORE.lock().unwrap();
        if !renew {
            if let Some(session) = store.sessions.get(&key) {
                return Ok(session.clone());
            }
        }
        if store.failed.get(&key).is_some_and(|at| at.elapsed() < RETRY_AFTER) {
            return Err("Sign-in failed a moment ago. Check the username and password, then try again.".into());
        }
    }
    let result = sign_in(target, login, secret, client).await;
    let mut store = STORE.lock().unwrap();
    match &result {
        Ok(session) => {
            store.sessions.insert(key.clone(), session.clone());
            store.failed.remove(&key);
        }
        Err(_) => {
            store.sessions.remove(&key);
            store.failed.insert(key, Instant::now());
        }
    }
    result
}

async fn sign_in(target: &Target, login: &Login, secret: &Secret, client: &reqwest::Client) -> Result<Credential, String> {
    let url = crate::package_connector::route_url(&target.base, &login.path);
    let values = fields(login, secret);
    let request = client.post(url).timeout(Duration::from_secs(15)).header("Accept", "application/json, text/plain, */*");
    let request = match login.body {
        LoginBody::Form => request.form(&values),
        LoginBody::Json => request.json(&values.into_iter().map(|(k, v)| (k, Value::String(v))).collect::<Map<String, Value>>()),
    };
    // Fixed error text: a reqwest error could name the URL.
    let response = request.send().await.map_err(|_| "Server unreachable".to_string())?;
    let status = response.status();
    let cookies: Vec<String> = response.headers().get_all("set-cookie").iter().filter_map(|v| v.to_str().ok().map(str::to_string)).collect();
    let body = response.bytes().await.map_err(|_| "Connection interrupted")?;
    if !status.is_success() {
        return Err(format!("Sign-in was refused (HTTP {}). Check the username and password.", status.as_u16()));
    }
    session_from(&login.session, &cookies, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn login(session: Value, body: &str) -> Login {
        serde_json::from_value(json!({"path": "api/v2/auth/login", "body": body, "fields": {"username": "{user}", "password": "{key}"}, "session": session})).unwrap()
    }

    #[test]
    fn a_reply_becomes_a_cookie_or_token_session() {
        let cookies = vec!["SID=abc123; HttpOnly; path=/".to_string(), "lang=en; Path=/".to_string(), "empty=; Max-Age=0".to_string()];
        assert_eq!(session_from(&LoginSession::Cookie, &cookies, b"Ok.").unwrap(), Credential::Header("Cookie".into(), "SID=abc123; lang=en".into()));
        assert!(session_from(&LoginSession::Cookie, &[], b"Fails.").is_err(), "qBittorrent's wrong password sets no cookie");
        let token = LoginSession::Token { pointer: "/access".into(), header: "Authorization".into(), format: Some("Bearer {token}".into()) };
        assert_eq!(session_from(&token, &[], br#"{"access":"jwt.value","refresh":"r"}"#).unwrap(), Credential::Header("Authorization".into(), "Bearer jwt.value".into()));
        assert!(session_from(&token, &[], br#"{"detail":"No active account"}"#).is_err());
        let secret = Secret { user: "admin".into(), key: "pa ss".into() };
        assert_eq!(fields(&login(json!("cookie"), "form"), &secret), vec![("password".into(), "pa ss".into()), ("username".into(), "admin".into())]);
    }

    #[test]
    fn a_session_is_reused_renewed_and_a_failure_waits() {
        // A local server that accepts the first sign-in and refuses the second.
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (n, stream) in listener.incoming().take(2).enumerate() {
                let mut stream = stream.unwrap();
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap();
                requests.push(String::from_utf8_lossy(&buffer[..read]).into_owned());
                let reply = if n == 0 { "HTTP/1.1 200 OK\r\nSet-Cookie: SID=first; HttpOnly\r\nContent-Length: 3\r\nConnection: close\r\n\r\nOk." }
                            else { "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" };
                stream.write_all(reply.as_bytes()).unwrap();
            }
            requests
        });
        let base = reqwest::Url::parse(&address).unwrap();
        let target = Target { base: base.clone(), account: base };
        let secret = Secret { user: "admin".into(), key: "s3cret".into() };
        let login = login(json!("cookie"), "form");
        let client = crate::connections::plain_client();
        let run = |renew| tauri::async_runtime::block_on(credential("plugin.qbit-test", &target, &login, &secret, &client, renew));
        assert_eq!(run(false).unwrap(), Credential::Header("Cookie".into(), "SID=first".into()));
        assert_eq!(run(false).unwrap(), Credential::Header("Cookie".into(), "SID=first".into()), "the session is reused without signing in");
        assert!(run(true).unwrap_err().contains("HTTP 403"), "renewing signs in again");
        assert!(cached("plugin.qbit-test", &target.account).is_none(), "a refused sign-in drops the session");
        assert!(run(false).unwrap_err().contains("a moment ago"), "and the form isn't posted again right away");
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("POST /api/v2/auth/login ") && requests[0].contains("username=admin") && requests[0].contains("password=s3cret"));
        forget("plugin.qbit-test", &target.account);
        assert!(STORE.lock().unwrap().failed.get(&key("plugin.qbit-test", &target.account)).is_none());
    }
}
