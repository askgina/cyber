#!/usr/bin/env python3
"""Build the Terminal startup payload and its lossless Details and History tiers."""

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOT_DAYS = 7
HOT_MAX_BYTES = 1_048_576

_DATE_FIELDS = {
    "news": ("date",),
    "x": ("last", "date"),
    "registry": ("latest", "first_reported"),
    "crypto": ("date", "listed_at"),
    "kev": ("date", "listed_at"),
    "breaches": ("added",),
    "notices": ("date",),
}
_WRAPPED = {"crypto", "kev", "breaches"}
_LIST_FIELDS = {
    # The feed links by eid. The potentially long source URL is only used by
    # Report and the inspector, which hydrate Details.
    "news": set("eid date title source n_outlets crypto".split()),
    "registry": set(
        "id org title type status country usd records n_outlets first_reported latest event_date affected".split()
    ),
    # Score and credibility are shown in Terminal; project and match IDs dedup Today.
    "x": set(
        "eid date last subject stage accounts amount_usd_claimed claim first project credible score stale".split()
    ),
}
_SPLIT_KEYS = {"registry_aliases", "split", "hot_days"}
_SPLIT_FILES = ("data-hot.json", "data-details.json", "data-history.json")
_LOG = logging.getLogger(__name__)


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _generation_time(data: dict) -> datetime:
    generated = data.get("generated")
    return _parse_iso(generated) if generated else datetime.now(timezone.utc)


def _is_recent(row: dict, fields: tuple[str, ...], cutoff: datetime) -> bool:
    for field in fields:
        value = row.get(field)
        if not isinstance(value, str) or not value:
            continue
        try:
            # A date without a time represents the whole UTC day.
            stamp = _parse_iso(value + "T23:59:59Z" if len(value) == 10 else value)
        except ValueError:
            continue
        if stamp >= cutoff:
            return True
    return False


def _record_id(kind: str, row: dict) -> str | None:
    if kind == "registry":
        return f"r-{row['id']}" if row.get("id") is not None else None
    return str(row["eid"]) if row.get("eid") is not None else None


def _project_row(kind: str, row: dict) -> tuple[dict, dict]:
    fields = _LIST_FIELDS[kind]
    projected = {k: v for k, v in row.items() if k in fields}
    omitted = {k: v for k, v in row.items() if k not in fields}
    if kind == "registry":
        if "stories" in row:
            projected["stories"] = [
                {"eid": s.get("eid"), "title": s.get("title")} for s in (row["stories"] or [])[:1]
            ]
        if "updates" in row:
            projected["updates"] = [{"text": u.get("text")} for u in (row["updates"] or [])[-1:]]
    elif kind == "x":
        # Store an original n_posts, if present, in Details too, so we can undo
        # this field even when it was only derived from the posts array.
        projected["n_posts"] = row.get("n_posts", len(row.get("posts") or []))
        if "matches" in row:
            projected["matches"] = [{"eid": m["eid"]} for m in (row["matches"] or []) if m.get("eid")]
    return projected, omitted


def build_split_payloads(data: dict, hot_days: int = HOT_DAYS) -> tuple[dict, dict, dict]:
    """Split a parsed monolith without mutating it. The cutoff is inclusive."""
    return _build_split_payloads(data, _generation_time(data), hot_days, hot_days)


def _build_split_payloads(
    data: dict, clock: datetime, hot_days: int, news_registry_days: int
) -> tuple[dict, dict, dict]:
    cutoff = clock - timedelta(days=hot_days)
    news_registry_cutoff = clock - timedelta(days=news_registry_days)
    hot = data.copy()
    records, older, hot_ids = {}, {}, set()
    for kind, fields in _DATE_FIELDS.items():
        if kind not in data or (kind in _WRAPPED and "items" not in data[kind]):
            continue
        rows = data[kind]["items"] if kind in _WRAPPED else data[kind]
        kind_cutoff = news_registry_cutoff if kind in {"news", "registry"} else cutoff
        recent, older[kind] = [], []
        for i, row in enumerate(rows):
            if not _is_recent(row, fields, kind_cutoff):
                older[kind].append({"i": i, "v": row})
                continue
            record_id = _record_id(kind, row)
            if record_id is not None:
                hot_ids.add(record_id)
                if kind in _LIST_FIELDS:
                    row, omitted = _project_row(kind, row)
                    if records.setdefault(record_id, omitted) != omitted:
                        raise ValueError(f"Cannot split rows with conflicting details for ID {record_id!r}")
            recent.append(row)
        hot[kind] = {**data[kind], "items": recent} if kind in _WRAPPED else recent

    hot["registry_aliases"] = sorted({
        alias for row in data.get("registry", [])
        for match in (row.get("match") or []) if len(alias := match.lower()) >= 4
    })
    details = data.get("details", {})
    # Preserve absence of optional monolith keys as well as empty values.
    if "details" in data:
        hot["details"] = {
            key: {"patterns": det.get("patterns", []), "related_n": len(det.get("related", []))}
            for key, det in details.items() if key in hot_ids
        }
    if "clusters" in data:
        hot["clusters"] = []
    # On a budget retry this is the shortest window, for news and registry only.
    hot.update(split=True, hot_days=news_registry_days)
    return (
        hot,
        {"generated": data.get("generated"), "details": details, "records": records},
        {"generated": data.get("generated"), "clusters": data.get("clusters", []), "older": older},
    )


def reconstruct_monolith(hot: dict, details_payload: dict, history_payload: dict) -> dict:
    """Restore the parsed monolith from three matching-generation payloads."""
    if not hot.get("generated") == details_payload.get("generated") == history_payload.get("generated"):
        raise ValueError("Cannot reconstruct payloads from different generations")
    merged = {key: value for key, value in hot.items() if key not in _SPLIT_KEYS}
    if "details" in hot:
        merged["details"] = details_payload["details"]
    if "clusters" in hot:
        merged["clusters"] = history_payload["clusters"]
    records = details_payload["records"]
    for kind, older in history_payload["older"].items():
        recent = hot[kind]["items"] if kind in _WRAPPED else hot[kind]
        recent_iter = iter(recent)
        old_at = {entry["i"]: entry["v"] for entry in older}
        rows = []
        for i in range(len(recent) + len(older)):
            if i in old_at:
                rows.append(old_at[i])
                continue
            row = next(recent_iter)
            if kind in _LIST_FIELDS and (record_id := _record_id(kind, row)) is not None:
                row = row.copy()
                if kind == "x":
                    row.pop("n_posts")
                row.update(records[record_id])
            rows.append(row)
        merged[kind] = {**hot[kind], "items": rows} if kind in _WRAPPED else rows
    return merged


def _compact_bytes(payload: dict) -> bytes:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _split_file_bytes(data: dict, enforce_cap: bool) -> dict[str, bytes]:
    clock = _generation_time(data)
    for days in (HOT_DAYS, 5, 3):
        hot, details, history = _build_split_payloads(data, clock, HOT_DAYS, days)
        hot_bytes = _compact_bytes(hot)
        size = len(hot_bytes)
        if not enforce_cap or size <= HOT_MAX_BYTES:
            break
        if days == 3:
            raise ValueError(
                f"data-hot.json is {size:,} UTF-8 bytes with a 3-day news/registry window; "
                f"cap is {HOT_MAX_BYTES:,} bytes."
            )
        _LOG.warning(
            "data-hot.json is %s bytes with a %d-day news/registry window (cap %s); "
            "moving more news and registry rows to History and retrying with %d days",
            f"{size:,}", days, f"{HOT_MAX_BYTES:,}", 5 if days == HOT_DAYS else 3,
        )

    return {
        "data-details.json": _compact_bytes(details),
        "data-history.json": _compact_bytes(history),
        "data-hot.json": hot_bytes,
    }


def _remove_files(paths) -> None:
    failures = []
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            failures.append(str(exc))
    if failures:
        raise OSError("Could not remove split files: " + "; ".join(failures))


def remove_split_files(site_dir: str) -> None:
    """Remove a split generation, starting with its Hot entry point."""
    _remove_files(Path(site_dir) / name for name in _SPLIT_FILES)


def write_split_files(data: dict, site_dir: str, enforce_cap: bool = True) -> dict:
    """Replace the split set or remove it on failure; return byte counts by filename."""
    paths = {name: Path(site_dir) / name for name in _SPLIT_FILES}
    staged = []
    try:
        payloads = _split_file_bytes(data, enforce_cap)
        # Stage every file before replacing any. Install Hot last so it never
        # advertises a new generation before both cold tiers are in place.
        for name, body in payloads.items():
            path = paths[name]
            tmp = path.with_suffix(".json.tmp")
            with tmp.open("wb") as f:
                staged.append((tmp, path))
                f.write(body)
        for tmp, path in staged:
            os.replace(tmp, path)
    except Exception as exc:
        try:
            _remove_files([*paths.values(), *(tmp for tmp, _ in staged)])
        except OSError as cleanup_exc:
            raise OSError(f"{exc}; {cleanup_exc}") from exc
        raise
    return {name: len(body) for name, body in payloads.items()}


def main() -> None:
    site_dir = Path(__file__).resolve().parents[1] / "site"
    with (site_dir / "data.json").open(encoding="utf-8") as f:
        data = json.load(f)
    sizes = write_split_files(data, str(site_dir))
    with (site_dir / "data-hot.json").open(encoding="utf-8") as f:
        hot_days = json.load(f)["hot_days"]
    for name, size in sizes.items():
        print(f"{name}: {size:,} UTF-8 bytes")
    print(f"hot_days: {hot_days}")


if __name__ == "__main__":
    main()
