//! Getting every word said by the natural voice. Kokoro reads words through a
//! pronunciation dictionary and silently skips any word it doesn't have: numbers,
//! names, brands, "&". Before each line Dashledge spells numbers, times and symbols
//! out as words, and writes a small extra dictionary for the words still missing:
//! possessives, run-together words (CamelCase, "Dashledge" = dash + ledge), acronyms
//! spelled letter by letter, and, last, a guess from the spelling.

use std::collections::HashMap;

/// word (lowercase) → space-separated phones, as in `lexicon-en-us.txt`.
pub type Lexicon = HashMap<String, String>;

pub fn parse_lexicon(text: &str) -> Lexicon {
    text.lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.split_once(" || "))
        .map(|(word, phones)| (word.trim().to_lowercase(), phones.trim().to_string()))
        .collect()
}

// ---- Numbers, times and symbols as words ----

const ONES: [&str; 20] = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
    "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/// 0 → "zero", 1234 → "one thousand two hundred thirty four".
pub fn number_words(n: u64) -> String {
    fn below_thousand(n: u64) -> String {
        let mut parts = Vec::new();
        if n >= 100 {
            parts.push(format!("{} hundred", ONES[(n / 100) as usize]));
        }
        let rest = n % 100;
        if rest >= 20 {
            parts.push(if rest % 10 == 0 { TENS[(rest / 10) as usize].to_string() } else { format!("{} {}", TENS[(rest / 10) as usize], ONES[(rest % 10) as usize]) });
        } else if rest > 0 || parts.is_empty() {
            parts.push(ONES[rest as usize].to_string());
        }
        parts.join(" ")
    }
    if n < 1000 {
        return below_thousand(n);
    }
    let mut parts = Vec::new();
    for (scale, name) in [(1_000_000_000_000u64, "trillion"), (1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand")] {
        if n >= scale && (n / scale) % 1000 > 0 {
            parts.push(format!("{} {name}", below_thousand((n / scale) % 1000)));
        }
    }
    if n % 1000 > 0 {
        parts.push(below_thousand(n % 1000));
    }
    parts.join(" ")
}

/// 1 → "first", 22 → "twenty second".
fn ordinal_words(n: u64) -> String {
    let words = number_words(n);
    let (head, last) = words.rsplit_once(' ').map(|(h, l)| (format!("{h} "), l.to_string())).unwrap_or((String::new(), words.clone()));
    let last = match last.as_str() {
        "one" => "first".into(),
        "two" => "second".into(),
        "three" => "third".into(),
        "five" => "fifth".into(),
        "eight" => "eighth".into(),
        "nine" => "ninth".into(),
        "twelve" => "twelfth".into(),
        w if w.ends_with('y') => format!("{}ieth", &w[..w.len() - 1]),
        w => format!("{w}th"),
    };
    format!("{head}{last}")
}

/// "9:30" → "nine thirty", "9:05" → "nine oh five", "9:00" → "nine o'clock".
fn time_words(hour: u64, minute: u64) -> String {
    let h = number_words(hour);
    match minute {
        0 => format!("{h} o'clock"),
        1..=9 => format!("{h} oh {}", number_words(minute)),
        _ => format!("{h} {}", number_words(minute)),
    }
}

/// Numbers, times, ordinals, money, percentages and symbols spelled as words.
pub fn spell_out(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 16);
    let mut i = 0;
    let digits_at = |from: usize| chars[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() && (i == 0 || !chars[i - 1].is_alphanumeric()) {
            let n = digits_at(i);
            let whole: String = chars[i..i + n].iter().collect();
            let mut j = i + n;
            // Time: 9:30, with an optional am / pm after it.
            if j + 2 < chars.len() + 1 && chars.get(j) == Some(&':') && digits_at(j + 1) == 2 && n <= 2 {
                let minute: String = chars[j + 1..j + 3].iter().collect();
                out.push_str(&time_words(whole.parse().unwrap_or(0), minute.parse().unwrap_or(0)));
                if chars.get(j + 3).is_some_and(|c| c.is_alphabetic()) {
                    out.push(' ');
                }
                i = j + 3;
                continue;
            }
            // Thousands separators: 1,250.
            let mut number = whole.clone();
            while chars.get(j) == Some(&',') && digits_at(j + 1) == 3 && chars.get(j + 4).map_or(true, |c| !c.is_ascii_digit()) {
                number.extend(&chars[j + 1..j + 4]);
                j += 4;
            }
            let value: u64 = number.parse().unwrap_or(0);
            // Ordinals: 1st, 2nd, 3rd, 4th.
            let suffix: String = chars[j..].iter().take(2).collect::<String>().to_lowercase();
            if ["st", "nd", "rd", "th"].contains(&suffix.as_str()) && chars.get(j + 2).map_or(true, |c| !c.is_alphanumeric()) {
                out.push_str(&ordinal_words(value));
                i = j + 2;
                continue;
            }
            out.push_str(&number_words(value));
            // Decimals: 2.5 → two point five.
            if chars.get(j) == Some(&'.') && digits_at(j + 1) > 0 {
                out.push_str(" point");
                for d in &chars[j + 1..j + 1 + digits_at(j + 1)] {
                    out.push(' ');
                    out.push_str(ONES[d.to_digit(10).unwrap_or(0) as usize]);
                }
                j += 1 + digits_at(j + 1);
            }
            if chars.get(j) == Some(&'%') {
                out.push_str(" percent");
                j += 1;
            }
            i = j;
            continue;
        }
        let word = match c {
            '&' => Some(" and "),
            '+' => Some(" plus "),
            '@' => Some(" at "),
            '%' => Some(" percent "),
            '#' if chars.get(i + 1).is_some_and(char::is_ascii_digit) => Some(" number "),
            '$' if chars.get(i + 1).is_some_and(char::is_ascii_digit) => {
                // $5 → five dollars: say the number first.
                let n = digits_at(i + 1);
                let value: u64 = chars[i + 1..i + 1 + n].iter().collect::<String>().parse().unwrap_or(0);
                out.push_str(&number_words(value));
                out.push_str(if value == 1 { " dollar" } else { " dollars" });
                i += 1 + n;
                continue;
            }
            _ => None,
        };
        match word {
            Some(w) => out.push_str(w),
            None => out.push(c),
        }
        i += 1;
    }
    // am / pm after a time read as letters.
    let spaced: Vec<String> = out
        .split(' ')
        .map(|w| match w.trim_end_matches(['.', ',', '!', '?']).to_lowercase().as_str() {
            "am" | "a.m" => w.to_lowercase().replacen("a.m", "a m", 1).replacen("am", "a m", 1),
            "pm" | "p.m" => w.to_lowercase().replacen("p.m", "p m", 1).replacen("pm", "p m", 1),
            _ => w.to_string(),
        })
        .collect();
    spaced.join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---- Words missing from the dictionary ----

/// The words in `text` the dictionary lacks, with a pronunciation for each, keyed by
/// the lowercase word as the runtime looks it up.
pub fn missing_words(text: &str, lexicon: &Lexicon) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for raw in text.split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '’')) {
        let word = raw.trim_matches(|c: char| c == '\'' || c == '’').replace('’', "'");
        if word.is_empty() || !word.chars().any(char::is_alphabetic) {
            continue;
        }
        let key = word.to_lowercase();
        if lexicon.contains_key(&key) || out.iter().any(|(k, _)| k == &key) {
            continue;
        }
        out.push((key, pronounce(&word, lexicon)));
    }
    out
}

/// A pronunciation for one word the dictionary lacks.
pub fn pronounce(word: &str, lexicon: &Lexicon) -> String {
    let lower = word.to_lowercase();
    // Possessive: john's → john + z.
    if let Some(base) = lower.strip_suffix("'s") {
        if let Some(phones) = lexicon.get(base) {
            let voiceless = phones.ends_with('s') || phones.ends_with('ʃ') || phones.ends_with('t') || phones.ends_with('k') || phones.ends_with('p') || phones.ends_with('f');
            return format!("{phones} {}", if voiceless { "s" } else { "z" });
        }
        return format!("{} z", pronounce(base, lexicon));
    }
    // CamelCase, letters+digits and hyphens: each part on its own.
    let parts = split_parts(word);
    if parts.len() > 1 {
        return parts.iter().map(|part| lexicon.get(&part.to_lowercase()).cloned().unwrap_or_else(|| pronounce(part, lexicon))).collect::<Vec<_>>().join(" ");
    }
    // Short all-capitals: an acronym, letter by letter.
    if word.len() <= 5 && word.len() > 1 && word.chars().all(|c| c.is_ascii_uppercase()) {
        if let Some(spelled) = word.chars().map(|c| lexicon.get(&c.to_ascii_lowercase().to_string()).cloned()).collect::<Option<Vec<_>>>() {
            return spelled.join(" ");
        }
    }
    // Run-together words: dashledge → dash + ledge.
    if let Some(found) = segment(&lower, lexicon) {
        return found;
    }
    guess(&lower)
}

/// "PracticePanther" → ["Practice", "Panther"], "mp3-player" → ["mp", "3", "player"].
fn split_parts(word: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = word.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_alphanumeric() {
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            continue;
        }
        let boundary = i > 0 && !current.is_empty() && {
            let prev = chars[i - 1];
            (prev.is_lowercase() && c.is_uppercase())
                || (prev.is_alphabetic() != c.is_alphabetic())
                || (prev.is_uppercase() && c.is_uppercase() && chars.get(i + 1).is_some_and(|n| n.is_lowercase()))
        };
        if boundary {
            parts.push(std::mem::take(&mut current));
        }
        current.push(c);
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// The fewest dictionary words (2 to 4, each at least 3 letters) that spell `word`.
fn segment(word: &str, lexicon: &Lexicon) -> Option<String> {
    let chars: Vec<char> = word.chars().collect();
    let n = chars.len();
    if n < 6 {
        return None;
    }
    // best[i] = (parts, phones) for chars[..i]
    let mut best: Vec<Option<(usize, String)>> = vec![None; n + 1];
    best[0] = Some((0, String::new()));
    for end in 3..=n {
        for start in 0..=end.saturating_sub(3) {
            let Some((count, phones)) = best[start].clone() else { continue };
            if count >= 4 {
                continue;
            }
            let piece: String = chars[start..end].iter().collect();
            if let Some(found) = lexicon.get(&piece) {
                let next = (count + 1, if phones.is_empty() { found.clone() } else { format!("{phones} {found}") });
                if best[end].as_ref().map_or(true, |(c, _)| next.0 < *c) {
                    best[end] = Some(next);
                }
            }
        }
    }
    best[n].take().filter(|(count, _)| *count >= 2).map(|(_, phones)| phones)
}

/// A pronunciation guessed from English spelling, for names and words nothing else
/// covers. Rough, but heard rather than skipped.
pub fn guess(word: &str) -> String {
    let w: Vec<char> = word.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    let n = w.len();
    let at = |i: usize| w.get(i).copied().unwrap_or(' ');
    let vowel = |c: char| "aeiouy".contains(c);
    let mut phones: Vec<&str> = Vec::new();
    let mut stressed = false;
    let mut i = 0;
    while i < n {
        let c = at(i);
        let rest: String = w[i..].iter().take(3).collect();
        let (sound, used): (&str, usize) = if rest.starts_with("tch") {
            ("t ʃ", 3)
        } else if rest.starts_with("igh") {
            ("a ɪ", 3)
        } else if rest.starts_with("ch") {
            ("t ʃ", 2)
        } else if rest.starts_with("sh") {
            ("ʃ", 2)
        } else if rest.starts_with("th") {
            ("θ", 2)
        } else if rest.starts_with("ph") {
            ("f", 2)
        } else if rest.starts_with("ck") {
            ("k", 2)
        } else if rest.starts_with("qu") {
            ("k w", 2)
        } else if rest.starts_with("ng") {
            ("ŋ", 2)
        } else if rest.starts_with("ee") || rest.starts_with("ea") || rest.starts_with("ie") {
            ("iː", 2)
        } else if rest.starts_with("oo") {
            ("uː", 2)
        } else if rest.starts_with("ai") || rest.starts_with("ay") || rest.starts_with("ei") {
            ("e ɪ", 2)
        } else if rest.starts_with("ou") || rest.starts_with("ow") {
            ("a ʊ", 2)
        } else if rest.starts_with("oi") || rest.starts_with("oy") {
            ("ɔ ɪ", 2)
        } else if rest.starts_with("au") || rest.starts_with("aw") {
            ("ɔ", 2)
        } else if rest.starts_with("er") || rest.starts_with("ur") || rest.starts_with("ir") {
            (if i + 2 >= n { "ɚ" } else { "ɜː ɹ" }, 2)
        } else if i + 1 < n && at(i + 1) == c && !vowel(c) {
            // Double consonants sound once.
            (consonant(c, at(i + 2)), 2)
        } else if vowel(c) {
            // A final silent e, and a long vowel before consonant + e.
            if c == 'e' && i == n - 1 && n > 2 {
                ("", 1)
            } else if c == 'y' && i == 0 {
                ("j", 1)
            } else if c == 'y' {
                (if i == n - 1 { "i" } else { "ɪ" }, 1)
            } else if i + 2 == n - 1 && at(i + 2) == 'e' && !vowel(at(i + 1)) {
                (match c { 'a' => "e ɪ", 'e' => "iː", 'i' => "a ɪ", 'o' => "o ʊ", _ => "uː" }, 1)
            } else {
                (match c { 'a' => "æ", 'e' => "ɛ", 'i' => "ɪ", 'o' => "ɑː", _ => if i == n - 1 { "uː" } else { "ʌ" } }, 1)
            }
        } else {
            (consonant(c, at(i + 1)), 1)
        };
        if !sound.is_empty() {
            // Primary stress on the first vowel sound.
            if !stressed && sound.starts_with(|ch: char| "aeiouæɛɪɑʌɔɜɚ".contains(ch)) {
                phones.push("ˈ");
                stressed = true;
            }
            phones.push(sound);
        }
        i += used;
    }
    phones.join(" ")
}

fn consonant(c: char, next: char) -> &'static str {
    match c {
        'c' => if "eiy".contains(next) { "s" } else { "k" },
        'g' => "ɡ",
        'j' => "d ʒ",
        'r' => "ɹ",
        'x' => "k s",
        'q' => "k",
        'w' => "w",
        'b' => "b", 'd' => "d", 'f' => "f", 'h' => "h", 'k' => "k", 'l' => "l", 'm' => "m", 'n' => "n",
        'p' => "p", 's' => "s", 't' => "t", 'v' => "v", 'z' => "z",
        _ => "",
    }
}

/// Splits a line into sentences, so the first can play while the rest is made.
pub fn sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        current.push(c);
        // A sentence ends at . ! or ? followed by a capital (or the end), so "a.m. today"
        // and "Dr. Smith"-style abbreviations stay together.
        let next = chars[i + 1..].iter().find(|n| !n.is_whitespace());
        let last_word = current.trim_end_matches(['.', '!', '?']).rsplit(' ').next().unwrap_or("").to_lowercase();
        let abbreviation = c == '.' && ["dr", "mr", "mrs", "ms", "st", "vs", "etc", "e.g", "i.e", "a.m", "p.m", "jr", "sr"].contains(&last_word.as_str());
        if ".!?".contains(c) && chars.get(i + 1).map_or(true, |n| n.is_whitespace()) && next.map_or(true, |n| n.is_uppercase() || n.is_ascii_digit())
            && !abbreviation && current.trim().chars().filter(|c| c.is_alphanumeric()).count() > 1 {
            out.push(current.trim().to_string());
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lexicon() -> Lexicon {
        parse_lexicon("# header\ndash || dˈ æ ʃ\nledge || lˈ ɛ d ʒ\njohn || d ʒˈ ɑː n\npractice || pɹˈ æ k t ɪ s\npanther || pˈ æ n θ ɚ\nb || bˈ iː\nm || ˈ ɛ m\nw || dˈ ʌ b əl j uː\ncat || kˈ æ t\nhi || hˈ a ɪ")
    }

    #[test]
    fn numbers_read_as_words() {
        assert_eq!(number_words(0), "zero");
        assert_eq!(number_words(15), "fifteen");
        assert_eq!(number_words(40), "forty");
        assert_eq!(number_words(1234), "one thousand two hundred thirty four");
        assert_eq!(number_words(2_000_005), "two million five");
        assert_eq!(spell_out("Due in 15 minutes"), "Due in fifteen minutes");
        assert_eq!(spell_out("Due at 9:30 AM."), "Due at nine thirty a m.");
        assert_eq!(spell_out("at 9:05pm"), "at nine oh five p m");
        assert_eq!(spell_out("by 10:00"), "by ten o'clock");
        assert_eq!(spell_out("milk & eggs, 2.5 liters, 1,250 steps"), "milk and eggs, two point five liters, one thousand two hundred fifty steps");
        assert_eq!(spell_out("the 3rd and 21st"), "the third and twenty first");
        assert_eq!(spell_out("pay $40 at 80%"), "pay forty dollars at eighty percent");
        assert_eq!(spell_out("ticket #42"), "ticket number forty two");
        assert_eq!(spell_out("MP3 and B2B"), "MP3 and B2B", "digits inside words stay for the word pass");
    }

    #[test]
    fn missing_words_get_a_pronunciation() {
        let lex = lexicon();
        let found: HashMap<_, _> = missing_words("Hi, I'm Dashledge. John's PracticePanther cat", &lex).into_iter().collect();
        assert_eq!(found["dashledge"], "dˈ æ ʃ lˈ ɛ d ʒ", "run-together dictionary words");
        assert_eq!(found["john's"], "d ʒˈ ɑː n z", "possessive");
        assert_eq!(found["practicepanther"], "pɹˈ æ k t ɪ s pˈ æ n θ ɚ", "CamelCase");
        assert!(!found.contains_key("cat") && !found.contains_key("hi"));
        assert!(found.contains_key("i'm"));
        assert_eq!(pronounce("BMW", &lex), "bˈ iː ˈ ɛ m dˈ ʌ b əl j uː", "acronyms are spelled");
        assert!(!pronounce("Gruhin", &lex).is_empty());
    }

    #[test]
    fn spelling_guesses_are_plausible() {
        assert_eq!(guess("gruhin"), "ɡ ɹ ˈ ʌ h ɪ n");
        assert_eq!(guess("kate"), "k ˈ e ɪ t");
        assert_eq!(guess("chip"), "t ʃ ˈ ɪ p");
        assert_eq!(guess("zoom"), "z ˈ uː m");
        assert!(guess("kubernetes").starts_with("k ˈ"));
    }

    #[test]
    fn lines_split_into_sentences() {
        assert_eq!(sentences("Hi, I'm Dashledge. I can speak your reminders!"), ["Hi, I'm Dashledge.", "I can speak your reminders!"]);
        assert_eq!(sentences("Pick up at 9.30 a.m. today"), ["Pick up at 9.30 a.m. today"]);
        assert_eq!(sentences("One"), ["One"]);
    }
}

#[cfg(test)]
mod real {
    /// Prints the extra dictionary for sample lines: `LEXICON=… cargo test -- --ignored print_extra --nocapture`.
    #[test]
    #[ignore]
    fn print_extra() {
        let lex = super::parse_lexicon(&std::fs::read_to_string(std::env::var("LEXICON").unwrap()).unwrap());
        let text = super::spell_out(&std::env::var("LINE").unwrap());
        println!("LINE: {text}");
        for (w, p) in super::missing_words(&text, &lex) {
            println!("ENTRY: {w} || {p}");
        }
    }
}
