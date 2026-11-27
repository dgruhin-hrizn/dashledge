//! `dashledge-package`: check widget packages and build the signed Marketplace catalog
//! with the same rules the Dashledge app applies.
//!
//! ```text
//! dashledge-package pack <folder> --out <package.zip>
//! dashledge-package check <package.zip>
//! dashledge-package check-listing <listings/<id>/<version>.json> <package.zip> [--maintainers a,b]
//! dashledge-package keygen --out <private.key>
//! dashledge-package public-key --key <private.key>
//! dashledge-package sign <catalog.json> --key <private.key>
//! dashledge-package verify <catalog.json> --public-key <base64>
//! dashledge-package sources --listings <dir>
//! dashledge-package catalog --listings <dir> --packages <dir> --out <dir>
//!     [--previous <catalog.json>] [--revoked <revoked.json>] [--maintainers a,b] [--lifetime-days 30]
//! ```
use dashledge_package_core::{
    archive,
    catalog::{self, Build, Listing, Revoked, Submitted},
    grants::grants,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::ExitCode,
    time::{SystemTime, UNIX_EPOCH},
};

const USAGE: &str = "usage: dashledge-package <pack|check|check-listing|keygen|public-key|sign|verify|sources|catalog> …\nSee the comment at the top of src/bin/dashledge-package.rs.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(output) => {
            if !output.is_empty() {
                println!("{output}");
            }
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

/// Positional arguments and `--name value` options.
struct Args {
    positional: Vec<String>,
    options: BTreeMap<String, String>,
}

fn parse(args: &[String]) -> Result<Args, String> {
    let mut positional = Vec::new();
    let mut options = BTreeMap::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if let Some(name) = arg.strip_prefix("--") {
            let value = it.next().ok_or(format!("--{name} needs a value"))?;
            options.insert(name.to_string(), value.clone());
        } else {
            positional.push(arg.clone());
        }
    }
    Ok(Args { positional, options })
}

impl Args {
    fn arg(&self, index: usize, what: &str) -> Result<&str, String> {
        self.positional.get(index).map(String::as_str).ok_or(format!("Name the {what}.\n{USAGE}"))
    }
    fn option(&self, name: &str) -> Result<&str, String> {
        self.options.get(name).map(String::as_str).ok_or(format!("Pass --{name}.\n{USAGE}"))
    }
    fn list(&self, name: &str) -> Vec<String> {
        self.options.get(name).map_or_else(Vec::new, |v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
    }
}

fn read(path: impl AsRef<Path>) -> Result<Vec<u8>, String> {
    let path = path.as_ref();
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Private keys are stored as one line of base64 so they fit a CI secret.
fn base64_text(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(bytes) + "\n"
}

/// A private key file: base64 text from `keygen`, or raw PKCS#8 bytes.
fn read_key(path: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = read(path)?;
    Ok(std::str::from_utf8(&bytes).ok().and_then(|text| STANDARD.decode(text.trim()).ok()).unwrap_or(bytes))
}

fn read_json<T: serde::de::DeserializeOwned>(path: impl AsRef<Path>) -> Result<T, String> {
    let path = path.as_ref();
    serde_json::from_slice(&read(path)?).map_err(|e| format!("{}: {e}", path.display()))
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn run(args: &[String]) -> Result<String, String> {
    let Some((command, rest)) = args.split_first() else { return Err(USAGE.into()) };
    let a = parse(rest)?;
    match command.as_str() {
        "pack" => {
            // The same files, rules and bytes as Submit to Marketplace in Widget Studio.
            let (raw, files) = archive::read_folder(Path::new(a.arg(0, "package folder")?))?;
            archive::check(&raw, &files)?;
            let bytes = archive::pack(&files)?;
            write(Path::new(a.option("out")?), &bytes)?;
            check(&bytes)
        }
        "check" => check(&read(a.arg(0, "package ZIP")?)?),
        "check-listing" => {
            let listing: Listing = read_json(a.arg(0, "listing JSON")?)?;
            let package = read(a.arg(1, "package ZIP")?)?;
            let manifest = catalog::check_listing(&listing, &package, &a.list("maintainers"))?;
            let mut summary = format!("## {} {}\n\nPublisher: {}  \nTier: {}  \nsha256: `{}`\n\n### Grants\n\n",
                listing.id, listing.version, listing.publisher,
                serde_json::to_value(manifest.tier()).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
                catalog::sha256_hex(&package));
            for grant in grants(&manifest) {
                summary.push_str(&format!("- **{}** {}\n", grant.kind, grant.value));
            }
            Ok(summary)
        }
        "keygen" => {
            let out = PathBuf::from(a.option("out")?);
            if out.exists() {
                return Err(format!("{} exists. Choose a new path; a key is never overwritten.", out.display()));
            }
            let (private, public) = catalog::generate_key()?;
            if let Some(parent) = out.parent().filter(|p| !p.as_os_str().is_empty()) {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut file = open_private(&out)?;
            file.write_all(base64_text(&private).as_bytes()).map_err(|e| e.to_string())?;
            Ok(format!("Private key written to {} (keep it secret).\nPublic key: {public}", out.display()))
        }
        "public-key" => catalog::public_key(&read_key(a.option("key")?)?),
        "sign" => {
            let path = a.arg(0, "file to sign")?;
            let signature = catalog::sign(&read(path)?, &read_key(a.option("key")?)?)?;
            let out = format!("{path}.sig");
            write(Path::new(&out), signature.as_bytes())?;
            Ok(format!("Signed {path} → {out}"))
        }
        "verify" => {
            let path = a.arg(0, "catalog JSON")?;
            let signature = String::from_utf8(read(format!("{path}.sig"))?).map_err(|e| e.to_string())?;
            let c = catalog::verify(&read(path)?, &signature, &[a.option("public-key")?], 0)?;
            Ok(format!("Valid: sequence {}, {} plugins, expires {}.", c.sequence, c.plugins.len(), c.expires))
        }
        "sources" => {
            let mut lines = Vec::new();
            for (_, listing) in listings(Path::new(a.option("listings")?))? {
                lines.push(format!("{} {} {} {}", listing.id, listing.version, listing.source.url(), listing.sha256));
            }
            Ok(lines.join("\n"))
        }
        "catalog" => build_catalog(&a),
        _ => Err(USAGE.into()),
    }
}

#[cfg(unix)]
fn open_private(path: &Path) -> Result<fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(not(unix))]
fn open_private(path: &Path) -> Result<fs::File, String> {
    fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn check(package: &[u8]) -> Result<String, String> {
    let (raw, files) = archive::extract(package)?;
    let manifest = archive::check(&raw, &files)?;
    Ok(pretty(&json!({
        "id": manifest.id,
        "title": manifest.title,
        "version": manifest.version,
        "minAppVersion": manifest.min_app_version,
        "tier": manifest.tier(),
        "sha256": catalog::sha256_hex(package),
        "size": package.len(),
        "grants": grants(&manifest),
    })))
}

/// Every `listings/<id>/<version>.json`, with the folder it sits in.
fn listings(root: &Path) -> Result<Vec<(PathBuf, Listing)>, String> {
    let mut out = Vec::new();
    let mut folders: Vec<_> = fs::read_dir(root).map_err(|e| format!("{}: {e}", root.display()))?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    folders.sort();
    for folder in folders {
        let mut files: Vec<_> = fs::read_dir(&folder).map_err(|e| e.to_string())?.flatten().map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json")).collect();
        files.sort();
        for file in files {
            let listing: Listing = read_json(&file)?;
            let id = folder.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            let stem = file.file_stem().and_then(|n| n.to_str()).unwrap_or_default();
            if listing.id != id || listing.version != stem {
                return Err(format!("{}: its id and version must match its path, listings/{}/{}.json.", file.display(), listing.id, listing.version));
            }
            out.push((folder.clone(), listing));
        }
    }
    Ok(out)
}

fn build_catalog(a: &Args) -> Result<String, String> {
    let packages = PathBuf::from(a.option("packages")?);
    let mut submitted = Vec::new();
    for (folder, listing) in listings(Path::new(a.option("listings")?))? {
        let package = read(packages.join(&listing.id).join(format!("{}.zip", listing.version)))?;
        let mut screenshots = BTreeMap::new();
        for name in &listing.screenshots {
            if name.contains('/') || name.contains('\\') || name.starts_with('.') {
                return Err(format!("{} {}: name screenshots that sit beside the listing.", listing.id, listing.version));
            }
            screenshots.insert(name.clone(), read(folder.join(name))?);
        }
        submitted.push(Submitted { listing, package, screenshots });
    }
    let previous = a.options.get("previous").map(read_json).transpose()?;
    let revoked: Vec<Revoked> = a.options.get("revoked").map(read_json).transpose()?.unwrap_or_default();
    let days: u64 = a.options.get("lifetime-days").map_or(Ok(30), |d| d.parse().map_err(|_| "--lifetime-days takes a number"))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let built = catalog::build(Build { submitted, previous, revoked, maintainers: a.list("maintainers"), now, lifetime: days * 86_400 })?;
    let out = PathBuf::from(a.option("out")?);
    for (path, bytes) in &built.files {
        write(&out.join(path), bytes)?;
    }
    let bytes = serde_json::to_vec_pretty(&built.catalog).map_err(|e| e.to_string())?;
    write(&out.join("catalog.json"), &bytes)?;
    Ok(format!("Wrote catalog sequence {} with {} plugins to {}. Sign catalog.json next.",
        built.catalog.sequence, built.catalog.plugins.len(), out.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pack_makes_the_same_package_from_a_folder_every_time() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (_, files) = archive::extract(&catalog::fixtures::package("plugin.alice.queue", "1.0.0", json!({}))).unwrap();
        for (name, bytes) in &files {
            write(&root.join("queue").join(name), bytes).unwrap();
        }
        for junk in [".DS_Store", ".git/config", "node_modules/left-pad/index.js", "build.sh"] {
            write(&root.join("queue").join(junk), b"junk").unwrap();
        }
        let p = |s: &str| root.join(s).to_string_lossy().into_owned();
        let packed = run(&strings(&["pack", &p("queue"), "--out", &p("out/queue-1.0.0.zip")])).unwrap();
        assert!(packed.contains("\"id\": \"plugin.alice.queue\""), "{packed}");
        let first = read(p("out/queue-1.0.0.zip")).unwrap();
        let (_, read_back) = archive::extract(&first).unwrap();
        assert_eq!(read_back, files, "hidden files, node_modules and other file types stay out");
        run(&strings(&["pack", &p("queue"), "--out", &p("out/again.zip")])).unwrap();
        assert_eq!(read(p("out/again.zip")).unwrap(), first, "the same bytes every time");
        assert!(packed.contains(&catalog::sha256_hex(&first)));

        fs::remove_file(root.join("queue/widget.json")).unwrap();
        assert!(run(&strings(&["pack", &p("queue"), "--out", &p("out/none.zip")])).unwrap_err().contains("widget.json"));
        #[cfg(unix)]
        {
            write(&root.join("queue/widget.json"), &files["widget.json"]).unwrap();
            std::os::unix::fs::symlink("/etc/hosts", root.join("queue/hosts.txt")).unwrap();
            assert!(run(&strings(&["pack", &p("queue"), "--out", &p("out/link.zip")])).unwrap_err().contains("link"));
        }
    }

    #[test]
    fn a_registry_round_trip_builds_signs_and_verifies() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let package = catalog::fixtures::package("plugin.alice.queue", "1.0.0", json!({}));
        write(&root.join("packages/plugin.alice.queue/1.0.0.zip"), &package).unwrap();
        let listing = json!({"id": "plugin.alice.queue", "version": "1.0.0", "publisher": "alice",
            "source": {"repo": "alice/queue", "tag": "v1.0.0", "asset": "queue.zip"},
            "sha256": catalog::sha256_hex(&package), "screenshots": ["shot.png"]});
        write(&root.join("listings/plugin.alice.queue/1.0.0.json"), listing.to_string().as_bytes()).unwrap();
        write(&root.join("listings/plugin.alice.queue/shot.png"), catalog::fixtures::PNG).unwrap();
        let p = |s: &str| root.join(s).to_string_lossy().into_owned();

        let checked = run(&strings(&["check", &p("packages/plugin.alice.queue/1.0.0.zip")])).unwrap();
        assert!(checked.contains("\"id\": \"plugin.alice.queue\""), "{checked}");
        let summary = run(&strings(&["check-listing", &p("listings/plugin.alice.queue/1.0.0.json"), &p("packages/plugin.alice.queue/1.0.0.zip")])).unwrap();
        assert!(summary.starts_with("## plugin.alice.queue 1.0.0"), "{summary}");
        let sources = run(&strings(&["sources", "--listings", &p("listings")])).unwrap();
        assert!(sources.contains("https://github.com/alice/queue/releases/download/v1.0.0/queue.zip"));

        let keygen = run(&strings(&["keygen", "--out", &p("keys/catalog.key")])).unwrap();
        let public = keygen.rsplit("Public key: ").next().unwrap().trim().to_string();
        assert!(run(&strings(&["keygen", "--out", &p("keys/catalog.key")])).is_err(), "a key is never overwritten");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(p("keys/catalog.key")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(run(&strings(&["public-key", "--key", &p("keys/catalog.key")])).unwrap(), public);

        let built = run(&strings(&["catalog", "--listings", &p("listings"), "--packages", &p("packages"), "--out", &p("site/v1")])).unwrap();
        assert!(built.contains("sequence 1 with 1 plugins"), "{built}");
        for file in ["site/v1/catalog.json", "site/v1/packages/plugin.alice.queue/1.0.0.zip", "site/v1/icons/plugin.alice.queue/1.0.0.png", "site/v1/screenshots/plugin.alice.queue/1.0.0-1.png"] {
            assert!(root.join(file).is_file(), "{file}");
        }
        run(&strings(&["sign", &p("site/v1/catalog.json"), "--key", &p("keys/catalog.key")])).unwrap();
        let verified = run(&strings(&["verify", &p("site/v1/catalog.json"), "--public-key", &public])).unwrap();
        assert!(verified.starts_with("Valid: sequence 1, 1 plugins"), "{verified}");

        let next = run(&strings(&["catalog", "--listings", &p("listings"), "--packages", &p("packages"), "--out", &p("site2/v1"), "--previous", &p("site/v1/catalog.json")])).unwrap();
        assert!(next.contains("sequence 2"), "{next}");
        write(&root.join("listings/plugin.alice.queue/2.0.0.json"), listing.to_string().as_bytes()).unwrap();
        assert!(run(&strings(&["sources", "--listings", &p("listings")])).unwrap_err().contains("must match its path"));
    }
}
