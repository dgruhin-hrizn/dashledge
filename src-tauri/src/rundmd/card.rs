// B134 layout described in Pwedge/RunDMD-Utils, RunDmdImage.py.
use serde::Serialize;
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};

const SECTOR: u64 = 512;
const DIRECTORY: u64 = 0xc800;
const BITMAP: usize = 128 * 32 / 2;
fn invalid(s: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, s)
}
#[derive(Serialize)]
pub struct Clip {
    pub name: String,
    pub enabled: bool,
    #[serde(skip)]
    offset: u64,
    #[serde(skip)]
    bitmaps: u8,
    #[serde(skip)]
    frames: u8,
    #[serde(skip)]
    clock: [u8; 8],
}
#[derive(Serialize)]
pub struct Catalog {
    pub version: String,
    pub clips: Vec<Clip>,
}
pub struct Card {
    pub file: File,
    pub catalog: Catalog,
    pub used_bytes: u64,
}
fn ascii(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes.split(|b| *b == 0).next().unwrap_or_default())
        .trim()
        .to_string()
}
impl Card {
    pub fn open(mut file: File) -> io::Result<Self> {
        let file_len = file.metadata()?.len();
        file.rewind()?;
        let mut h = [0; 512];
        file.read_exact(&mut h)?;
        if &h[..3] != b"DGD" {
            return Err(invalid("Choose a Run-DMD card image with a DGD header."));
        }
        let count = u16::from_be_bytes([h[3], h[4]]) as usize;
        let version = ascii(&h[495..499]);
        let directory_end = DIRECTORY + count as u64 * SECTOR;
        if count == 0 || directory_end > file_len {
            return Err(invalid("Incomplete Run-DMD directory."));
        }
        file.seek(SeekFrom::Start(DIRECTORY))?;
        let mut clips = Vec::with_capacity(count);
        let mut used_bytes = directory_end;
        for _ in 0..count {
            file.read_exact(&mut h)?;
            let offset = u32::from_be_bytes(h[4..8].try_into().unwrap()) as u64 * SECTOR;
            let bitmaps = h[3];
            let end = offset + SECTOR + bitmaps as u64 * BITMAP as u64;
            // Some B134 headers describe the moving artwork bounds; bitmap stride is always 128.
            if offset < directory_end || end > 2 << 30 || end > file_len || h[8] == 0 {
                return Err(invalid(
                    "Unsupported or truncated Run-DMD animation directory.",
                ));
            }
            used_bytes = used_bytes.max(end);
            clips.push(Clip {
                name: ascii(&h[20..52]),
                enabled: h[2] & 1 != 0,
                offset,
                bitmaps,
                frames: h[8],
                clock: h[11..19].try_into().unwrap(),
            });
        }
        let mut map = [0; 512];
        for clip in &clips {
            file.seek(SeekFrom::Start(clip.offset))?;
            file.read_exact(&mut map)?;
            if map[..clip.frames as usize * 2]
                .chunks_exact(2)
                .any(|f| f[0] > clip.bitmaps)
            {
                return Err(invalid("Run-DMD frame references a missing bitmap."));
            }
        }
        Ok(Self {
            file,
            catalog: Catalog { version, clips },
            used_bytes,
        })
    }

    // Wire layout: 8 clock/transition bytes, frame count, (bitmap, delay) pairs, packed bitmaps.
    pub fn clip(&mut self, index: usize) -> io::Result<Vec<u8>> {
        let clip = self
            .catalog
            .clips
            .get(index)
            .ok_or_else(|| invalid("Unknown Run-DMD animation."))?;
        self.file.seek(SeekFrom::Start(clip.offset))?;
        let mut map = [0; 512];
        self.file.read_exact(&mut map)?;
        let mut data = clip.clock.to_vec();
        data.push(clip.frames);
        data.extend_from_slice(&map[..clip.frames as usize * 2]);
        let start = data.len();
        data.resize(start + clip.bitmaps as usize * BITMAP, 0);
        self.file.read_exact(&mut data[start..])?;
        Ok(data)
    }
}
