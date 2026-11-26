# Contributing to Cyber

We welcome pull requests for the code and documentation. Keep each PR focused, explain why the change is needed, and note what you checked. Open it against `main`; direct pushes are disabled and the `check` CI job must pass before it can merge.

With Node.js 22 and Python 3.12, use the same fixture and check commands as [CI](.github/workflows/ci.yml):

```sh
npm ci
python3 pipeline/split_data.py
python3 pipeline/prerender.py
npm run check
```

These commands use the committed snapshots. You do not need production credentials or a live feed refresh.

**Cyber does not accept incident reports.** Report an incident to the affected organization or relevant authority through its official channel. Cyber draws from [public sources](https://cyber.askgina.ai/method#sources); a report is not a request for inclusion in the feed. Do not post incident evidence, personal data, or credentials in issues or pull requests.

To report a vulnerability in Cyber itself, follow [SECURITY.md](SECURITY.md). Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).
