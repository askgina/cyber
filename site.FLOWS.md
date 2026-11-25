# Main flows (Cyber)

## Home: terminal
- The default view (no hash, #terminal) is the terminal. Every view shares one top bar: Leaderboard / Terminal / Report, an Ask assistant picker (Perplexity, ChatGPT or Claude; choice remembered), plus a Dark/Light toggle (light by default, choice remembered).
- ⌘K (Ctrl+K off Mac) opens the command palette in any view: jump to a view or report section, switch theme, refresh data, search every incident, or ask Perplexity, ChatGPT or Claude about the query.

## Leaderboard (#leaderboard, #top)
- CoinGecko-style ranked table of year-to-date crypto hacks.
- Default sort is total amount lost, descending. Click Category or Amount lost (and Name or Date) to sort; click again to reverse.
- Category chips filter the table; the search box filters by name, chain or technique.
- Click a row to open a detail panel.

## Report section links
- Click Today / Live / Patterns / Crypto / Ransomware / Breaches / Exploited / Method in the report's top bar -> the report scrolls to that section; the link highlights.

## Summary + figure
- Abstract shows counts; 4 tick numbers; 3 rows of 30 day-squares.

## Lists
- Reported news: 8 entries then "Show all N" expands.
- Early signals on X: Fluidkey (+ any agent-added) with stage label.
- Crypto: 10 entries, "Read more" expands description, "Show all 51".
- Ransomware: group/sector/country bar tables, group names link to ransomware.live.
- KEV table with NVD / CISA KEV / X / Ask links.

## Ask
- Top-bar picker (Ask: Perplexity / ChatGPT / Claude) sets the assistant used by every Ask button, selection popover and `ask …` in the terminal. Remembered on this device.
- "Ask <assistant> about today" opens that assistant with today's summary prompt.
- Select text in an entry -> "Ask <assistant>" pop button appears -> opens with selection + section + entry + page URL.
- Each entry note and terminal detail has an "Ask <assistant>" link. ⌘K lists all three, chosen assistant first.
- ChatGPT and Claude prompts ask them to search the web; Perplexity already does.

# Requested change checks
- Every news / crypto / X / KEV item can be expanded to a detail panel: pattern, entry vector, technique, target, chains/vendor, CWE, loss, full text, sources.
- Detail panel lists similar incidents (with why) and links/jumps to them.
- New "Patterns" section: pattern x source counts; clusters of related incidents; clicking a pattern filters lists.
- Filter bar (pattern + text search) filters all lists; clearing restores.
