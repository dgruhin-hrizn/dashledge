use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{sync::LazyLock, time::Duration};

static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
});
fn store() -> Url {
    Url::parse("https://slack.com").unwrap()
}
fn account() -> Result<Value, String> {
    let entry = crate::vault::get("slack", &store())?
        .key
        .ok_or("Connect a Slack workspace in Widget Studio.")?;
    serde_json::from_str(&entry).map_err(|_| "Reconnect your Slack workspace.".into())
}
async fn api(
    token: &str,
    method: &str,
    args: Vec<(&str, String)>,
    post: bool,
) -> Result<Value, String> {
    let url = format!("https://slack.com/api/{method}");
    let request = if post {
        CLIENT.post(url).form(&args)
    } else {
        CLIENT.get(url).query(&args)
    };
    let response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Slack is unreachable.")?;
    if response.status().as_u16() == 429 {
        let wait = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("60");
        return Err(format!("Slack rate limit. Retry after {wait}s."));
    }
    let body: Value = response
        .error_for_status()
        .map_err(|e| format!("Slack returned HTTP {}", e.status().unwrap()))?
        .json()
        .await
        .map_err(|_| "Invalid response from Slack.")?;
    if body["ok"] != true {
        return Err(match body["error"].as_str().unwrap_or("unknown_error") {
            "missing_scope" => format!(
                "Add the {} user scope and reinstall the Slack app.",
                body["needed"].as_str().unwrap_or("required")
            ),
            "invalid_auth" | "token_revoked" | "token_expired" => {
                "Reconnect your Slack account in Widget Studio.".into()
            }
            e => format!("Slack: {}", e.replace('_', " ")),
        });
    }
    Ok(body)
}
#[tauri::command]
pub async fn slack_connect(window: tauri::WebviewWindow, token: String) -> Result<Value, String> {
    if window.label() != "settings" {
        return Err("Open Widget Studio to connect Slack.".into());
    }
    let token = token.trim();
    if token.is_empty() {
        crate::vault::set("slack", &store(), String::new())?;
        return Ok(Value::Null);
    }
    if !token.starts_with("xoxp-") && !token.starts_with("xoxe.xoxp-") {
        return Err("Enter a Slack user OAuth token.".into());
    }
    let auth = api(token, "auth.test", vec![], true).await?;
    crate::vault::set(
        "slack",
        &store(),
        json!({"user":auth["user_id"],"token":token}).to_string(),
    )?;
    Ok(
        json!({"team":auth["team"],"teamId":auth["team_id"],"url":auth["url"],"user":auth["user_id"]}),
    )
}
#[tauri::command]
pub async fn slack_feed(kind: String, target: String, cursor: String) -> Result<Value, String> {
    let a = account()?;
    let token = a["token"].as_str().ok_or("Missing Slack token")?;
    let mut args = Vec::new();
    let method = match kind.as_str() {
        "slackmentions" | "slackchannel" | "slackdm" | "slacksearch" => {
            let query = match kind.as_str() {
                "slackmentions" => {
                    format!("<@{}>", a["user"].as_str().ok_or("Missing Slack user")?)
                }
                "slackdm" => "to:me".into(),
                "slackchannel" => format!("in:{target}"),
                _ => target,
            };
            args.extend([
                ("query", query),
                ("sort", "timestamp".into()),
                ("sort_dir", "desc".into()),
                ("count", "12".into()),
            ]);
            "search.messages"
        }
        "slackpins" | "slackbookmarks" => {
            args.push(("channel", target));
            if kind == "slackpins" {
                "pins.list"
            } else {
                "bookmarks.list"
            }
        }
        "slackthread" => {
            let (channel, ts) = target.split_once('|').ok_or("Choose a Slack thread")?;
            args.extend([
                ("channel", channel.into()),
                ("ts", ts.into()),
                ("limit", "15".into()),
            ]);
            "conversations.replies"
        }
        "slackmember" => {
            args.push(("user", target));
            "users.info"
        }
        "slackpeople" => {
            args.push(("limit", "100".into()));
            "users.list"
        }
        "slackstatus" => "users.profile.get",
        "slacksnooze" => "dnd.info",
        _ => return Err("Unknown Slack widget".into()),
    };
    if !cursor.is_empty() {
        args.push(("cursor", cursor))
    }
    let data = api(token, method, args, method == "bookmarks.list").await?;
    if method == "users.info" {
        let u = &data["user"];
        let name = [
            &u["profile"]["display_name"],
            &u["profile"]["real_name"],
            &u["real_name"],
            &u["name"],
        ]
        .into_iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|n| !n.is_empty());
        return Ok(json!({"name":name,"avatar":u["profile"]["image_72"]}));
    }
    Ok(data)
}
#[tauri::command]
pub async fn slack_control(action: String) -> Result<(), String> {
    let a = account()?;
    let token = a["token"].as_str().ok_or("Missing Slack token")?;
    let (method, args) = match action.as_str() {
        "30" | "60" | "120" => ("dnd.setSnooze", vec![("num_minutes", action)]),
        "resume" => ("dnd.endSnooze", vec![]),
        "meeting" | "focus" | "lunch" | "clear" => {
            let (text, emoji, minutes) = match action.as_str() {
                "meeting" => ("In a meeting", ":calendar:", 60),
                "focus" => ("Focusing", ":headphones:", 60),
                "lunch" => ("At lunch", ":sandwich:", 30),
                _ => ("", "", 0),
            };
            let until = if minutes > 0 {
                chrono::Utc::now().timestamp() + minutes * 60
            } else {
                0
            };
            (
                "users.profile.set",
                vec![(
                    "profile",
                    json!({"status_text":text,"status_emoji":emoji,"status_expiration":until})
                        .to_string(),
                )],
            )
        }
        _ => return Err("Unknown Slack action".into()),
    };
    api(token, method, args, true).await.map(|_| ())
}
#[tauri::command]
pub fn slack_open(link: String) -> Result<(), String> {
    let url = Url::parse(&link).map_err(|_| "Invalid link")?;
    let direct_message = url.scheme() == "slack" && url.host_str() == Some("user");
    let web = matches!(url.scheme(), "https" | "http") && url.host_str().is_some();
    let contact = matches!(url.scheme(), "mailto" | "tel") && !url.path().is_empty();
    if !(direct_message || web || contact) || !url.username().is_empty() || url.password().is_some()
    {
        return Err("Unsupported Slack link.".into());
    }
    if std::process::Command::new("/usr/bin/open")
        .arg(url.as_str())
        .status()
        .map_err(|e| e.to_string())?
        .success()
    {
        Ok(())
    } else {
        Err("Could not open link.".into())
    }
}
