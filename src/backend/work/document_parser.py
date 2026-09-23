"""Isolated PDF/DOCX text worker. Invoked with bytes on stdin, JSON on stdout."""

import ctypes
import io
import json
import os
import sys
import zipfile

MAX_CHARS = 200_000
MAX_LINES = 50_000
MAX_EXPANDED = 20 * 1024 * 1024
MEMORY_BYTES = 512 * 1024 * 1024
_JOB = None


def restrict_memory():
    """Apply a hard process memory limit before importing/parsing documents."""
    global _JOB  # noqa: PLW0603 -- keep the Windows job handle alive until process exit
    if os.name != "nt":
        import resource  # noqa: PLC0415 -- unavailable on Windows

        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
        return
    from ctypes import wintypes  # noqa: PLC0415 -- Windows-only job API

    class Basic(ctypes.Structure):
        _fields_ = [
            ("process_time", ctypes.c_int64),
            ("job_time", ctypes.c_int64),
            ("flags", wintypes.DWORD),
            ("min_ws", ctypes.c_size_t),
            ("max_ws", ctypes.c_size_t),
            ("active", wintypes.DWORD),
            ("affinity", ctypes.c_size_t),
            ("priority", wintypes.DWORD),
            ("scheduling", wintypes.DWORD),
        ]

    class Extended(ctypes.Structure):
        _fields_ = [
            ("basic", Basic),
            ("io", ctypes.c_uint64 * 6),
            ("process_memory", ctypes.c_size_t),
            ("job_memory", ctypes.c_size_t),
            ("peak_process", ctypes.c_size_t),
            ("peak_job", ctypes.c_size_t),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _JOB = kernel.CreateJobObjectW(None, None)
    info = Extended()
    info.basic.flags = 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
    info.process_memory = MEMORY_BYTES
    if (
        not _JOB
        or not kernel.SetInformationJobObject(
            _JOB, 9, ctypes.byref(info), ctypes.sizeof(info)
        )
        or not kernel.AssignProcessToJobObject(_JOB, kernel.GetCurrentProcess())
    ):
        raise ValueError("parser_limits_unavailable")


def add_block(lines, locations, text, location):
    block = text.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    lines.extend(block)
    locations.extend([location] * len(block))
    if len(lines) > MAX_LINES or sum(map(len, lines)) + len(lines) > MAX_CHARS:
        raise ValueError("text_limit_exceeded")


def parse_pdf(data):
    from pypdf import PdfReader  # noqa: PLC0415 -- import after resource limits

    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise ValueError("encrypted_document")
    if len(reader.pages) > 100:
        raise ValueError("document_limit_exceeded")
    lines, locations = [], []
    for number, page in enumerate(reader.pages, 1):
        content = page.get_contents()
        if content and len(content.get_data()) > 2 * 1024 * 1024:
            raise ValueError("document_limit_exceeded")
        text = page.extract_text()
        # A partial extraction must not claim to cover image-only pages.
        if not text.strip():
            raise ValueError("pdf_ocr_required")
        add_block(lines, locations, text, f"第 {number} 页")
    return lines, locations


def parse_docx(data):  # noqa: PLR0912 -- fail closed for unsupported document containers
    from defusedxml.ElementTree import fromstring  # noqa: PLC0415 -- after limits

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if (
            len(entries) > 1000
            or len(set(names)) != len(names)
            or sum(e.file_size for e in entries) > MAX_EXPANDED
        ):
            raise ValueError("document_limit_exceeded")
        if any(e.flag_bits & 1 for e in entries):
            raise ValueError("encrypted_document")
        if "word/document.xml" not in names or "[Content_Types].xml" not in names:
            raise ValueError("invalid_document")
        if any(
            "vbaproject" in name.lower() or name.startswith("word/embeddings/")
            for name in names
        ):
            raise ValueError("unsupported_document_content")
        # Reject hidden text containers instead of silently treating the body as complete.
        if any(
            name.startswith(
                (
                    "word/header",
                    "word/footer",
                    "word/footnotes",
                    "word/endnotes",
                    "word/comments",
                )
            )
            for name in names
        ):
            raise ValueError("unsupported_document_content")
        content_types = archive.read("[Content_Types].xml")
        if b"macroEnabled" in content_types:
            raise ValueError("unsupported_document_content")
        root = fromstring(archive.read("word/document.xml"))
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    for name in ("altChunk", "drawing", "object", "pict", "del", "ins", "txbxContent"):
        if next(root.iter(ns + name), None) is not None:
            raise ValueError("unsupported_document_content")
    body = root.find(ns + "body")
    if body is None:
        raise ValueError("invalid_document")
    lines, locations = [], []
    paragraph, table = 0, 0

    def text_of(node):
        return "".join(
            (node.text or "")
            if node.tag == ns + "t"
            else "\n"
            if node.tag == ns + "br"
            else "\t"
            if node.tag == ns + "tab"
            else ""
            for node in node.iter()
        )

    for child in body:
        if child.tag == ns + "p":
            paragraph += 1
            add_block(lines, locations, text_of(child), f"第 {paragraph} 段")
        elif child.tag == ns + "tbl":
            table += 1
            for r, row in enumerate(child.findall(ns + "tr"), 1):
                for c, cell in enumerate(row.findall(ns + "tc"), 1):
                    if next(cell.iter(ns + "tbl"), None) is not None:
                        raise ValueError("unsupported_document_content")
                    add_block(
                        lines,
                        locations,
                        "\n".join(text_of(p) for p in cell.findall(ns + "p")),
                        f"表 {table} · 第 {r} 行第 {c} 列",
                    )
        elif child.tag != ns + "sectPr":
            raise ValueError("unsupported_document_content")
    return lines, locations


def main():
    try:
        restrict_memory()
        data = sys.stdin.buffer.read(10 * 1024 * 1024 + 1)
        if len(data) > 10 * 1024 * 1024:
            raise ValueError("document_limit_exceeded")
        lines, locations = parse_pdf(data) if sys.argv[1] == "pdf" else parse_docx(data)
        text = "\n".join(lines)
        if not text.strip():
            raise ValueError("empty_text")
        result = {"text": text, "locations": locations}
    except Exception as exc:  # noqa: BLE001 -- no document/provider internals leave worker
        allowed = {
            "document_limit_exceeded",
            "text_limit_exceeded",
            "encrypted_document",
            "pdf_ocr_required",
            "unsupported_document_content",
            "empty_text",
            "parser_limits_unavailable",
        }
        result = {"error": str(exc) if str(exc) in allowed else "invalid_document"}
    sys.stdout.write(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
