---
title: "Method and sources"
description: "How Cyber collects, deduplicates and classifies records, scores early signals, and reports uncertainty."
canonical: "https://cyber.askgina.ai/method"
lastmod: "2026-11-26"
kind: "view"
index: true
---

# Method and sources

[HTML version](<https://cyber.askgina.ai/method>)

How Cyber collects, deduplicates and classifies records, scores early signals, and reports uncertainty.

## Collection and scope

Cyber is rebuilt hourly from public feeds. The pipeline removes duplicates and recalculates counts for the last 24 hours, seven days and 30 days. An entry records what a source says and how far the claim has been corroborated; it is not a verdict.

Curated incidents and eligible tracker, catalog, and disclosure records have durable pages. News and X signals have rolling 90-day coverage. Daily snapshots group eligible records by their UTC dates. Thin stubs, dynamic clusters and bare ransomware leak-site claims do not have standalone pages.

## Data reuse

CC BY 4.0 applies only to Cyber’s original analysis, labels and summaries. Third-party material, including sourced fields in the downloads, is not covered by Cyber’s licence and remains subject to its source’s terms.

- [CC BY 4.0 licence text](https://creativecommons.org/licenses/by/4.0/)

## Confidence stages

X signals are grouped by incident, not by account. Scoring combines independent evidence. Base weights are 1.0 for an affected party, 0.7 for security firms, 0.65 for investigators, 0.4 for media, 0.2 for aggregators, 0.12 for ordinary users and 0.08 for unverified accounts. Stronger evidence, such as an on-chain reference, can raise a weight. The recorded stage can change as posts, disclosures or database listings arrive.

- **Rumour:** Only low-weight accounts have reported the claim.
- **Claimed:** At least one credible account or enough independent reports clears the threshold.
- **Corroborated:** Two credible accounts or a combined credibility score of at least 70.
- **Confirmed:** An affected party acknowledges it or a monitored database lists it.
- **Post-mortem:** An affected party or independent investigator published a root-cause account.
- **Unconfirmed:** The signal stayed at Rumour or Claimed for at least 24 hours.
- **Disputed / False alarm:** The affected party denies the claim, or the claim was withdrawn or disproved.

## Patterns and related records

Pattern tags use text rules, DefiLlama classifications and CISA weakness codes. Related records are grouped by overlapping text, tags, vendors or chains. Tags and clusters help browse records; neither confirms a shared cause. Editorial analysis may correct automatic tags.

## Sources

- [CISA Known Exploited Vulnerabilities catalog](<https://www.cisa.gov/known-exploited-vulnerabilities-catalog>)
- [DefiLlama hacks dataset](<https://defillama.com/hacks>)
- [SlowMist Hacked](<https://hacked.slowmist.io/>)
- [rekt analyses](<https://rekt.news/leaderboard>)
- [Have I Been Pwned](<https://haveibeenpwned.com/>)
- [ransomware.live leak-site index](<https://www.ransomware.live/>)
- [California Attorney General breach notices](<https://oag.ca.gov/privacy/databreach/list>)
- [HHS Office for Civil Rights breach portal](<https://ocrportal.hhs.gov/ocr/breach/breach_report.jsf>)
- [SEC EDGAR filings](<https://www.sec.gov/edgar/search/>)
- [The Record](<https://therecord.media/>)
- [The Hacker News](<https://thehackernews.com/>)
- [BleepingComputer](<https://www.bleepingcomputer.com/>)
- [DataBreaches.net](<https://databreaches.net/>)
- [Krebs on Security](<https://krebsonsecurity.com/>)

The report also draws on state attorney general notices and selected posts on X. Individual records link to the sources used.

## Other trackers

Threat maps show vendor detections, not confirmed incidents, so they are not counted.

- [Smart Contract Hacking dashboard](<https://smartcontractshacking.com/tools/web3-hacks-dashboard>)
- [SEAL 911 (active crypto incidents)](<https://securityalliance.org/>)
- [Axis Intelligence breach tracker](<https://axis-intelligence.com/data-breach-tracker/>)
- [Kaspersky Cybermap](<https://cybermap.kaspersky.com/>)
- [FortiGuard Threat Map](<https://www.fortiguard.com/threat-map>)
- [SonicWall Attack Map](<https://attackmap.sonicwall.com/>)

## For agents and developers

Every human page has a machine-readable form. Start with the site guide, then read a page's Markdown twin or the combined corpus. Search and snapshots are public and read-only.

- [Site guide for agents](<https://cyber.askgina.ai/llms.txt>)
- [Incident index](<https://cyber.askgina.ai/incidents/llms.txt>)
- [Pattern index](<https://cyber.askgina.ai/patterns/llms.txt>)
- [Method index](<https://cyber.askgina.ai/method/llms.txt>)
- [Combined corpus](<https://cyber.askgina.ai/llms-full.txt>)
- [Search API schema](<https://cyber.askgina.ai/openapi.json>)
- [Agent skill](<https://cyber.askgina.ai/.well-known/agent-skills/read-cyber/SKILL.md>)
- [RSS feed](<https://cyber.askgina.ai/feed.xml>)
- [JSON Feed](<https://cyber.askgina.ai/feed.json>)
- [Live JSON snapshot](<https://cyber.askgina.ai/data.json>)
- [Archive snapshot](<https://cyber.askgina.ai/archive.json>)

## Limitations

Feeds can lag disclosures and vary in coverage. Losses and affected counts are as reported and can change. Some news records are advisories rather than incident accounts. X coverage uses curated signals and search, not the full feed.

Ransomware leak-site figures count claims by criminal groups, not independently verified incidents. The report gives group, sector and country aggregates without victim names. A listing, filing, or publication date can differ from the date of compromise.
