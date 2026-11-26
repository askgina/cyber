"""Validate checked-in pipeline inputs without fetching feeds or writing caches."""
import datetime as dt
import json
from pathlib import Path

from enrich import LABEL
from xscore import ROLE_W, post_time


def require(ok, path, expected):
    if not ok:
        raise ValueError(f'{path}: expected {expected}')


def typed(value, kind, path):
    require(isinstance(value, kind), path, kind.__name__)
    return value


def fields(row, path, **schema):
    typed(row, dict, path)
    for key, kind in schema.items():
        typed(row.get(key), kind, f'{path}.{key}')


def rows(value, path):
    return ((f'{path}[{i}]', row) for i, row in enumerate(typed(value, list, path)))


def strings(value, path):
    for p, item in rows(value, path):
        typed(item, str, p)


def date(value, path, *, aware=False):
    typed(value, str, path)
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError(f'{path}: expected ISO date or datetime') from None
    if aware:
        require(len(value) == 10 or parsed.utcoffset() is not None, path, 'date or timezone-aware datetime')


def links(value, path, *, allow_strings=False):
    for p, row in rows(value, path):
        if allow_strings and isinstance(row, str):
            continue
        fields(row, p, url=str, label=str)


def pairs(entries):
    result = {}
    for key, val in entries:
        require(key not in result, f'JSON key {key!r}', 'unique key')
        result[key] = val
    return result


def reject_constant(value):
    raise ValueError(f'invalid JSON constant {value}')


def validate(root):
    def load(name, kind):
        try:
            value = json.loads((root / name).read_text(encoding='utf-8'),
                               object_pairs_hook=pairs, parse_constant=reject_constant)
        except (OSError, ValueError) as exc:
            raise ValueError(f'{name}: {exc}') from exc
        return typed(value, kind, name)

    for name in ('incidents.json', 'incidents_archive.json'):
        ids = set()  # The live registry is allowed to override the archive.
        for p, row in rows(load(name, dict).get('incidents'), f'{name}.incidents'):
            fields(row, p, id=str, org=str, title=str, first_reported=str,
                   type=str, status=str, summary=str, match=list, sources=list, updates=list)
            require(bool(row['id'].strip()) and row['id'] not in ids, f'{p}.id', 'unique nonempty ID')
            ids.add(row['id'])
            date(row['first_reported'], f'{p}.first_reported')
            for key in ('match', 'exclude'):
                strings(row.get(key, []), f'{p}.{key}')
            links(row['sources'], f'{p}.sources')
            for q, update in rows(row['updates'], f'{p}.updates'):
                fields(update, q, date=str, text=str, url=str)
                date(update['date'], f'{q}.date')

    name = 'analysis_notes.json'
    for key, note in load(name, dict).items():
        p = f'{name}[{key!r}]'
        fields(note, p, summary=str, attack_chain=list, open_questions=list, mitigations=list, sources=list)
        for field in ('attack_chain', 'open_questions', 'mitigations', 'patterns'):
            strings(note.get(field, []), f'{p}.{field}')
        for pattern in note.get('patterns', []):
            require(pattern in LABEL, f'{p}.patterns', f'known pattern (got {pattern!r})')
        links(note['sources'], f'{p}.sources')

    name = 'x_signals.json'
    for p, signal in rows(load(name, list), name):
        fields(signal, p, project=str, subject=str, claim=str, category=str, aliases=list, posts=list, links=list)
        strings(signal['aliases'], f'{p}.aliases')
        # Scoring falls back to the signal date when no post timestamp is available.
        links(signal['links'], f'{p}.links', allow_strings=True)
        if 'date' in signal or not signal['posts']:
            date(signal.get('date'), f'{p}.date', aware=True)
        for q, post in rows(signal['posts'], f'{p}.posts'):
            fields(post, q, url=str, role=str, stance=str, evidence=str, note=str)
            try:
                timestamp = post_time(post) or signal.get('date')
            except (ValueError, OverflowError, OSError):
                raise ValueError(f'{q}.url: invalid status timestamp') from None
            date(timestamp, f'{q}.date', aware=True)
            if 'handle' in post:
                typed(post['handle'], str, f'{q}.handle')
        if signal.get('postmortem') is not None:
            pm = signal['postmortem']
            fields(pm, f'{p}.postmortem', date=str, url=str, label=str)
            date(pm['date'], f'{p}.postmortem.date', aware=True)

    name = 'x_accounts.json'
    for key, role in load(name, dict).items():
        if not key.startswith('_'):
            require(isinstance(role, str) and role in ROLE_W, f'{name}.{key}', 'known account role')

    name = 'crypto_aliases.json'
    for key, value in load(name, dict).items():
        if key == '_same_events':
            for day, aliases in typed(value, dict, f'{name}.{key}').items():
                date(day, f'{name}.{key}.{day}')
                for alias, target in typed(aliases, dict, f'{name}.{key}.{day}').items():
                    typed(target, str, f'{name}.{key}.{day}.{alias}')
        elif not key.startswith('_'):
            strings(value, f'{name}.{key}')

    name = 'today_brief.json'
    brief = load(name, dict)
    fields(brief, name, updated=str, headline=str, incidents=list)
    date(brief['updated'], f'{name}.updated', aware=True)
    for p, row in rows(brief['incidents'], f'{name}.incidents'):
        fields(row, p, org=str, what=str, scale=str, patterns=list, url=str)
        if row.get('eid') is not None:
            typed(row['eid'], str, f'{p}.eid')
        strings(row['patterns'], f'{p}.patterns')


if __name__ == '__main__':
    try:
        validate(Path(__file__).resolve().parent)
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    print('Curated pipeline inputs validated')
