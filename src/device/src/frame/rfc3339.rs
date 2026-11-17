//! RFC 3339 UTC timestamps at the wire boundary (device-design §3.1).
//!
//! Every landed frame carries whole-second UTC (`YYYY-MM-DDTHH:MM:SSZ`), and the permit mint
//! produces exactly that form (`to_char(now() AT TIME ZONE 'UTC', …)`). The permit is the first
//! body that needs ARITHMETIC on those timestamps rather than passing them through, so the
//! device needs a parser. It is hand-rolled and deliberately strict: no fractional seconds, no
//! numeric offset, no lowercase `t`/`z`, no space separator. Accepting a wider grammar than the
//! server emits would let two different strings mean the same instant, and the permit signature
//! covers the STRING — so a lenient parser would verify a document whose deadline it then
//! miscomputed. Anything outside the emitted form is refused, never guessed.
//!
//! No chrono/time dependency: the crate's dependency set is closed (batch 0), and the conversion
//! is the standard days-from-civil algorithm.

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
/// `month` is 1..=12 and `day` is 1..=31; the caller has already range-checked them.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Whether `year` is a Gregorian leap year.
fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Parse `YYYY-MM-DDTHH:MM:SSZ` into unix seconds, or `None` for anything else.
///
/// Refused: a wrong length or separator, a non-digit, an out-of-range month/day/hour/minute/
/// second (including a day that does not exist in that month), a leap second (`:60`), and a year
/// before 1970 — a permit minted before the epoch is not a timestamp this device can act on.
pub fn parse_utc_seconds(text: &str) -> Option<u64> {
    let b = text.as_bytes();
    if b.len() != 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'Z'
    {
        return None;
    }
    let digits = |from: usize, to: usize| -> Option<i64> {
        let mut value = 0i64;
        for &c in &b[from..to] {
            if !c.is_ascii_digit() {
                return None;
            }
            value = value * 10 + i64::from(c - b'0');
        }
        Some(value)
    };
    let year = digits(0, 4)?;
    let month = digits(5, 7)?;
    let day = digits(8, 10)?;
    let hour = digits(11, 13)?;
    let minute = digits(14, 16)?;
    let second = digits(17, 19)?;
    if year < 1970 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => return None,
    };
    if day < 1 || day > days_in_month {
        return None;
    }
    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    Some(days as u64 * 86400 + hour as u64 * 3600 + minute as u64 * 60 + second as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_epoch_and_known_instants() {
        assert_eq!(parse_utc_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc_seconds("1970-01-02T00:00:00Z"), Some(86400));
        // 2026-11-17T00:00:00Z, the day this adapter landed.
        assert_eq!(
            parse_utc_seconds("2026-11-17T00:00:00Z"),
            Some(1_794_873_600)
        );
        assert_eq!(
            parse_utc_seconds("2026-11-17T12:34:56Z"),
            Some(1_794_873_600 + 12 * 3600 + 34 * 60 + 56)
        );
        assert_eq!(parse_utc_seconds("2000-02-29T23:59:59Z"), Some(951_868_799));
    }

    #[test]
    fn handles_leap_year_rules() {
        // 2000 is a leap year (divisible by 400), 1900 is not, 2024 is.
        assert!(parse_utc_seconds("2000-02-29T00:00:00Z").is_some());
        assert!(parse_utc_seconds("2024-02-29T00:00:00Z").is_some());
        assert_eq!(parse_utc_seconds("1900-02-29T00:00:00Z"), None);
        assert_eq!(parse_utc_seconds("2026-02-29T00:00:00Z"), None);
        // The day after a leap day rolls into March, not into a second February.
        assert_eq!(
            parse_utc_seconds("2024-03-01T00:00:00Z"),
            parse_utc_seconds("2024-02-29T00:00:00Z").map(|s| s + 86400)
        );
    }

    #[test]
    fn refuses_every_form_the_server_does_not_emit() {
        for bad in [
            "",
            "2026-11-17T12:34:56",       // no Z
            "2026-11-17T12:34:56z",      // lowercase z
            "2026-11-17t12:34:56Z",      // lowercase t
            "2026-11-17 12:34:56Z",      // space separator
            "2026-11-17T12:34:56.000Z",  // fractional seconds
            "2026-11-17T12:34:56+00:00", // numeric offset
            "2026-11-17T12:34:56-05:00", // non-UTC offset
            "2026-11-17T12:34Z",         // no seconds
            "2026-1-17T12:34:56Z",       // unpadded month
            "2026-11-17T12:34:60Z",      // leap second
            "2026-11-17T24:00:00Z",      // hour 24
            "2026-11-17T12:60:00Z",      // minute 60
            "2026-13-17T12:34:56Z",      // month 13
            "2026-00-17T12:34:56Z",      // month 0
            "2026-11-00T12:34:56Z",      // day 0
            "2026-11-31T12:34:56Z",      // November has 30 days
            "2026-04-31T12:34:56Z",      // April has 30 days
            "1969-12-31T23:59:59Z",      // before the epoch
            "2026-11-17T12:34:5aZ",      // non-digit
            "2026-11-17T12:34:56Z ",     // trailing space
            " 2026-11-17T12:34:56Z",     // leading space
            "2026-11-17T12:34:56ZZ",     // too long
        ] {
            assert_eq!(parse_utc_seconds(bad), None, "accepted {bad:?}");
        }
    }

    #[test]
    fn round_trips_a_whole_day_boundary() {
        // The permit TTL arithmetic subtracts two of these, so a one-second error at a day
        // boundary would silently widen or narrow the 5s window.
        let before = parse_utc_seconds("2026-12-31T23:59:59Z").unwrap();
        let after = parse_utc_seconds("2027-01-01T00:00:00Z").unwrap();
        assert_eq!(after - before, 1);
    }
}
