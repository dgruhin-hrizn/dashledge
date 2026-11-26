use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::time::Duration;

fn store() -> Url {
    Url::parse("https://data.alpaca.markets").unwrap()
}

pub fn credentials() -> Result<Value, String> {
    let raw = crate::vault::get("alpaca", &store())?
        .key
        .ok_or("Connect Alpaca in Widget Studio to stream live trades.")?;
    serde_json::from_str(&raw).map_err(|_| "Reconnect Alpaca in Widget Studio.".into())
}

#[tauri::command]
pub async fn markets_connect(
    window: tauri::WebviewWindow,
    key: String,
    secret: String,
) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Open Widget Studio.".into());
    }
    let (key, secret) = (key.trim(), secret.trim());
    if key.is_empty() != secret.is_empty() {
        return Err("Enter both the key ID and secret.".into());
    }
    let entry = if key.is_empty() {
        String::new()
    } else {
        let response = Client::builder()
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(|e| e.to_string())?
            .get("https://data.alpaca.markets/v2/stocks/SPY/snapshot?feed=iex")
            .header("APCA-API-KEY-ID", key)
            .header("APCA-API-SECRET-KEY", secret)
            .send()
            .await
            .map_err(|_| "Could not reach Alpaca.")?;
        if !response.status().is_success() {
            return Err(format!(
                "Alpaca returned HTTP {}. Check your data credentials.",
                response.status()
            ));
        }
        json!({"key":key,"secret":secret}).to_string()
    };
    crate::vault::set("alpaca", &store(), entry)?;
    crate::widget_host::restart_markets();
    Ok(())
}
