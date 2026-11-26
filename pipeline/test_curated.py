"""Small offline regressions for the curated incident assembly path."""
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest

import registry
from check_curated import validate


class CuratedPipelineTest(unittest.TestCase):
    def test_registry_merge_attachment_and_triage(self):
        first = '2026-01-02'
        current = {'id': 'example', 'org': 'Example Labs', 'first_reported': first}
        older = {'id': 'other', 'org': 'Other Labs', 'first_reported': '2025-12-01'}
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory) / 'incidents.json'
            live.write_text(json.dumps({'incidents': [current]}))
            live.with_name('incidents_archive.json').write_text(json.dumps({
                'incidents': [{**current, 'org': 'Stale name'}, older],
            }))
            merged = registry.load(live)
        self.assertEqual(merged['incidents'], [current, older])

        def story(title, slug, date=first):
            return {'title': title, 'source': slug, 'url': f'https://example.test/{slug}', 'date': date}

        matching = story('Example Labs discloses incident', 'matching')
        mixed = {**story('Unrelated lead', 'lead'), 'outlets': [matching]}
        unknown = story('Unmatched report', 'unknown')
        old = story('Example Labs announces new office', 'old', '2025-12-15')
        notice = {**story('Disclosure', 'notice'), 'org': 'Example Labs'}
        now = dt.datetime(2026, 1, 3, tzinfo=dt.timezone.utc)
        attached, unmatched = registry.attach(merged, [mixed, unknown, old], [notice], now)
        self.assertEqual(attached[0]['id'], 'example')
        self.assertEqual([s['url'] for s in attached[0]['stories']], [matching['url']])
        self.assertEqual(attached[0]['n_outlets'], 1)
        self.assertEqual(attached[0]['notices'], [notice])
        self.assertEqual(unmatched, [unknown, old])
        self.assertEqual([r['url'] for r in registry.triage_queue(unmatched, now)], [unknown['url']])

    def test_invalid_data_names_file_and_row(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'incidents.json').write_text('{"incidents":[{"id":7}]}')
            with self.assertRaisesRegex(ValueError, r'incidents\.json\.incidents\[0\]\.id:'):
                validate(root)


if __name__ == '__main__':
    unittest.main()
