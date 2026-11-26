// HDD Raw Copy 1.x container and its LZO variant, documented by shizmob/unimgc.
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid HDD Raw Copy image block",
    )
}
fn take<'a>(input: &mut &'a [u8], n: usize) -> io::Result<&'a [u8]> {
    let (head, tail) = input.split_at_checked(n).ok_or_else(invalid)?;
    *input = tail;
    Ok(head)
}
fn byte(input: &mut &[u8]) -> io::Result<usize> {
    Ok(take(input, 1)?[0] as usize)
}
fn word(input: &mut &[u8]) -> io::Result<usize> {
    Ok(u16::from_le_bytes(take(input, 2)?.try_into().unwrap()) as usize)
}
fn length(input: &mut &[u8], op: usize, mask: usize) -> io::Result<usize> {
    let len = op & mask;
    if len != 0 {
        return Ok(len);
    }
    let mut len = mask;
    loop {
        let next = byte(input)?;
        if next != 0 {
            return Ok(len + next);
        }
        len += 255;
    }
}
fn literals(input: &mut &[u8], out: &mut Vec<u8>, size: usize, n: usize) -> io::Result<()> {
    if n > size - out.len() {
        return Err(invalid());
    }
    out.extend_from_slice(take(input, n)?);
    Ok(())
}
fn decompress(mut input: &[u8]) -> io::Result<Vec<u8>> {
    let mut size = word(&mut input)?;
    if size & 0x8000 != 0 {
        size = (size & 0x7fff) | (word(&mut input)? << 15);
    }
    if size == 0 || size > 16 << 20 {
        return Err(invalid());
    }
    let mut out = Vec::with_capacity(size);
    let mut state = 0;
    if let Some(&op) = input.first() {
        if op > 17 {
            literals(&mut input, &mut out, size, usize::from(op - 17))?;
            state = 4;
        }
    }
    while !input.is_empty() {
        let op = byte(&mut input)?;
        let (len, distance, tail) = match op {
            64.. => (
                (op >> 5) + 1,
                (byte(&mut input)? << 3) + ((op >> 2) & 7) + 1,
                op & 3,
            ),
            16..=63 => {
                let near = op >= 32;
                let len = length(&mut input, op, if near { 31 } else { 7 })? + 2;
                let follow = word(&mut input)?;
                let base = if near { 1 } else { 0x4000 + ((op & 8) << 11) };
                (len, (follow >> 2) + base, follow & 3)
            }
            _ if state == 0 => {
                let len = length(&mut input, op, 15)? + 3;
                literals(&mut input, &mut out, size, len)?;
                state = 4;
                continue;
            }
            _ => return Err(invalid()),
        };
        if distance > out.len() || len > size - out.len() {
            return Err(invalid());
        }
        for _ in 0..len {
            out.push(out[out.len() - distance]);
        }
        literals(&mut input, &mut out, size, tail)?;
        state = tail;
    }
    if out.len() != size {
        return Err(invalid());
    }
    Ok(out)
}

pub fn expand(input: &mut File, output: &mut File) -> io::Result<()> {
    let input_len = input.metadata()?.len();
    let mut header = [0; 4096];
    input.read_exact(&mut header)?;
    if !header.starts_with(b"\x11HDD Raw Copy Tool") {
        return Err(invalid());
    }
    let number = |start| u64::from_le_bytes(header[start..start + 8].try_into().unwrap());
    let capacity = number(0x500)
        .checked_mul(number(0x508))
        .ok_or_else(invalid)?;
    let mut written = 0u64;
    let mut data_bytes = 0u64;
    let mut position = 4096;
    while position < input_len {
        let mut prefix = [0; 8];
        input.read_exact(&mut prefix)?;
        let size = u32::from_le_bytes(prefix[4..].try_into().unwrap()) as u64;
        if !(8..=32 << 20).contains(&size) || size > input_len - position {
            return Err(invalid());
        }
        position += size;
        match &prefix[..4] {
            b"omg!" if size == 16 => {
                let mut zeroes = [0; 8];
                input.read_exact(&mut zeroes)?;
                written = written
                    .checked_add(u64::from_le_bytes(zeroes))
                    .ok_or_else(invalid)?;
                if written > capacity || written > i64::MAX as u64 {
                    return Err(invalid());
                }
                output.seek(SeekFrom::Start(written))?;
            }
            b"lol!" => {
                let mut bytes = vec![0; size as usize - 8];
                input.read_exact(&mut bytes)?;
                let block = decompress(&bytes)?;
                written = written
                    .checked_add(block.len() as u64)
                    .ok_or_else(invalid)?;
                data_bytes += block.len() as u64;
                if written > capacity || data_bytes > 2 << 30 {
                    return Err(invalid());
                }
                output.write_all(&block)?;
            }
            _ => return Err(invalid()),
        }
    }
    if written != capacity {
        return Err(invalid());
    }
    output.set_len(written)?;
    output.rewind()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_run_and_overlapping_match_fill_a_block() {
        // Four literals, then three bytes at distance one.
        assert_eq!(
            decompress(&[7, 0, 1, 1, 2, 3, 4, 64, 0]).unwrap(),
            [1, 2, 3, 4, 4, 4, 4]
        );
        assert!(decompress(&[7, 0, 1, 1, 2, 3, 4, 68, 1]).is_err());
        assert!(decompress(&[8, 0, 1, 1, 2, 3, 4, 64, 0]).is_err());
    }
}
