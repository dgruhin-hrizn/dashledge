use reqwest::Url;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};
pub fn receive(listener: TcpListener, redirect: &str, state: &str) -> Result<String, String> {
    let end = Instant::now() + Duration::from_secs(180);
    while Instant::now() < end {
        let (mut stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        let mut line = String::new();
        if BufReader::new((&stream).take(8192))
            .read_line(&mut line)
            .is_err()
        {
            continue;
        }
        let Some(path) = line
            .split_whitespace()
            .nth(1)
            .and_then(|p| p.strip_prefix("/callback?"))
        else {
            continue;
        };
        let mut callback = Url::parse(redirect).unwrap();
        callback.set_query(Some(path));
        if !callback
            .query_pairs()
            .any(|(k, v)| k == "state" && v.as_ref() == state)
        {
            continue;
        }
        let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nReturn to Dashledge to finish connecting.");
        return callback
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned())
            .ok_or("Sign-in cancelled.".into());
    }
    Err("Sign-in timed out.".into())
}
