from __future__ import annotations

import json
import re
from dataclasses import dataclass

from fastapi import Request

from ..schemas import MeshInferenceRequest


_CONTENT_DISPOSITION_PARAM = re.compile(r'([a-zA-Z0-9_-]+)="([^"]*)"')


@dataclass(frozen=True)
class MultipartFilePart:
    name: str
    filename: str
    content_type: str | None
    content: bytes


async def parse_mesh_form_request(request: Request) -> tuple[MeshInferenceRequest, MultipartFilePart]:
    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" not in content_type.lower():
        raise ValueError("Mesh inference requires multipart/form-data")

    body = await request.body()
    fields, files = parse_multipart_form_data(body, content_type)

    mesh_file = files.get("meshFile") or files.get("mesh_file")
    if mesh_file is None:
        raise ValueError("Missing meshFile form field")
    if "diffusers" not in fields:
        raise ValueError("Missing diffusers form field")

    diffusers = _load_json_field(fields["diffusers"], field_name="diffusers")
    if not isinstance(diffusers, list):
        raise ValueError("diffusers must be a JSON array")

    options_payload: dict[str, object] = {}
    if "options" in fields and fields["options"] != "":
        options_payload = _load_json_field(fields["options"], field_name="options")
        if not isinstance(options_payload, dict):
            raise ValueError("options must be a JSON object")

    for field_name in ("quality", "boundaryCount", "interiorCount", "returnGrid3D"):
        if field_name in fields and field_name not in options_payload and fields[field_name] != "":
            options_payload[field_name] = _coerce_option_field(field_name, fields[field_name])

    context_payload = None
    if "context" in fields and fields["context"] != "":
        context_payload = _load_json_field(fields["context"], field_name="context")
        if not isinstance(context_payload, dict):
            raise ValueError("context must be a JSON object")

    mesh_request = MeshInferenceRequest.model_validate(
        {
            "diffusers": diffusers,
            "options": options_payload,
            "context": context_payload,
        }
    )
    return mesh_request, mesh_file


def parse_multipart_form_data(
    body: bytes,
    content_type: str,
) -> tuple[dict[str, str], dict[str, MultipartFilePart]]:
    boundary = _extract_boundary(content_type)
    delimiter = b"--" + boundary
    fields: dict[str, str] = {}
    files: dict[str, MultipartFilePart] = {}

    for part in body.split(delimiter):
        if not part or part in {b"--", b"--\r\n", b"\r\n"}:
            continue

        if part.startswith(b"\r\n"):
            part = part[2:]
        if part.endswith(b"--\r\n"):
            part = part[:-4]
        elif part.endswith(b"--"):
            part = part[:-2]
        if part.endswith(b"\r\n"):
            part = part[:-2]

        header_blob, separator, content = part.partition(b"\r\n\r\n")
        if not separator:
            continue

        headers = _parse_part_headers(header_blob)
        disposition = headers.get("content-disposition")
        if disposition is None:
            continue

        disposition_params = dict(_CONTENT_DISPOSITION_PARAM.findall(disposition))
        field_name = disposition_params.get("name")
        if not field_name:
            continue

        filename = disposition_params.get("filename")
        if filename is not None:
            files[field_name] = MultipartFilePart(
                name=field_name,
                filename=filename,
                content_type=headers.get("content-type"),
                content=content,
            )
        else:
            fields[field_name] = content.decode("utf-8", errors="replace")

    return fields, files


def _extract_boundary(content_type: str) -> bytes:
    for segment in content_type.split(";"):
        key, separator, value = segment.strip().partition("=")
        if separator and key.lower() == "boundary":
            boundary = value.strip().strip('"')
            if boundary:
                return boundary.encode("utf-8")
    raise ValueError("multipart/form-data boundary is missing")


def _parse_part_headers(header_blob: bytes) -> dict[str, str]:
    headers: dict[str, str] = {}
    for raw_line in header_blob.split(b"\r\n"):
        line = raw_line.decode("utf-8", errors="replace")
        name, separator, value = line.partition(":")
        if not separator:
            continue
        headers[name.strip().lower()] = value.strip()
    return headers


def _load_json_field(raw_value: str, *, field_name: str):
    try:
        return json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field_name} must be valid JSON") from exc


def _coerce_option_field(field_name: str, value: str):
    if field_name == "returnGrid3D":
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise ValueError("returnGrid3D must be a boolean")

    if field_name in {"boundaryCount", "interiorCount"}:
        try:
            return int(value)
        except ValueError as exc:
            raise ValueError(f"{field_name} must be an integer") from exc

    return value
