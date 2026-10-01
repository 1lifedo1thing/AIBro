"""Durable document images in the existing attachment store, plus portable export.

Uploading bytes does not edit workspace state or a document. The client must
durably attach the returned import record before inserting its stable URL.
"""
import base64
import hashlib
import io
import json
import os
import re
import stat
import threading
import time
import warnings
import zipfile

from comparison_drafts import _private_reference
from note_drafts import blocked_reason, _active

MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_UPLOAD_BODY = 24 * 1024 * 1024
MAX_EXPORT_BYTES = 128 * 1024 * 1024
MAX_PIXELS = 24_000_000
MAX_ANIMATION_PIXELS = 96_000_000
MAX_FRAMES = 200
FORMATS = {"PNG": ("image/png", "png"), "JPEG": ("image/jpeg", "jpg"),
           "GIF": ("image/gif", "gif"), "WEBP": ("image/webp", "webp")}
FILE_URL = re.compile(r"^/__files/([A-Za-z0-9_-]{1,160})$")
DECODE_LOCK = threading.Lock()


class MediaError(ValueError):
    def __init__(self, message, status=400, code="document_image_invalid"):
        super().__init__(message)
        self.status, self.code = status, code


def safe_name(name, fallback="image"):
    name = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]', "_", str(name or "")).strip(" .")
    return name[:160] or fallback


def validate_image(raw):
    # Bound aggregate pixel allocation on small-memory Macs when several files
    # are pasted at once or different windows upload concurrently.
    with DECODE_LOCK:
        return _validate_image(raw)


def _validate_image(raw):
    """Decode raster bytes, bounding allocation before loading any image frame."""
    if not isinstance(raw, bytes) or not raw:
        raise MediaError("图片内容为空或无效。")
    if len(raw) > MAX_IMAGE_BYTES:
        raise MediaError("单张图片不能超过 16 MiB，未截断或保存。", 413, "document_image_too_large")
    try:
        from PIL import Image
    except ImportError as error:
        raise MediaError("此版本缺少图片校验组件，请更新 AI Bro 后重试。", 503, "document_image_decoder_unavailable") from error
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in FORMATS:
                    raise MediaError("仅支持 PNG、JPEG、GIF、WebP 图片，不支持 SVG 或其他文件。", 415)
                mime, extension = FORMATS[image.format]
                width, height = image.size
                frames = getattr(image, "n_frames", 1)
                if width * height > MAX_PIXELS or frames > MAX_FRAMES or width * height * frames > MAX_ANIMATION_PIXELS:
                    raise MediaError("图片超过解码上限：单帧 2,400 万像素、200 帧或累计 9,600 万像素，请缩小图片后重试。", 413, "document_image_too_large")
                image.verify()
            # verify alone does not decode JPEG or animated pixels.
            with Image.open(io.BytesIO(raw)) as image:
                for frame in range(frames):
                    image.seek(frame)
                    if image.width * image.height > MAX_PIXELS:
                        raise MediaError("图片帧尺寸超过 2,400 万像素。", 413, "document_image_too_large")
                    image.load()
        return {"mimeType": mime, "extension": extension, "width": width, "height": height, "frames": frames}
    except MediaError:
        raise
    except Exception as error:
        raise MediaError("图片无法完整解码，可能已损坏或不是受支持的图片，未保存。", 415) from error


def decode_image(encoded):
    if not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE_BYTES + 2) // 3 * 4:
        raise MediaError("单张图片不能超过 16 MiB，未截断或保存。", 413, "document_image_too_large")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, UnicodeError) as error:
        raise MediaError("图片数据不完整，未保存。") from error
    return raw, validate_image(raw)


def _mask_code(content):
    masked, fence, list_indents = [], None, []
    paragraph, indented = False, False
    blank = lambda line: re.sub(r"[^\r\n]", " ", line)
    for line in content.splitlines(keepends=True):
        # Track list content indentation: four spaces can be an ordinary image
        # inside a list, while a further four spaces form an indented code block.
        structural = re.sub(r"^(?: {0,3}> ?)+", "", line)
        expanded = structural.expandtabs(4)
        indent = len(expanded) - len(expanded.lstrip(" "))
        empty = not expanded.strip()
        item = re.match(r"^( *)(?:[-+*]|\d{1,9}[.)])([ \t]+)", expanded)
        if item and (indent <= 3 or list_indents and indent >= list_indents[-1]):
            while list_indents and indent < list_indents[-1]:
                list_indents.pop()
            content_indent = item.end()
            list_indents.append(content_indent)
            structural = expanded[content_indent:]
            paragraph, indented = False, False
        else:
            if not empty:
                while list_indents and indent < list_indents[-1] and not paragraph:
                    list_indents.pop()
            content_indent = list_indents[-1] if list_indents else 0
            structural = expanded[min(indent, content_indent):]
        relative_indent = len(structural) - len(structural.lstrip(" "))
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", structural)
        if marker:
            token = marker[1]
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence) and not structural[marker.end():].strip():
                fence = None
            masked.append(blank(line))
            paragraph, indented = False, False
        else:
            is_code = relative_indent >= 4 and (indented or not paragraph)
            masked.append(blank(line) if fence or is_code else line)
            if empty:
                paragraph = False
            elif not fence:
                indented = is_code
                paragraph = not is_code and not re.match(r"^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-*_] *){3,}$)", structural)
    value = "".join(masked)
    # A backslash-escaped opening backtick is literal, not a code delimiter.
    # Index same-length runs once so a long document remains linear to mask.
    runs = list(re.finditer(r"`+", value))
    following, latest = {}, {}
    for index in range(len(runs) - 1, -1, -1):
        length = runs[index].end() - runs[index].start()
        if length in latest:
            following[index] = latest[length]
        latest[length] = index
    spans, index = [], 0
    while index < len(runs):
        start = runs[index].start()
        cursor = start - 1
        while cursor >= 0 and value[cursor] == "\\":
            cursor -= 1
        if not (start - cursor - 1) & 1 and index in following:
            closing = following[index]
            spans.append((start, runs[closing].end()))
            index = closing + 1
        else:
            index += 1
    chunks, cursor = [], 0
    for start, end in spans:
        chunks.extend((value[cursor:start], blank(value[start:end])))
        cursor = end
    chunks.append(value[cursor:])
    return "".join(chunks)


def _destination(value, offset, inline=True):
    """Scan a Markdown destination, retaining exact spans and decoding escapes."""
    cursor = offset
    if inline:
        if cursor >= len(value) or value[cursor] != "(":
            return None
        cursor += 1
    while cursor < len(value) and value[cursor].isspace():
        cursor += 1
    angle = cursor < len(value) and value[cursor] == "<"
    if angle:
        cursor += 1
    start, balance = cursor, 0
    while cursor < len(value):
        char = value[cursor]
        if char == "\\" and cursor + 1 < len(value) and re.match(r"[!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]", value[cursor + 1]):
            cursor += 2
            continue
        if angle:
            if char == ">":
                break
            if char in "<\r\n":
                return None
        else:
            if char.isspace():
                break
            if char == "(":
                balance += 1
            elif char == ")":
                if not balance:
                    break
                balance -= 1
        cursor += 1
    end = cursor
    if end == start or balance or angle and (cursor >= len(value) or value[cursor] != ">"):
        return None
    if angle:
        cursor += 1
    if inline:
        while cursor < len(value) and value[cursor].isspace():
            cursor += 1
        if cursor < len(value) and value[cursor] in ('"', "'", "("):
            closer = ")" if value[cursor] == "(" else value[cursor]
            cursor += 1
            while cursor < len(value) and value[cursor] != closer:
                if value[cursor] == "\\" and cursor + 1 < len(value):
                    cursor += 1
                cursor += 1
            if cursor >= len(value):
                return None
            cursor += 1
            while cursor < len(value) and value[cursor].isspace():
                cursor += 1
        if cursor >= len(value) or value[cursor] != ")":
            return None
    href = re.sub(r"\\([!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])", r"\1", value[start:end])
    return href, start, end


def image_occurrences(content):
    """Image destinations in authored Markdown, never fenced/inline code.

    Supports generated inline image syntax, optional titles/angle destinations,
    and full/collapsed/shortcut reference images. Returned offsets point only at
    the URL, preserving alt text and title exactly.
    """
    value = _mask_code(content)
    label = r"(?:\\.|[^\]\\\n])*"
    image = re.compile(r"!\[(" + label + r")\]")
    references, result = set(), []
    normalize = lambda text: " ".join(re.sub(r"\\(.)", r"\1", text).split()).casefold()
    for match in image.finditer(value):
        cursor = match.start() - 1
        while cursor >= 0 and value[cursor] == "\\":
            cursor -= 1
        if (match.start() - cursor - 1) & 1:
            continue
        inline = _destination(value, match.end())
        if inline:
            result.append(inline)
            continue
        reference = re.match(r"\[(" + label + r")\]", value[match.end():])
        if reference:
            references.add(normalize(reference[1] or match[1]))
        elif not value[match.end():].startswith("("):
            references.add(normalize(match[1]))
    definition = re.compile(r"^[ \t]*\[(" + label + r")\]:", re.M)
    seen = set()
    for match in definition.finditer(value):
        key = normalize(match[1])
        if key not in references or key in seen:
            continue
        target = _destination(value, match.end(), inline=False)
        if target:
            seen.add(key)
            result.append(target)
    return sorted(set(result), key=lambda item: item[1])


def portable_markdown(content, resolve):
    """Resolve all rendered Markdown images or fail; never fetch the network."""
    files, replacements, cache, total = {}, [], {}, len(content.encode("utf-8"))
    for href, start, end in image_occurrences(content):
        if href not in cache:
            cache[href] = resolve(href)
        result = cache[href]
        path, raw = result["path"], result["data"]
        if not isinstance(path, str) or path.startswith("/") or "\\" in path or any(p in ("", ".", "..") for p in path.split("/")) or not isinstance(raw, bytes):
            raise MediaError("图片的导出路径无效。")
        if path in files and files[path] != raw:
            raise MediaError("导出图片出现同名冲突，未生成不完整文件。")
        if path not in files:
            total += len(raw)
            if total > MAX_EXPORT_BYTES:
                raise MediaError("文档和图片合计超过 128 MiB，请减少本次导出内容。", 413)
            files[path] = raw
        replacements.append((start, end, path))
    for start, end, path in reversed(replacements):
        content = content[:start] + path + content[end:]
    return content, files


def read_regular(path, limit=MAX_IMAGE_BYTES):
    if path.parent.is_symlink():
        raise MediaError("图片目录不可用，不能读取符号链接。")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise MediaError("图片原件不是普通文件或超过大小上限。")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            raw = handle.read(limit + 1)
        after = os.fstat(fd)
        if len(raw) != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise MediaError("图片在读取时发生变化，请重试。", 409)
        return raw
    finally:
        os.close(fd)


class DocumentMedia:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def note(state, identifier):
        if not isinstance(identifier, str) or not identifier or len(identifier) > 200:
            raise MediaError("请提供有效的笔记标识。")
        reason = blocked_reason(state, identifier)
        if reason:
            raise MediaError("隐私文档暂不支持持久图片，请使用普通文档。" if reason == "private" else "文档或所属项目已不可用，请重新打开文档。", 403 if reason == "private" else 409, "document_image_" + reason)
        return next(note for note in state["notes"] if note.get("id") == identifier)

    def upload(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"noteId", "name", "data"} or not isinstance(payload["name"], str) or len(payload["name"]) > 500:
            raise MediaError("图片上传请求格式无效。")
        # Validate lifecycle before expensive decoding, then again under the
        # save lock so deletion/private changes cannot race a successful write.
        with self.store.lock():
            self.note(self.store.load(), payload["noteId"])
        raw, info = decode_image(payload["data"])
        digest = hashlib.sha256(raw).hexdigest()
        identifier = "img_" + hashlib.sha256((payload["noteId"] + "\0" + digest).encode()).hexdigest()
        stem = re.sub(r"\.[^.]{1,12}$", "", safe_name(payload["name"]))
        name = (stem or "image") + "." + info["extension"]
        with self.store.lock():
            state = self.store.load()
            note = self.note(state, payload["noteId"])
            matches = [item for item in state.get("imports", []) if item.get("id") == identifier]
            if any(item.get("id") == identifier for trash in state.get("trash", []) for item in trash.get("data", {}).get("imports", [])):
                raise MediaError("相同图片已在回收站，请先恢复图片后再插入。", 409)
            if matches and (len(matches) != 1 or not _active(matches[0]) or _private_reference(state, "import", identifier)
                            or matches[0].get("importOrigin") != {"kind": "document-image", "noteId": note["id"]}
                            or matches[0].get("mimeType") != info["mimeType"]
                            or matches[0].get("workspace") != note.get("workspace") or matches[0].get("projectId") != note.get("projectId")):
                raise MediaError("相同图片的归属已变化，请刷新文档后重试。", 409)
            path = self.store.file_path(identifier)
            if path.parent.is_symlink() or path.is_symlink() or path.with_suffix(".meta.json").is_symlink():
                raise MediaError("图片保存路径不可用。")
            if path.exists() and read_regular(path) != raw:
                raise MediaError("图片存储身份冲突，原文件已保留。", 409)
            if matches:
                name = safe_name(matches[0].get("originalName") or matches[0].get("name") or name)
            # Repair a byte-only orphan from an interrupted upload idempotently.
            # Existing committed images keep their metadata and original name.
            if not matches or not path.exists():
                self.store.save_file(identifier, raw, name, info["mimeType"])
            elif not path.with_suffix(".meta.json").exists():
                self.store.atomic_write(path.with_suffix(".meta.json"), json.dumps({"name": name, "mimeType": info["mimeType"], "size": len(raw)}, ensure_ascii=False).encode())
            now = int(time.time() * 1000)
            return {"id": identifier, "name": name, "originalName": name, "mimeType": info["mimeType"],
                    "size": len(raw), "fileStored": True, "url": "/__files/" + identifier,
                    "importOrigin": {"kind": "document-image", "noteId": note["id"]},
                    "workspace": note.get("workspace"), "projectId": note.get("projectId"),
                    "width": info["width"], "height": info["height"], "sha256": digest,
                    "createdAt": matches[0].get("createdAt", now) if matches else now, "updatedAt": now,
                    "status": "original-only", "parser": "文档图片", "content": "", "pages": []}

    def image_for_note(self, state, note, href):
        match = FILE_URL.fullmatch(href)
        identifier = match[1] if match else note.get("wikiSourceLinks", {}).get(href)
        if not identifier:
            raise MediaError("导出包含未托管的图片链接；请先将图片导入文档，再导出完整图片包。")
        matches = [item for item in state.get("imports", []) if item.get("id") == identifier]
        if (len(matches) != 1 or not _active(matches[0]) or _private_reference(state, "import", identifier)
                or matches[0].get("workspace") != note.get("workspace") or matches[0].get("projectId") != note.get("projectId")):
            raise MediaError("文档引用的图片已删除、不可用或属于其他项目，未生成不完整导出。", 409)
        source = matches[0]
        own = source.get("importOrigin") == {"kind": "document-image", "noteId": note["id"]}
        linked = (identifier in note.get("sourceAttachmentIds", []) or identifier == note.get("sourceAttachmentId")
                  or note.get("wikiSourceLinks", {}).get(href) == identifier)
        if not own and not linked:
            raise MediaError("图片尚未关联到此文档，请先将图片作为文档来源添加后再导出。", 409)
        try:
            raw = read_regular(self.store.file_path(identifier))
        except FileNotFoundError as error:
            raise MediaError("图片原件尚未下载或已丢失，请恢复原件后再导出。", 409) from error
        info = validate_image(raw)
        if source.get("mimeType") != info["mimeType"]:
            raise MediaError("图片元数据与原件不一致，未导出。", 409)
        return {"id": identifier, "path": "assets/" + identifier + "." + info["extension"], "data": raw}

    def export(self, payload):
        if (not isinstance(payload, dict) or set(payload) != {"noteId", "title", "content"}
                or not isinstance(payload["title"], str) or not isinstance(payload["content"], str)
                or len(payload["title"]) > 240 or len(payload["content"]) > 1_000_000 or "\0" in payload["content"]):
            raise MediaError("文档导出内容无效或超过 100 万字符上限。")
        with self.store.lock():
            state = self.store.load()
            note = self.note(state, payload["noteId"])
            content, files = portable_markdown(payload["content"], lambda href: self.image_for_note(state, note, href))
        name = safe_name(payload["title"], "document")
        files[name + ".md"] = content.encode("utf-8")
        manifest = {"format": "AI Bro document bundle v1", "noteId": note["id"], "document": name + ".md", "images": list(files)[:-1]}
        files["AIBRO-EXPORT.json"] = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for path, data in files.items():
                archive.writestr(path, data)
        return {"data": output.getvalue(), "mimeType": "application/zip", "name": name + ".zip"}
