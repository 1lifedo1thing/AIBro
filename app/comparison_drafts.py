"""Private, device-local persistence for the one open comparison editor.

This store deliberately sits outside workspace.json and SyncStore: drafts are
not approved notes and must never enter cloud sync, recovery exports, or Wiki.
All methods are called while the owning WorkspaceStore lock is held.
"""
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time


MAX_BYTES = 2 * 1024 * 1024
MAX_ID = 200
MAX_TITLE = 240
MAX_EXCERPT = 6000
MAX_CRITERIA = 8
MAX_CLAIMS = 16
COLLECTIONS = {"note": "notes", "import": "imports", "paper": "papers"}
TOP_FIELDS = {
    "version", "mode", "question", "scope", "researchStatus", "claims",
    "openQuestions", "language", "title", "projectId", "workspace",
    "sources", "criteria", "selectedKey", "conclusion",
}
SOURCE_FIELDS = {
    "key", "kind", "id", "title", "projectId", "workspace", "sourceVersion",
    "capturedAt", "excerpt", "excerptOffset", "excerptLabel", "totalCharacters",
    "truncated", "metadata",
}
META_FIELDS = {"authors", "year", "venue", "doi", "url", "pageCount"}
CELL_FIELDS = {"quote", "judgment", "relation", "reviewedStamp"}
RELATIONS = {"unclassified", "supports", "contradicts", "related"}
SAFE_ID = re.compile(r"^[^\x00-\x1f`]{1,200}$")


class DraftError(ValueError):
    def __init__(self, message, status=400, code="draft_invalid"):
        super().__init__(message)
        self.status, self.code = status, code


def _is_private(value):
    return isinstance(value, dict) and any(value.get(key) for key in ("private", "incognito", "ephemeral"))


def _private_project(state, project_id):
    if not isinstance(project_id, str) or not project_id:
        return False
    matches = [item for item in state.get("projects", []) if isinstance(item, dict) and item.get("id") == project_id]
    return len(matches) > 1 or any(_is_private(item) for item in matches)


def _private_reference(state, kind, identifier):
    collection = COLLECTIONS.get(kind)
    matches = [item for item in state.get(collection, []) if isinstance(item, dict) and item.get("id") == identifier] if collection else []
    if not matches:
        # Deleted/unavailable sources remain recoverable from their frozen
        # excerpt. The UI is responsible for redacting unavailable metadata.
        return False
    if len(matches) > 1:
        return True
    if any(_is_private(item) or _private_project(state, item.get("projectId")) for item in matches):
        return True
    for item in matches:
        runs = [value for value in state.get("agentRuns", []) if isinstance(value, dict) and value.get("id") == item.get("agentRunId")]
        conversations = [value for value in state.get("conversations", []) if isinstance(value, dict) and value.get("id") == (item.get("sourceConversationId") or next((run.get("conversationId") for run in runs if run.get("conversationId")), None))]
        if any(_is_private(run) for run in runs) or any(_is_private(conversation) for conversation in conversations):
            return True
    return False


def validate_session(session):
    if not isinstance(session, dict) or set(session) - {"data", "noteId", "base", "externalChanged"}:
        raise DraftError("比较草稿会话格式无效。")
    data = session.get("data")
    if not isinstance(data, dict) or set(data) - TOP_FIELDS:
        raise DraftError("比较草稿内容格式无效。")
    version = data.get("version")
    research = version == 2 and data.get("mode") == "research"
    if version != 1 and not research:
        raise DraftError("比较草稿版本无效。")
    if version == 1 and "mode" in data or research and data.get("mode") != "research":
        raise DraftError("比较草稿模式无效。")
    title = data.get("title", "")
    if not isinstance(title, str) or len(title) > MAX_TITLE:
        raise DraftError("比较标题超过允许长度。")
    if data.get("language", "zh") not in ("zh", "en"):
        raise DraftError("比较语言无效。")
    if data.get("workspace", "日常") not in ("日常", "课程", "科研"):
        raise DraftError("比较空间无效。")
    for key, limit in (("question", 2000), ("scope", 2000), ("openQuestions", 6000), ("conclusion", 6000)):
        if key in data and (not isinstance(data[key], str) or len(data[key]) > limit):
            raise DraftError("研究草稿文字超过允许长度。")
    if research and data.get("researchStatus", "draft") not in ("draft", "insufficient", "ready"):
        raise DraftError("研究草稿状态无效。")
    if research and any(key not in data for key in ("question", "scope", "openQuestions", "claims", "researchStatus")):
        raise DraftError("研究草稿缺少必要字段。")
    project_id = data.get("projectId")
    if project_id is not None and (not isinstance(project_id, str) or not SAFE_ID.fullmatch(project_id)):
        raise DraftError("比较项目标识无效。")
    sources = data.get("sources")
    if not isinstance(sources, list) or not 2 <= len(sources) <= 4:
        raise DraftError("比较草稿需要 2–4 个来源。")
    seen_sources = set()
    for source in sources:
        if not isinstance(source, dict) or set(source) - SOURCE_FIELDS:
            raise DraftError("比较来源快照格式无效。")
        kind, identifier = source.get("kind"), source.get("id")
        if kind not in COLLECTIONS or not isinstance(identifier, str) or not SAFE_ID.fullmatch(identifier):
            raise DraftError("比较来源身份无效。")
        key = f"{kind}:{identifier}"
        if source.get("key") != key or key in seen_sources:
            raise DraftError("比较来源标识重复或不匹配。")
        seen_sources.add(key)
        excerpt, source_version, captured = source.get("excerpt", ""), source.get("sourceVersion"), source.get("capturedAt")
        if not isinstance(excerpt, str) or len(excerpt) > MAX_EXCERPT or not isinstance(source_version, str) or len(source_version) > 120:
            raise DraftError("比较来源摘录格式无效。")
        if isinstance(captured, bool) or not isinstance(captured, (int, float)) or not math.isfinite(captured):
            raise DraftError("比较来源时间无效。")
        offset = source.get("excerptOffset", 0)
        if type(offset) is not int or offset < 0:
            raise DraftError("比较来源位置无效。")
        if not isinstance(source.get("title", ""), str) or len(source.get("title", "")) > MAX_TITLE:
            raise DraftError("比较来源标题无效。")
        if source.get("projectId") is not None and (not isinstance(source["projectId"], str) or not SAFE_ID.fullmatch(source["projectId"])):
            raise DraftError("比较来源所属项目无效。")
        if source.get("workspace", "日常") not in ("日常", "课程", "科研"):
            raise DraftError("比较来源空间无效。")
        if not isinstance(source.get("excerptLabel", ""), str) or len(source.get("excerptLabel", "")) > 80:
            raise DraftError("比较来源摘录类型无效。")
        if type(source.get("totalCharacters", 0)) is not int or source.get("totalCharacters", 0) < len(excerpt) or type(source.get("truncated", False)) is not bool:
            raise DraftError("比较来源范围无效。")
        metadata = source.get("metadata", {})
        if not isinstance(metadata, dict) or set(metadata) - META_FIELDS:
            raise DraftError("比较来源元数据格式无效。")
        authors = metadata.get("authors", [])
        if not isinstance(authors, list) or len(authors) > 20 or any(not isinstance(author, str) or len(author) > 100 for author in authors):
            raise DraftError("比较来源作者信息无效。")
        for name, limit in (("year", 20), ("venue", 160), ("doi", 200), ("url", 2048)):
            if name in metadata and (not isinstance(metadata[name], str) or len(metadata[name]) > limit):
                raise DraftError("比较来源元数据超过允许长度。")
        url = metadata.get("url", "")
        if url:
            from urllib.parse import urlsplit
            parts = urlsplit(url)
            if parts.scheme not in ("http", "https") or not parts.netloc or parts.username or parts.password:
                raise DraftError("比较来源网址格式无效。")
    criteria = data.get("criteria")
    if not isinstance(criteria, list) or not 1 <= len(criteria) <= MAX_CRITERIA:
        raise DraftError("比较维度数量无效。")
    seen_rows = set()
    for row in criteria:
        if not isinstance(row, dict) or set(row) - {"id", "label", "cells"}:
            raise DraftError("比较维度格式无效。")
        row_id, label, cells = row.get("id"), row.get("label", ""), row.get("cells", {})
        if not isinstance(row_id, str) or len(row_id) > 100 or not SAFE_ID.fullmatch(row_id) or row_id in seen_rows:
            raise DraftError("比较维度标识无效。")
        seen_rows.add(row_id)
        if not isinstance(label, str) or len(label) > 100 or not isinstance(cells, dict) or set(cells) - seen_sources:
            raise DraftError("比较维度内容无效。")
        for cell in cells.values():
            if not isinstance(cell, dict) or set(cell) - CELL_FIELDS:
                raise DraftError("比较证据格式无效。")
            if not isinstance(cell.get("quote", ""), str) or len(cell.get("quote", "")) > 1200 or not isinstance(cell.get("judgment", ""), str) or len(cell.get("judgment", "")) > 1600:
                raise DraftError("比较证据文字超过允许长度。")
            if research and cell.get("relation", "unclassified") not in RELATIONS:
                raise DraftError("证据关系格式无效。")
            if research and (not isinstance(cell.get("reviewedStamp", ""), str) or len(cell.get("reviewedStamp", "")) > 180):
                raise DraftError("证据核对标记格式无效。")
            if not research and set(cell) - {"quote", "judgment"}:
                raise DraftError("普通比较中存在未知证据字段。")
    if research:
        claims = data.get("claims", [])
        if not isinstance(claims, list) or len(claims) > MAX_CLAIMS:
            raise DraftError("研究结论数量无效。")
        ids = set()
        for claim in claims:
            if not isinstance(claim, dict) or set(claim) != {"id", "text", "evidenceIds"}:
                raise DraftError("研究结论格式无效。")
            if not isinstance(claim["id"], str) or len(claim["id"]) > 100 or not SAFE_ID.fullmatch(claim["id"]) or claim["id"] in ids:
                raise DraftError("研究结论标识无效。")
            ids.add(claim["id"])
            if not isinstance(claim["text"], str) or len(claim["text"]) > 1600 or not isinstance(claim["evidenceIds"], list) or len(claim["evidenceIds"]) > 32 or any(not isinstance(ref, str) or len(ref) > 1400 for ref in claim["evidenceIds"]):
                raise DraftError("研究结论内容无效。")
            if len(set(claim["evidenceIds"])) != len(claim["evidenceIds"]):
                raise DraftError("研究结论的证据引用重复。")
    note_id = session.get("noteId")
    if note_id is not None and (not isinstance(note_id, str) or not SAFE_ID.fullmatch(note_id)):
        raise DraftError("草稿所属记录标识无效。")
    if session.get("base") is not None and (not isinstance(session["base"], str) or len(session["base"]) > 200):
        raise DraftError("草稿基准版本无效。")
    if "externalChanged" in session and type(session["externalChanged"]) is not bool:
        raise DraftError("草稿冲突状态无效。")
    # Measure the full serialized form before committing it. No truncation.
    encoded = json.dumps(session, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) > MAX_BYTES:
        raise DraftError("比较草稿过大，未保存。", 413, "draft_too_large")
    return session


class ComparisonDraftStore:
    def __init__(self, directory, load_state, atomic_write=None):
        self.directory = Path(directory)
        self.path = self.directory / "comparison-draft.json"
        self.load_state = load_state
        self._atomic_write = atomic_write or self.atomic_write

    @staticmethod
    def atomic_write(path, data):
        path = Path(path)
        if path.parent.is_symlink() or path.is_symlink():
            raise OSError("比较草稿存储路径异常。")
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary = tempfile.mkstemp(prefix=".comparison-draft-", dir=path.parent)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data); handle.flush(); os.fsync(handle.fileno())
            os.replace(temporary, path)
            directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
            try: os.fsync(directory_fd)
            finally: os.close(directory_fd)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)

    def _read(self):
        if self.path.parent.is_symlink() or self.path.is_symlink():
            raise DraftError("比较草稿存储路径异常，原文件未修改。", 500, "draft_storage_path")
        if not self.path.exists():
            return {"version": 1, "revision": 0, "session": None, "updatedAt": None}
        try:
            with self.path.open("rb") as handle:
                raw = handle.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise DraftError("比较草稿文件超过允许大小，原文件未修改。", 500, "draft_storage_corrupt")
            record = json.loads(raw)
            if (not isinstance(record, dict) or set(record) != {"version", "revision", "session", "updatedAt"}
                    or record.get("version") != 1 or type(record.get("revision")) is not int
                    or record["revision"] < 0 or record.get("session") is not None
                    and not isinstance(record.get("session"), dict)
                    or record.get("updatedAt") is not None and type(record.get("updatedAt")) is not int):
                raise ValueError("invalid record")
            if record["session"] is not None: validate_session(record["session"])
            return record
        except DraftError:
            raise
        except (OSError, ValueError, TypeError, UnicodeError) as error:
            raise DraftError("比较草稿存储无法读取；原文件已保留。", 500, "draft_storage_corrupt") from error

    def _is_private(self, session, state):
        if not session:
            return False
        data = session["data"]
        if _private_project(state, data.get("projectId")):
            return True
        if session.get("noteId"):
            owners = [item for item in state.get("notes", []) if isinstance(item, dict) and item.get("id") == session["noteId"]]
            if any(_is_private(owner) or _private_project(state, owner.get("projectId")) for owner in owners):
                return True
        return any(_private_reference(state, source["kind"], source["id"]) or _private_project(state, source.get("projectId")) for source in data["sources"])

    def get(self):
        record = self._read()
        session = record["session"]
        if session is not None and self._is_private(session, self.load_state()):
            return {"revision": record["revision"], "session": None, "updatedAt": record["updatedAt"], "blocked": "private"}
        return {"revision": record["revision"], "session": session, "updatedAt": record["updatedAt"]}

    def put(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"revision", "session"} or type(payload.get("revision")) is not int or payload["revision"] < 0:
            raise DraftError("比较草稿保存请求格式无效。")
        session = payload["session"]
        if session is not None:
            validate_session(session)
        current = self._read()
        if payload["revision"] != current["revision"]:
            raise DraftError("另一窗口已更新比较草稿；请重新载入或另存为笔记。", 409, "draft_conflict")
        if session is not None and self._is_private(session, self.load_state()):
            raise DraftError("无痕或私密来源不能写入持久比较草稿。", 403, "draft_private")
        revision = current["revision"] + 1
        record = {"version": 1, "revision": revision, "session": session, "updatedAt": int(time.time() * 1000)}
        raw = json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(raw) > MAX_BYTES:
            raise DraftError("比较草稿过大，未保存。", 413, "draft_too_large")
        try:
            self._atomic_write(self.path, raw)
        except OSError as error:
            raise DraftError("比较草稿未能写入磁盘；上一次已保存版本仍保留。", 503, "draft_write_failed") from error
        return {"revision": revision, "updatedAt": record["updatedAt"], "cleared": session is None}
