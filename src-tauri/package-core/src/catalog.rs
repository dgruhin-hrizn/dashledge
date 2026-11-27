//! The Marketplace catalog: what the registry publishes and the app trusts.
//!
//! The registry's CI builds `catalog.json` from the reviewed listings, signs its exact
//! bytes with Ed25519 and publishes it beside the packages, icons and screenshots it
//! names. The app accepts a catalog only when a pinned public key verifies it and its
//! `sequence` is not lower than one it has seen, then checks every download against the
//! sha256 the catalog gives. An expired catalog still pulls the versions it lists as
//! revoked, but offers no installs or updates.
use crate::{archive, grants::{grants, Grant}, manifest::Manifest};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{rand::SystemRandom, signature::{self, Ed25519KeyPair, KeyPair}};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const SCHEMA: u32 = 1;
const MAX_SCREENSHOTS: usize = 4;
const MAX_SCREENSHOT: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema: u32,
    /// Raised by one on every publish. The app refuses a catalog older than one it has seen.
    pub sequence: u64,
    /// Unix seconds.
    pub generated: u64,
    /// Unix seconds. The registry re-signs before this passes.
    pub expires: u64,
    pub plugins: Vec<Plugin>,
    #[serde(default)]
    pub revoked: Vec<Revoked>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub id: String,
    /// The GitHub account that owns the `plugin.<publisher>.` namespace.
    pub publisher: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    pub icon: Asset,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screenshots: Vec<Asset>,
    /// Newest first.
    pub versions: Vec<Version>,
}

/// A file published beside the catalog, by path relative to the catalog's folder.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Asset {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub version: String,
    pub path: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
    pub tier: String,
    pub grants: Vec<Grant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// Unix seconds when this version first appeared in the catalog.
    pub published: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Revoked {
    pub id: String,
    pub version: String,
    pub reason: String,
}

impl Catalog {
    pub fn expired(&self, now: u64) -> bool {
        now >= self.expires
    }

    pub fn plugin(&self, id: &str) -> Option<&Plugin> {
        self.plugins.iter().find(|p| p.id == id)
    }

    pub fn revoked(&self, id: &str, version: &str) -> Option<&Revoked> {
        self.revoked.iter().find(|r| r.id == id && r.version == version)
    }
}

/// One reviewed version, as an author submits it in `listings/<id>/<version>.json`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Listing {
    pub id: String,
    pub version: String,
    /// The author's GitHub login.
    pub publisher: String,
    pub source: Source,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Image files beside the listing, shown on the plugin's Marketplace page.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screenshots: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Where CI downloads the package: an asset of a release in the author's repository.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub repo: String,
    pub tag: String,
    pub asset: String,
}

impl Source {
    pub fn url(&self) -> String {
        format!("https://github.com/{}/releases/download/{}/{}", self.repo, self.tag, self.asset)
    }
}

/// A listing with the package bytes CI downloaded and the screenshot files beside it.
pub struct Submitted {
    pub listing: Listing,
    pub package: Vec<u8>,
    pub screenshots: BTreeMap<String, Vec<u8>>,
}

pub struct Build {
    pub submitted: Vec<Submitted>,
    pub previous: Option<Catalog>,
    pub revoked: Vec<Revoked>,
    /// Logins allowed to publish under `plugin.dashledge.`.
    pub maintainers: Vec<String>,
    pub now: u64,
    /// Seconds a catalog stays valid.
    pub lifetime: u64,
}

/// The signed catalog's contents and every file to publish beside it, by path.
#[derive(Debug)]
pub struct Built {
    pub catalog: Catalog,
    pub files: BTreeMap<String, Vec<u8>>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn semver(version: &str) -> Option<semver::Version> {
    semver::Version::parse(version).ok().filter(|v| v.build.is_empty())
}

fn login(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 39
        && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else {
        None
    }
}

/// Check one listing against its package and the namespace rules, with the same
/// validator the app runs. Returns the package's manifest.
pub fn check_listing(listing: &Listing, package: &[u8], maintainers: &[String]) -> Result<Manifest, String> {
    let at = format!("{} {}", listing.id, listing.version);
    if !login(&listing.publisher) {
        return Err(format!("{at}: publisher must be a GitHub login in lowercase."));
    }
    let namespace = if listing.id.starts_with("plugin.dashledge.") {
        if !maintainers.contains(&listing.publisher) {
            return Err(format!("{at}: only Dashledge maintainers publish under plugin.dashledge."));
        }
        "plugin.dashledge.".to_string()
    } else {
        format!("plugin.{}.", listing.publisher)
    };
    if !listing.id.strip_prefix(&namespace).is_some_and(|name| !name.is_empty()) {
        return Err(format!("{at}: the ID must be {namespace}<name>, in the publisher's namespace."));
    }
    if semver(&listing.version).is_none() {
        return Err(format!("{at}: version must be major.minor.patch, such as 1.2.0."));
    }
    if listing.summary.as_ref().is_some_and(|s| s.trim().is_empty() || s.chars().count() > 140) {
        return Err(format!("{at}: summary must be 1–140 characters."));
    }
    if listing.notes.as_ref().is_some_and(|s| s.chars().count() > 1000) {
        return Err(format!("{at}: notes must be up to 1000 characters."));
    }
    if listing.screenshots.len() > MAX_SCREENSHOTS {
        return Err(format!("{at}: list at most {MAX_SCREENSHOTS} screenshots."));
    }
    if sha256_hex(package) != listing.sha256.to_ascii_lowercase() {
        return Err(format!("{at}: the downloaded package doesn't match sha256 {}.", listing.sha256));
    }
    let (raw, files) = archive::extract(package).map_err(|e| format!("{at}: {e}"))?;
    let manifest = archive::check(&raw, &files).map_err(|e| format!("{at}: {e}"))?;
    if manifest.id != listing.id || manifest.version.as_deref() != Some(listing.version.as_str()) {
        return Err(format!("{at}: widget.json says {} {}.", manifest.id, manifest.version.as_deref().unwrap_or("(no version)")));
    }
    if archive::icon_data(&manifest.icon, &files[&manifest.icon]).is_none() {
        return Err(format!("{at}: the icon must be a PNG or SVG up to 256 KiB."));
    }
    Ok(manifest)
}

/// Check every listing and assemble the catalog that follows `previous`. A version
/// already published must keep its sha256 and stay listed; pull one with `revoked`.
pub fn build(input: Build) -> Result<Built, String> {
    let previous = input.previous.as_ref();
    let mut files = BTreeMap::new();
    let mut by_id: BTreeMap<String, Vec<(semver::Version, Submitted, Manifest)>> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for submitted in input.submitted {
        let listing = &submitted.listing;
        let manifest = check_listing(listing, &submitted.package, &input.maintainers)?;
        if !seen.insert((listing.id.clone(), listing.version.clone())) {
            return Err(format!("{} {} is listed twice.", listing.id, listing.version));
        }
        let published = previous.and_then(|c| c.plugin(&listing.id)).and_then(|p| p.versions.iter().find(|v| v.version == listing.version));
        if published.is_some_and(|v| v.sha256 != listing.sha256.to_ascii_lowercase()) {
            return Err(format!("{} {} is already published with another package. Publish a new version.", listing.id, listing.version));
        }
        let version = semver(&listing.version).expect("checked");
        by_id.entry(listing.id.clone()).or_default().push((version, submitted, manifest));
    }
    if let Some(previous) = previous {
        for plugin in &previous.plugins {
            for version in &plugin.versions {
                if !seen.contains(&(plugin.id.clone(), version.version.clone())) {
                    return Err(format!("{} {} was published and its listing is gone. Pull it with revoked.json instead.", plugin.id, version.version));
                }
            }
        }
    }
    let mut plugins = Vec::new();
    for (id, mut versions) in by_id {
        versions.sort_by(|a, b| b.0.cmp(&a.0));
        let publishers: BTreeSet<_> = versions.iter().map(|(_, s, _)| s.listing.publisher.clone()).collect();
        if publishers.len() > 1 {
            return Err(format!("{id} is listed by more than one publisher."));
        }
        let (_, newest, manifest) = &versions[0];
        let (_, files_in) = archive::extract(&newest.package)?;
        let icon_bytes = &files_in[&manifest.icon];
        let icon_ext = if icon_bytes.starts_with(b"\x89PNG") { "png" } else { "svg" };
        let icon = Asset { path: format!("icons/{id}/{}.{icon_ext}", newest.listing.version), sha256: sha256_hex(icon_bytes) };
        files.insert(icon.path.clone(), icon_bytes.clone());
        let mut screenshots = Vec::new();
        for (index, name) in newest.listing.screenshots.iter().enumerate() {
            let bytes = newest.screenshots.get(name).ok_or_else(|| format!("{id}: screenshot {name} is missing."))?;
            let ext = image_kind(bytes).filter(|_| bytes.len() <= MAX_SCREENSHOT)
                .ok_or_else(|| format!("{id}: screenshot {name} must be a PNG or JPEG up to 1 MiB."))?;
            let asset = Asset { path: format!("screenshots/{id}/{}-{}.{ext}", newest.listing.version, index + 1), sha256: sha256_hex(bytes) };
            files.insert(asset.path.clone(), bytes.clone());
            screenshots.push(asset);
        }
        let mut list = Vec::new();
        for (_, submitted, manifest) in &versions {
            let listing = &submitted.listing;
            let path = format!("packages/{id}/{}.zip", listing.version);
            files.insert(path.clone(), submitted.package.clone());
            let published = previous
                .and_then(|c| c.plugin(&id))
                .and_then(|p| p.versions.iter().find(|v| v.version == listing.version))
                .map_or(input.now, |v| v.published);
            list.push(Version {
                version: listing.version.clone(),
                path,
                sha256: listing.sha256.to_ascii_lowercase(),
                size: submitted.package.len() as u64,
                min_app_version: manifest.min_app_version.clone(),
                tier: serde_json::to_value(manifest.tier()).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
                grants: grants(manifest).into_iter().collect(),
                notes: listing.notes.clone(),
                published,
            });
        }
        plugins.push(Plugin {
            id: id.clone(),
            publisher: newest.listing.publisher.clone(),
            title: manifest.title.clone(),
            summary: newest.listing.summary.clone().or_else(|| manifest.description.clone()),
            category: manifest.category.clone(),
            homepage: manifest.homepage.clone(),
            license: manifest.license.clone(),
            icon,
            screenshots,
            versions: list,
        });
    }
    for revoked in &input.revoked {
        let known = plugins.iter().any(|p| p.id == revoked.id && p.versions.iter().any(|v| v.version == revoked.version));
        if !known || revoked.reason.trim().is_empty() {
            return Err(format!("revoked.json: {} {} must name a published version and give a reason.", revoked.id, revoked.version));
        }
    }
    let catalog = Catalog {
        schema: SCHEMA,
        sequence: previous.map_or(1, |c| c.sequence + 1),
        generated: input.now,
        expires: input.now + input.lifetime,
        plugins,
        revoked: input.revoked,
    };
    Ok(Built { catalog, files })
}

/// A new Ed25519 key: the PKCS#8 private key to keep secret, and the base64 public key
/// the app pins.
pub fn generate_key() -> Result<(Vec<u8>, String), String> {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).map_err(|_| "Could not generate a key.")?;
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).map_err(|_| "Could not read the new key.")?;
    Ok((pkcs8.as_ref().to_vec(), STANDARD.encode(pair.public_key().as_ref())))
}

pub fn public_key(pkcs8: &[u8]) -> Result<String, String> {
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8).map_err(|_| "That isn't an Ed25519 PKCS#8 key.")?;
    Ok(STANDARD.encode(pair.public_key().as_ref()))
}

/// The base64 signature of `bytes`.
pub fn sign(bytes: &[u8], pkcs8: &[u8]) -> Result<String, String> {
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8).map_err(|_| "That isn't an Ed25519 PKCS#8 key.")?;
    Ok(STANDARD.encode(pair.sign(bytes).as_ref()))
}

/// Accept `bytes` as a catalog only if one of `keys` (base64 public keys) signed them and
/// its sequence is at least `min_sequence`.
pub fn verify(bytes: &[u8], signature_b64: &str, keys: &[&str], min_sequence: u64) -> Result<Catalog, String> {
    let sig = STANDARD.decode(signature_b64.trim()).map_err(|_| "The catalog signature isn't valid.")?;
    let trusted = keys.iter().filter_map(|k| STANDARD.decode(k).ok()).any(|key| {
        signature::UnparsedPublicKey::new(&signature::ED25519, key).verify(bytes, &sig).is_ok()
    });
    if !trusted {
        return Err("The Marketplace catalog isn't signed by Dashledge's registry.".into());
    }
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|e| format!("The Marketplace catalog can't be read: {e}"))?;
    if catalog.schema != SCHEMA {
        return Err("This Marketplace catalog needs a newer Dashledge.".into());
    }
    if catalog.sequence < min_sequence {
        return Err("The Marketplace catalog is older than one this Mac has already seen.".into());
    }
    Ok(catalog)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::{write::FileOptions, ZipWriter};

    pub const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10\0\0\0\x10";

    pub fn package(id: &str, version: &str, extra: serde_json::Value) -> Vec<u8> {
        let mut manifest = serde_json::json!({"apiVersion": 2, "id": id, "title": "Queue", "version": version,
            "description": "Downloads now.", "icon": "icon.png", "view": {"entry": "index.html"}});
        manifest.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in [("widget.json", manifest.to_string().into_bytes()), ("icon.png", PNG.to_vec()), ("index.html", b"<!doctype html>".to_vec()), ("connector.js", b"//".to_vec())] {
            zip.start_file(name, FileOptions::default()).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    pub fn submitted(id: &str, version: &str, publisher: &str, extra: serde_json::Value) -> Submitted {
        let package = package(id, version, extra);
        Submitted {
            listing: Listing {
                id: id.into(), version: version.into(), publisher: publisher.into(),
                source: Source { repo: format!("{publisher}/queue"), tag: format!("v{version}"), asset: "queue.zip".into() },
                sha256: sha256_hex(&package), summary: None, screenshots: vec![], notes: None,
            },
            package,
            screenshots: BTreeMap::new(),
        }
    }

    fn build_of(submitted: Vec<Submitted>, previous: Option<Catalog>) -> Result<Built, String> {
        build(Build { submitted, previous, revoked: vec![], maintainers: vec!["dgruhin-hrizn".into()], now: 1_000, lifetime: 100 })
    }

    #[test]
    fn a_build_lists_versions_newest_first_with_assets_and_grants() {
        let mut first = submitted("plugin.alice.queue", "1.0.0", "alice", serde_json::json!({}));
        first.listing.screenshots = vec!["shot.png".into()];
        first.screenshots.insert("shot.png".into(), PNG.to_vec());
        let second = submitted("plugin.alice.queue", "1.10.0", "alice", serde_json::json!({"homepage": "https://example.com", "license": "MIT",
            "connector": {"entry": "connector.js", "hosts": ["https://api.example.com"]}}));
        let built = build_of(vec![first, second], None).unwrap();
        let c = &built.catalog;
        assert_eq!((c.schema, c.sequence, c.generated, c.expires), (1, 1, 1_000, 1_100));
        let plugin = c.plugin("plugin.alice.queue").unwrap();
        assert_eq!(plugin.versions.iter().map(|v| v.version.as_str()).collect::<Vec<_>>(), ["1.10.0", "1.0.0"]);
        assert_eq!(plugin.homepage.as_deref(), Some("https://example.com"));
        assert_eq!(plugin.summary.as_deref(), Some("Downloads now."));
        assert_eq!(plugin.versions[0].tier, "connector");
        assert!(plugin.versions[0].grants.iter().any(|g| g.kind == "host"));
        assert!(plugin.screenshots.is_empty(), "screenshots come from the newest version's listing");
        for path in ["packages/plugin.alice.queue/1.0.0.zip", "packages/plugin.alice.queue/1.10.0.zip", "icons/plugin.alice.queue/1.10.0.png"] {
            assert!(built.files.contains_key(path), "{path}");
        }
        assert_eq!(plugin.icon.sha256, sha256_hex(PNG));
    }

    #[test]
    fn listings_outside_their_namespace_or_with_a_wrong_package_are_refused() {
        let cases = [
            (submitted("plugin.bob.queue", "1.0.0", "alice", serde_json::json!({})), "namespace"),
            (submitted("plugin.dashledge.queue", "1.0.0", "alice", serde_json::json!({})), "maintainers"),
            (submitted("plugin.alice.queue", "1.0", "alice", serde_json::json!({})), "major.minor.patch"),
            (submitted("plugin.alice.queue", "1.0.0", "Alice", serde_json::json!({})), "lowercase"),
        ];
        for (s, expected) in cases {
            let err = build_of(vec![s], None).err().expect(expected);
            assert!(err.contains(expected), "{err}");
        }
        let mut tampered = submitted("plugin.alice.queue", "1.0.0", "alice", serde_json::json!({}));
        tampered.listing.sha256 = sha256_hex(b"other");
        assert!(build_of(vec![tampered], None).unwrap_err().contains("doesn't match"));
        let mut mismatched = submitted("plugin.alice.queue", "1.0.0", "alice", serde_json::json!({}));
        mismatched.listing.version = "2.0.0".into();
        assert!(build_of(vec![mismatched], None).unwrap_err().contains("widget.json says"));
        assert!(build_of(vec![submitted("plugin.dashledge.queue", "1.0.0", "dgruhin-hrizn", serde_json::json!({}))], None).is_ok());
    }

    #[test]
    fn published_versions_keep_their_package_and_date_and_never_disappear() {
        let first = build_of(vec![submitted("plugin.alice.queue", "1.0.0", "alice", serde_json::json!({}))], None).unwrap().catalog;
        let next = build(Build {
            submitted: vec![submitted("plugin.alice.queue", "1.0.0", "alice", serde_json::json!({})),
                            submitted("plugin.alice.queue", "1.1.0", "alice", serde_json::json!({}))],
            previous: Some(first.clone()), revoked: vec![], maintainers: vec![], now: 2_000, lifetime: 100,
        }).unwrap().catalog;
        assert_eq!(next.sequence, 2);
        let versions = &next.plugin("plugin.alice.queue").unwrap().versions;
        assert_eq!((versions[0].published, versions[1].published), (2_000, 1_000));
        let changed = submitted("plugin.alice.queue", "1.0.0", "alice", serde_json::json!({"description": "Changed."}));
        assert!(build_of(vec![changed], Some(first.clone())).unwrap_err().contains("already published"));
        let other = submitted("plugin.alice.other", "1.0.0", "alice", serde_json::json!({}));
        assert!(build_of(vec![other], Some(first)).unwrap_err().contains("listing is gone"));
    }

    #[test]
    fn revocations_name_a_published_version_with_a_reason() {
        let s = || vec![submitted("plugin.alice.queue", "1.0.0", "alice", serde_json::json!({}))];
        let revoke = |version: &str, reason: &str| vec![Revoked { id: "plugin.alice.queue".into(), version: version.into(), reason: reason.into() }];
        let ok = build(Build { submitted: s(), previous: None, revoked: revoke("1.0.0", "Sends data to an undeclared host."), maintainers: vec![], now: 0, lifetime: 1 }).unwrap();
        assert!(ok.catalog.revoked("plugin.alice.queue", "1.0.0").is_some());
        assert!(build(Build { submitted: s(), previous: None, revoked: revoke("9.0.0", "x"), maintainers: vec![], now: 0, lifetime: 1 }).is_err());
        assert!(build(Build { submitted: s(), previous: None, revoked: revoke("1.0.0", " "), maintainers: vec![], now: 0, lifetime: 1 }).is_err());
    }

    #[test]
    fn only_a_pinned_key_and_a_current_sequence_are_trusted() {
        let (key, public) = generate_key().unwrap();
        assert_eq!(public_key(&key).unwrap(), public);
        let (other, other_public) = generate_key().unwrap();
        let catalog = build_of(vec![submitted("plugin.alice.queue", "1.0.0", "alice", serde_json::json!({}))], None).unwrap().catalog;
        let bytes = serde_json::to_vec(&catalog).unwrap();
        let sig = sign(&bytes, &key).unwrap();
        assert_eq!(verify(&bytes, &sig, &[&other_public, &public], 1).unwrap(), catalog, "any pinned key may sign, for rotation");
        assert!(verify(&bytes, &sig, &[&other_public], 0).unwrap_err().contains("isn't signed"));
        assert!(verify(&bytes, &sign(&bytes, &other).unwrap(), &[&public], 0).is_err());
        let mut tampered = bytes.clone();
        *tampered.last_mut().unwrap() = b' ';
        assert!(verify(&tampered, &sig, &[&public], 0).is_err(), "a changed byte breaks the signature");
        assert!(verify(&bytes, &sig, &[&public], 2).unwrap_err().contains("older"));
        assert!(verify(&bytes, "not base64!", &[&public], 0).is_err());
        assert!(catalog.expired(1_100) && !catalog.expired(1_099));
    }
}
