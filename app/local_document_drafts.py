"""Device-local recovery for explicitly opened local text files.

This is not a disk-write endpoint. A draft's immutable document identity and
original file version travel with its complete original/current text. File
application still goes through LocalFileEdits propose/apply. Draft records live
outside workspace.json, sync and exports; clears are CAS tombstones.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import time

from comparison_drafts import DraftError, _is_private
from local_projects import LocalProjectError, LocalProjects
from note_drafts import NoteDraftStore, decode_json


SAFE_ID = re.compile(r"^[^\x00-\x1f\x7f`]{1,200}$")
VERSION = re.compile(r"^[a-f0-9]{64}$")
REQUIRED = {"id", "projectId", "candidateId", "path", "version", "baseContent", "content"}
OPTIONAL = {"mode", "selection", "scroll", "sourceConversationId", "recoveryContent", "retainedDraft"}


def document_id(project_id, candidate_id, path):
    return json.dumps([project_id, candidate_id, path], ensure_ascii=False, separators=(",", ":"))


def validate_id(identifier):
    if not isinstance(identifier, str):
        raise DraftError("本机文档草稿标识无效。")
    try:
        values = decode_json(identifier)
        if not isinstance(values, list) or len(values) != 3:
            raise ValueError()
        project_id, candidate_id, path = values
        if any(not isinstance(value, str) or not SAFE_ID.fullmatch(value) for value in values[:2]):
            raise ValueError()
        if not isinstance(path, str) or not path or Path(path).suffix.lower() not in LocalProjects.TEXT_SUFFIXES:
            raise ValueError()
        LocalProjects._parts(path)
        identifier.encode("utf-8")
        if identifier != document_id(*values):
            raise ValueError()
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise DraftError("本机文档草稿标识或路径无效。") from error
    return {"projectId": project_id, "candidateId": candidate_id, "path": path}


def validate_session(session, identifier):
    identity = validate_id(identifier)
    if (not isinstance(session, dict) or not REQUIRED <= set(session)
            or set(session) - REQUIRED - OPTIONAL or session.get("id") != identifier
            or any(session.get(key) != value for key, value in identity.items())):
        raise DraftError("本机文档草稿与请求的文件标识不一致。")
    if not isinstance(session.get("version"), str) or not VERSION.fullmatch(session["version"]):
        raise DraftError("本机文档草稿必须保留原文件版本。")
    for key in ("baseContent", "content", *(["recoveryContent"] if "recoveryContent" in session else [])):
        if not isinstance(session[key], str):
            raise DraftError("本机文档草稿内容必须为完整文本。")
        try:
            session[key].encode("utf-8")
        except UnicodeError as error:
            raise DraftError("本机文档草稿文字编码无效，未保存。") from error
    if "mode" in session and session["mode"] not in ("read", "rich", "edit"):
        raise DraftError("本机文档草稿编辑模式无效。")
    if "retainedDraft" in session and type(session["retainedDraft"]) is not bool:
        raise DraftError("本机文档草稿保留状态无效。")
    if "selection" in session:
        selection = session["selection"]
        # Positions use JavaScript's UTF-16 offsets, including astral symbols.
        length = len(session["content"].encode("utf-16-le")) // 2
        if (not isinstance(selection, dict) or set(selection) != {"start", "end", "direction"}
                or any(type(selection.get(key)) is not int for key in ("start", "end"))
                or not 0 <= selection["start"] <= selection["end"] <= length
                or selection["direction"] not in ("forward", "backward", "none")):
            raise DraftError("本机文档草稿选区无效。")
    if "scroll" in session:
        scroll = session["scroll"]
        if (not isinstance(scroll, dict) or set(scroll) != {"top", "left"}
                or any(type(value) not in (int, float) or not math.isfinite(value) or value < 0 for value in scroll.values())):
            raise DraftError("本机文档草稿滚动位置无效。")
    if "sourceConversationId" in session and (not isinstance(session["sourceConversationId"], str)
            or not SAFE_ID.fullmatch(session["sourceConversationId"])):
        raise DraftError("本机文档草稿来源对话无效。")
    return session


def _matches(state, collection, identifier):
    return [value for value in state.get(collection, []) if isinstance(value, dict) and value.get("id") == identifier]


def _inactive(value):
    return any(value.get(key) for key in ("archived", "archivedAt", "deleted", "deletedAt")) or value.get("status") in ("archived", "deleted")


class LocalDocumentDraftStore(NoteDraftStore):
    """Reuse the audited owner-only dirfd/flock/fsync storage primitives.

The server holds WorkspaceStore.lock around calls, then this store takes its
own cross-process lock. No current or historical document body is truncated.
The HTTP transport, Python/JSON allocations and available disk still impose
real resource limits; failures retain the preceding record.
"""
    def __init__(self, directory, load_state, projects, atomic_write=None):
        super().__init__(directory, load_state, atomic_write)
        self.directory = self.root / ".local-document-drafts"
        self.projects = projects

    def path_for(self, identifier):
        validate_id(identifier)
        return self.directory / (hashlib.sha256(identifier.encode("utf-8")).hexdigest() + ".json")

    def _read(self, identifier):
        empty = {"version": 1, "id": identifier, "revision": 0, "session": None, "updatedAt": None}
        with self._directory() as directory_fd:
            if directory_fd is None:
                return empty
            try:
                descriptor = os.open(self.path_for(identifier).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            except FileNotFoundError:
                return empty
            except OSError as error:
                raise DraftError("本机文档草稿存储路径异常，原文件未修改。", 500, "draft_storage_path") from error
            if not self._safe(os.fstat(descriptor)):
                os.close(descriptor)
                raise DraftError("本机文档草稿文件或权限异常，原文件未修改。", 500, "draft_storage_path")
            try:
                with os.fdopen(descriptor, "rb") as handle:
                    record = decode_json(handle.read())
                if (not isinstance(record, dict) or set(record) != {"version", "id", "revision", "session", "updatedAt"}
                        or type(record.get("version")) is not int or record["version"] != 1 or record.get("id") != identifier
                        or type(record.get("revision")) is not int or not 1 <= record["revision"] <= 2**53 - 1
                        or type(record.get("updatedAt")) is not int or record["updatedAt"] < 0):
                    raise ValueError("invalid record")
                if record["session"] is not None:
                    validate_session(record["session"], identifier)
                return record
            except (DraftError, OSError, ValueError, TypeError, UnicodeError, RecursionError) as error:
                raise DraftError("本机文档草稿无法读取或内容损坏；原草稿已保留。", 500, "draft_storage_corrupt") from error

    def _scope(self, identity, sessions=()):
        """Privacy is checked even when the folder grant has been revoked."""
        state = self.load_state()
        if not isinstance(state, dict):
            return "unavailable", None
        projects = _matches(state, "projects", identity["projectId"])
        if len(projects) > 1 or any(_is_private(value) for value in projects):
            return "private", None
        if len(projects) != 1 or _inactive(projects[0]):
            return "unavailable", None
        for session in sessions:
            conversation_id = session.get("sourceConversationId") if session else None
            if not conversation_id:
                continue
            conversations = _matches(state, "conversations", conversation_id)
            if len(conversations) != 1 or _inactive(conversations[0]):
                return "unavailable", None
            conversation = conversations[0]
            origins = _matches(state, "projects", conversation.get("projectId")) if conversation.get("projectId") else []
            if _is_private(conversation) or len(origins) > 1 or any(_is_private(value) for value in origins):
                return "private", None
        return None, projects[0]

    def _availability(self, identity, project):
        """Validate the existing grant/path without reading the disk body."""
        if not isinstance(project.get("localFolder"), dict) or project["localFolder"].get("id") != identity["candidateId"]:
            return "changed_binding"
        try:
            with self.projects._connected_folder(identity["candidateId"]) as folder_fd:
                parts = self.projects._parts(identity["path"])
                try:
                    parent = self.projects._open_below(folder_fd, "/".join(parts[:-1]))
                except FileNotFoundError:
                    return "missing"
                except OSError:
                    return "unavailable"
                try:
                    try:
                        metadata = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        return "missing"
                    except OSError:
                        return "unavailable"
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                        return "unavailable"
                    return None
                finally:
                    os.close(parent)
        except (LocalProjectError, OSError):
            return "disconnected"

    @staticmethod
    def _deny(reason):
        raise DraftError("私密或无痕范围只能在当前窗口保留文档草稿。" if reason == "private" else "文档所属项目或来源已不可访问，草稿未写入。",
                         403 if reason == "private" else 409, "draft_" + reason)

    def get(self, identifier):
        identity = validate_id(identifier)
        record = self._read(identifier)
        blocked, project = self._scope(identity, (record["session"],))
        result = {"revision": record["revision"], "session": None if blocked else record["session"], "updatedAt": record["updatedAt"]}
        if blocked:
            return {**result, "blocked": blocked}
        unavailable = self._availability(identity, project)
        if unavailable:
            # Prior text remains exportable/recoverable, but never grants write
            # permission to the disconnected path or its new replacement.
            return {**result, "recoveryOnly": bool(record["session"]), "unavailable": unavailable,
                    **({"blocked": "unavailable"} if not record["session"] and unavailable != "missing" else {})}
        return result

    def put(self, identifier, payload):
        identity = validate_id(identifier)
        if (not isinstance(payload, dict) or set(payload) != {"revision", "session"}
                or type(payload.get("revision")) is not int or not 0 <= payload["revision"] < 2**53 - 1):
            raise DraftError("本机文档草稿保存请求格式无效。")
        session = payload["session"]
        if session is not None:
            validate_session(session, identifier)
            reason, _ = self._scope(identity, (session,))
            if reason:
                self._deny(reason)
        with self._lock():
            current = self._read(identifier)
            if payload["revision"] != current["revision"]:
                raise DraftError("另一窗口已更新这个文件的草稿；当前文字已保留，请重新载入后处理。", 409, "draft_conflict")
            unavailable = None
            if session is not None:
                reason, project = self._scope(identity, (session, current["session"]))
                if reason:
                    self._deny(reason)
                unavailable = self._availability(identity, project)
                if unavailable and unavailable != "missing" and not current["session"]:
                    self._deny("unavailable")
                if unavailable and current["session"] and any(session[key] != current["session"][key] for key in ("version", "baseContent")):
                    raise DraftError("文件当前不可访问，请保留原始版本恢复草稿；不能把草稿作为新的磁盘版本。", 409, "draft_base_conflict")
                # A saved origin cannot be omitted to bypass a later privacy
                # change. Clear explicitly before starting a different origin.
                if current["session"] and current["session"].get("sourceConversationId") and session.get("sourceConversationId") != current["session"]["sourceConversationId"]:
                    raise DraftError("草稿来源已变化，请先明确处理原有草稿。", 409, "draft_conflict")
            record = {"version": 1, "id": identifier, "revision": current["revision"] + 1, "session": session, "updatedAt": int(time.time() * 1000)}
            try:
                raw = json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
                self._atomic_write(self.path_for(identifier), raw)
            except (ValueError, TypeError, UnicodeError) as error:
                raise DraftError("本机文档草稿文字编码无效，未保存。") from error
            except (OSError, MemoryError) as error:
                raise DraftError("本机文档草稿未确认写入磁盘；请保留当前文字并重试。", 503, "draft_write_failed") from error
        return {"revision": record["revision"], "session": session, "updatedAt": record["updatedAt"], "cleared": session is None,
                **({"recoveryOnly": True, "unavailable": unavailable} if unavailable else {})}
