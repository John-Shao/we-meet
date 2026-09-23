"""Real subprocess parsing, source positions and unsupported document boundaries."""

import io
import subprocess
import sys
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from work import services
from work.models import WorkMaterial

from .test_materials import (
    client,
    upload,
    work_settings,
)

pytestmark = pytest.mark.django_db


def pdf(*, blank=False, encrypted=False):
    writer = PdfWriter()
    page = writer.add_blank_page(300, 300)
    if not blank:
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
        )
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 10 250 Td (Launch under review.) Tj ET")
        page[NameObject("/Contents")] = stream
    if encrypted:
        writer.encrypt("test")
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def docx(extra="", parts=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" /></Types>',
        )
        if "word/document.xml" not in (parts or {}):
            archive.writestr(
                "word/document.xml",
                f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Launch under review.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Budget unknown</w:t></w:r></w:p></w:tc></w:tr></w:tbl>{extra}</w:body></w:document>',
            )
        for name, data in (parts or {}).items():
            archive.writestr(name, data)
    return output.getvalue()


@pytest.mark.parametrize("kind", ["pdf", "docx"])
def test_real_document_worker_locations_and_preview(client, kind):
    response = upload(
        client, data=pdf() if kind == "pdf" else docx(), name="source." + kind
    )
    assert response.status_code == 201
    assert services.process_materials() == 1
    item = WorkMaterial.objects.get(pk=response.data["id"])
    assert item.status == "ready", item.error_code
    assert "Launch under review." in item.text
    assert item.locations[0] == ("第 1 页" if kind == "pdf" else "第 1 段")
    if kind == "docx":
        assert item.locations[1] == "表 1 · 第 1 行第 1 列"
    preview = client.get(f"/api/v1.0/work/materials/{item.pk}/preview/")
    assert preview.data["lines"][0]["location"] == item.locations[0]


@pytest.mark.parametrize(
    "kind,code",
    [
        ("encrypted", "encrypted_document"),
        ("blank", "pdf_ocr_required"),
        ("drawing", "unsupported_document_content"),
        ("macro", "unsupported_document_content"),
        ("header", "unsupported_document_content"),
    ],
)
def test_unsupported_content_fails_without_partial_text(client, kind, code):
    is_pdf = kind in {"blank", "encrypted"}
    data = (
        pdf(blank=kind == "blank", encrypted=kind == "encrypted")
        if is_pdf
        else docx(
            "<w:drawing />" if kind == "drawing" else "",
            {"word/vbaProject.bin": b"macro"}
            if kind == "macro"
            else {"word/header1.xml": "header"}
            if kind == "header"
            else None,
        )
    )
    response = upload(client, data=data, name="source.pdf" if is_pdf else "source.docx")
    services.process_materials()
    item = WorkMaterial.objects.get(pk=response.data["id"])
    assert item.status == "failed" and item.error_code == code
    assert not item.text and not item.locations


def test_signature_xml_entity_zip_bomb_and_timeout(client):
    assert upload(client, name="bad.pdf", data=b"text").status_code == 400
    with pytest.raises(services.MaterialError):
        services.parse_document(
            docx(
                parts={
                    "word/document.xml": '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///private">]><foo>&xxe;</foo>'
                }
            ),
            "docx",
        )
    with pytest.raises(services.MaterialError, match="document_limit_exceeded"):
        services.parse_document(
            docx(parts={"word/large.xml": "x" * (21 * 1024 * 1024)}), "docx"
        )
    with patch(
        "work.services.subprocess.run",
        side_effect=subprocess.TimeoutExpired("parser", 25),
    ):
        with pytest.raises(services.MaterialError, match="document_limit_exceeded"):
            services.parse_document(b"%PDF-", "pdf")


def test_parser_process_enforces_actual_memory_ceiling():
    script = """import document_parser
document_parser.restrict_memory()
try:
    allocation = bytearray(document_parser.MEMORY_BYTES * 2)
except MemoryError:
    print('memory_limit_enforced')
else:
    raise SystemExit('memory_limit_not_enforced')
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(services.__file__).parent,
        capture_output=True,
        timeout=10,
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    assert result.returncode == 0 and b"memory_limit_enforced" in result.stdout
