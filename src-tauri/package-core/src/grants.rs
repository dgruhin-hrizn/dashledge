//! Everything a package may do, as a set, so an update can list what it adds.
//!
//! The install sheet shows a package's grants in plain language. When a newer version
//! replaces an installed one, `added_grants` names each grant the installed version
//! didn't have, and the Marketplace holds back an automatic update that adds any.
use crate::manifest::Manifest;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// One thing a package may do. `kind` is one of `connections`, `auth`, `connectionType`,
/// `data`, `action`, `connector`, `host`, `command`, `collector`, `image`, `stream` or
/// `permission`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Grant {
    pub kind: String,
    pub value: String,
}

fn grant(kind: &'static str, value: impl Into<String>) -> Grant {
    Grant { kind: kind.into(), value: value.into() }
}

fn json(value: &impl Serialize) -> String {
    serde_json::to_value(value).map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).unwrap_or_default()
}

/// Every grant a manifest declares.
pub fn grants(manifest: &Manifest) -> BTreeSet<Grant> {
    let mut out = BTreeSet::new();
    if let Some(sources) = &manifest.sources {
        out.insert(grant("connections", sources.max.to_string()));
        out.insert(grant("auth", json(&sources.auth)));
        for kind in &sources.types {
            out.insert(grant("connectionType", kind.id.clone()));
            if let Some(auth) = &kind.auth {
                out.insert(grant("auth", format!("{}: {}", kind.id, json(auth))));
            }
        }
    }
    for poll in &manifest.data {
        out.insert(grant("data", poll.path.clone()));
    }
    for action in &manifest.actions {
        out.insert(grant("action", format!("{} {}", json(&action.method), action.path)));
    }
    if let Some(connector) = &manifest.connector {
        out.insert(grant("connector", ""));
        for host in &connector.hosts {
            out.insert(grant("host", host.clone()));
        }
        for command in &connector.commands {
            out.insert(grant("command", command.clone()));
        }
    }
    if let Some(collector) = &manifest.collector {
        out.insert(grant("collector", ""));
        for command in &collector.commands {
            out.insert(grant("command", command.clone()));
        }
    }
    for pattern in &manifest.images {
        out.insert(grant("image", pattern.clone()));
    }
    for stream in &manifest.streams {
        out.insert(grant("stream", format!("{} {}", stream.id, stream.path)));
    }
    for permission in &manifest.permissions {
        out.insert(grant("permission", json(permission)));
    }
    out
}

/// The grants `new` declares that `old` didn't, in a stable order.
pub fn added_grants(old: &Manifest, new: &Manifest) -> Vec<Grant> {
    let before = grants(old);
    grants(new).into_iter().filter(|g| !before.contains(g)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{validate, Origin};
    use serde_json::json;

    fn manifest(extra: serde_json::Value) -> Manifest {
        let mut raw = json!({"apiVersion": 2, "id": "plugin.grants", "title": "Grants", "icon": "i.svg", "view": {"entry": "index.html"},
            "sources": {"min": 1, "max": 1, "auth": {"header": "X-Api-Key"}, "test": ["api/status"]},
            "data": [{"id": "status", "path": "api/status", "every": 10}]});
        for (key, value) in extra.as_object().unwrap() {
            raw[key] = value.clone();
        }
        validate(&raw, Origin::Installed).unwrap()
    }

    #[test]
    fn an_unchanged_package_adds_nothing() {
        let m = manifest(json!({}));
        assert!(added_grants(&m, &m).is_empty());
        let kinds: Vec<_> = grants(&m).into_iter().map(|g| g.kind).collect();
        assert_eq!(kinds, ["auth", "connections", "data"]);
    }

    #[test]
    fn every_kind_of_new_grant_is_named() {
        let old = manifest(json!({}));
        let new = manifest(json!({
            "sources": {"min": 1, "max": 2, "auth": "bearer", "test": ["api/status"],
                        "types": [{"id": "nzbget", "label": "NZBGet", "auth": "basic"}]},
            "actions": [{"id": "pause", "method": "POST", "path": "api/pause"}],
            "connector": {"entry": "connector.js", "hosts": ["https://api.example.com"], "commands": ["search"]},
            "images": ["api/cover/*.jpg"],
            "streams": [{"id": "live", "path": "api/ws"}],
            "permissions": ["images", "stream", "keyboard"]
        }));
        let added: Vec<_> = added_grants(&old, &new).into_iter().map(|g| format!("{}={}", g.kind, g.value)).collect();
        for expected in [
            "connections=2", "auth=bearer", "connectionType=nzbget", "auth=nzbget: basic", "action=POST api/pause",
            "connector=", "host=https://api.example.com", "command=search", "image=api/cover/*.jpg",
            "stream=live api/ws", "permission=images", "permission=stream", "permission=keyboard",
        ] {
            assert!(added.contains(&expected.to_string()), "{expected} missing from {added:?}");
        }
        assert!(!added.iter().any(|g| g.starts_with("data=")), "the unchanged route isn't new");
        assert!(added_grants(&new, &old).iter().all(|g| g.kind == "auth" || g.kind == "connections"),
            "a removed grant is never listed as new");
    }
}
