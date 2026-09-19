"""Transcript export formatting, pinned exactly.

These renderers produce a file someone keeps or a subtitle track a player parses,
so an off-by-one in a timestamp or an unescaped character is a real defect: a cue
that runs backwards, or a caption that renders raw markup.
"""

from core.services.transcript_export import (
    DEFAULT_ROW_MS,
    format_timestamp,
    render,
    render_srt,
    render_txt,
    render_vtt,
    TranscriptRow,
)


ROWS = [
    TranscriptRow(start_ms=0, end_ms=1500, speaker="Ada", text="Hello there."),
    TranscriptRow(start_ms=1500, end_ms=4000, speaker="Bo", text="Second line."),
]


class TestTimestamp:
    def test_formats_srt_with_commas(self):
        assert format_timestamp(3_723_456, separator=",") == "01:02:03,456"

    def test_formats_vtt_with_dots(self):
        assert format_timestamp(3_723_456, separator=".") == "01:02:03.456"

    def test_pads_every_component(self):
        assert format_timestamp(1, separator=",") == "00:00:00,001"
        assert format_timestamp(60_000, separator=",") == "00:01:00,000"

    def test_does_not_wrap_hours(self):
        # A long recording is one timeline; wrapping would order later cues first.
        assert format_timestamp(90 * 3_600_000, separator=",").startswith("90:")

    def test_never_emits_a_negative_timestamp(self):
        assert format_timestamp(-5, separator=",") == "00:00:00,000"


class TestSrt:
    def test_numbers_cues_and_uses_srt_timing(self):
        assert render_srt(ROWS) == (
            "1\n00:00:00,000 --> 00:00:01,500\nAda: Hello there.\n"
            "\n"
            "2\n00:00:01,500 --> 00:00:04,000\nBo: Second line.\n"
        )

    def test_omits_the_speaker_prefix_when_there_is_no_speaker(self):
        out = render_srt([TranscriptRow(0, 1000, "", "Unattributed")])
        assert "Unattributed" in out
        assert ": Unattributed" not in out

    def test_borrows_the_next_start_when_a_row_has_no_end(self):
        rows = [
            TranscriptRow(0, None, "Ada", "first"),
            TranscriptRow(2000, 3000, "Bo", "second"),
        ]
        assert "00:00:00,000 --> 00:00:02,000" in render_srt(rows)

    def test_clamps_an_overrunning_end_to_the_next_start(self):
        # Two concurrent tracks would otherwise emit a cue that swallows the next.
        rows = [
            TranscriptRow(0, 9000, "Ada", "long"),
            TranscriptRow(2000, 3000, "Bo", "short"),
        ]
        assert "00:00:00,000 --> 00:00:02,000" in render_srt(rows)
        assert "00:00:09,000" not in render_srt(rows)

    def test_gives_the_last_row_a_default_duration_when_it_has_no_end(self):
        out = render_srt([TranscriptRow(1000, None, "Ada", "last")])
        assert f"00:00:01,000 --> {format_timestamp(1000 + DEFAULT_ROW_MS)}" in out

    def test_collapses_newlines_so_a_cue_cannot_end_early(self):
        out = render_srt([TranscriptRow(0, 1000, "Ada", "one\n\ntwo")])
        assert "one two" in out
        assert "one\n\ntwo" not in out

    def test_empty_transcript_produces_an_empty_file(self):
        assert render_srt([]) == ""


class TestVtt:
    def test_starts_with_the_webvtt_header(self):
        assert render_vtt(ROWS).startswith("WEBVTT\n")

    def test_uses_dot_milliseconds(self):
        assert "00:00:00.000 --> 00:00:01.500" in render_vtt(ROWS)

    def test_puts_the_speaker_in_a_voice_tag(self):
        assert "<v Ada>Hello there." in render_vtt(ROWS)

    def test_escapes_markup_that_a_parser_would_read_as_tags(self):
        out = render_vtt([TranscriptRow(0, 1000, "A&B", "x <i>y</i>")])
        assert "&amp;" in out
        # Both brackets, or the closing one renders literally.
        assert "&lt;i&gt;y&lt;/i&gt;" in out
        assert "<i>" not in out
        # The ampersand in our own escape must not be double-escaped.
        assert "&amp;lt;" not in out

    def test_blank_line_separates_cues(self):
        # A cue without its trailing blank line swallows the next one's timing.
        blocks = render_vtt(ROWS).strip().split("\n\n")
        assert len(blocks) == 3  # header + two cues


class TestTxt:
    def test_marks_the_time_then_the_speaker(self):
        assert render_txt(ROWS) == (
            "[00:00:00,000] Ada: Hello there.\n[00:00:01,500] Bo: Second line.\n"
        )

    def test_keeps_one_utterance_per_line(self):
        out = render_txt([TranscriptRow(0, 1000, "Ada", "one\ntwo")])
        assert out.count("\n") == 1

    def test_empty_transcript_produces_an_empty_file(self):
        assert render_txt([]) == ""


class TestDispatch:
    def test_each_supported_format_renders(self):
        for fmt in ("txt", "srt", "vtt"):
            assert render(fmt, ROWS) != ""

    def test_rejects_an_unknown_format_instead_of_guessing(self):
        for fmt in ("pdf", "docx", "", "SRT "):
            try:
                render(fmt, ROWS)
            except ValueError as error:
                assert "unsupported_format" in str(error)
            else:  # pragma: no cover - the failure branch is the assertion
                raise AssertionError(f"{fmt!r} should not render")
