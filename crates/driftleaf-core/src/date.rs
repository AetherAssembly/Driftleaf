//! Minimal Gregorian calendar math (Howard Hinnant's days-since-epoch algorithms, public
//! domain) plus just enough ISO-8601 parsing/formatting for formula.rs's date functions
//! and backup.rs's timestamp. Not a general-purpose datetime library, and deliberately
//! UTC-only: src/shared/formula.ts's date functions use JS Date's *local*-timezone
//! getters/setters (getDate/getMonth/setDate/setMonth), so on a non-UTC machine, its
//! month/quarter/year date arithmetic is itself local-timezone-dependent. Reproducing that
//! exactly would need a timezone-database dependency for a formula feature that only
//! affects computed values at CSV/JSON export time (never stored data); this module always
//! treats dates as UTC instead, a deliberate, documented divergence.

pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub(crate) fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

pub(crate) fn is_leap_year(y: i64) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

pub(crate) fn days_in_month(y: i64, m: u32) -> u32 {
    const DAYS: [u32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if m == 2 && is_leap_year(y) {
        29
    } else {
        DAYS[((m - 1) % 12) as usize]
    }
}

pub(crate) fn parts_to_millis(y: i64, m: u32, d: u32, hh: i64, mm: i64, ss: i64, ms: i64) -> i64 {
    days_from_civil(y, m, d) * 86_400_000 + hh * 3_600_000 + mm * 60_000 + ss * 1000 + ms
}

pub(crate) fn millis_to_parts(millis: i64) -> (i64, u32, u32, i64, i64, i64, i64) {
    let days = millis.div_euclid(86_400_000);
    let remainder = millis.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    (
        y,
        m,
        d,
        remainder / 3_600_000,
        (remainder % 3_600_000) / 60_000,
        (remainder % 60_000) / 1000,
        remainder % 1000,
    )
}

pub(crate) fn add_months(y: i64, m: u32, months: i64) -> (i64, u32) {
    let total = y * 12 + (m as i64 - 1) + months;
    let new_year = total.div_euclid(12);
    let new_month = total.rem_euclid(12) + 1;
    (new_year, new_month as u32)
}

/// Accepts "YYYY-MM-DD" and "YYYY-MM-DD(T| )HH:MM[:SS[.sss]][Z|±HH:MM]"; any timezone
/// offset present is ignored (treated as UTC) — see the module comment.
pub(crate) fn parse_iso(text: &str) -> Option<i64> {
    if text.len() < 10 {
        return None;
    }
    let y: i64 = text.get(0..4)?.parse().ok()?;
    if text.as_bytes().get(4) != Some(&b'-') {
        return None;
    }
    let m: u32 = text.get(5..7)?.parse().ok()?;
    if text.as_bytes().get(7) != Some(&b'-') {
        return None;
    }
    let d: u32 = text.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) {
        return None;
    }
    let (mut hh, mut mm, mut ss, mut ms) = (0i64, 0i64, 0i64, 0i64);
    if text.len() > 10 {
        let rest = text[10..].strip_prefix(['T', ' '])?;
        let rest = rest.trim_end_matches('Z');
        let time_part = match rest.find(['+', '-']) {
            Some(index) if index > 0 => &rest[..index],
            _ => rest,
        };
        let mut parts = time_part.split(':');
        hh = parts.next().unwrap_or("0").parse().ok()?;
        mm = parts.next().unwrap_or("0").parse().ok()?;
        if let Some(seconds_part) = parts.next() {
            ss = match seconds_part.split_once('.') {
                Some((seconds, fraction)) => {
                    let padded = format!("{fraction:0<3}");
                    ms = padded[..3.min(padded.len())].parse().ok()?;
                    seconds.parse().ok()?
                }
                None => seconds_part.parse().ok()?,
            };
        }
    }
    Some(parts_to_millis(y, m, d, hh, mm, ss, ms))
}

pub(crate) fn to_iso_string(millis: i64) -> String {
    let (y, m, d, hh, mm, ss, ms) = millis_to_parts(millis);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{ms:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_conversion_round_trips() {
        for days in [-100_000i64, -1, 0, 1, 19723, 100_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
    }

    #[test]
    fn parse_and_format_known_values() {
        assert_eq!(parse_iso("2024-01-01"), Some(1_704_067_200_000));
        assert_eq!(to_iso_string(1_704_067_200_000), "2024-01-01T00:00:00.000Z");
        assert_eq!(parse_iso("2024-01-01T12:30:45.500Z"), Some(1_704_112_245_500));
        assert_eq!(parse_iso("not a date"), None);
        assert_eq!(parse_iso("2024-13-01"), None);
    }

    #[test]
    fn add_months_wraps_years() {
        assert_eq!(add_months(2024, 11, 3), (2025, 2));
        assert_eq!(add_months(2024, 2, -3), (2023, 11));
    }
}
