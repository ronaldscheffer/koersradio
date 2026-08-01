// KoersRadio bronverkenner — draait wekelijks via GitHub Actions.
// Vraagt Claude (met web search) om RSS-feeds van wielernieuwssites die nog niet
// in feeds.json staan, test elke kandidaat écht (parseerbaar + recente artikelen),
// en voegt alleen werkende feeds toe. Afgekeurde feeds worden onthouden.

import Parser from "rss-parser";
import fs from "fs";

const FEEDS_FILE = "feeds.json";
const REJECTED_FILE = "feeds-rejected.json";
const MAX_ADD_PER_RUN = 5;
const MAX_TOTAL = 40;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.KOERS_DISCOVER_MODEL || "claude-sonnet-4-6";

if (!API_KEY) { console.error("ANTHROPIC_API_KEY ontbreekt."); process.exit(1); }

const feeds = JSON.parse(fs.readFileSync(FEEDS_FILE, "utf8"));
let rejected = [];
try { rejected = JSON.parse(fs.readFileSync(REJECTED_FILE, "utf8")); } catch {}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const knownHosts = new Set([...feeds.map((f) => host(f.url)), ...rejected.map(host)]);

// Claude met web search; zet gesprek voort bij pause_turn
async function askClaude(prompt) {
  const messages = [{ role: "user", content: prompt }];
  let text = "";
  for (let turn = 0; turn < 6; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    text += (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (data.stop_reason === "pause_turn" || data.stop_reason === "max_tokens") {
      messages.push({ role: "assistant", content: data.content });
      if (data.stop_reason === "max_tokens") messages.push({ role: "user", content: "Continue, output only the remaining JSON." });
      continue;
    }
    break;
  }
  return text;
}

const prompt = `Find RSS/Atom feed URLs of professional road cycling news websites that are NOT already on this list of domains: ${[...knownHosts].join(", ")}.

Search the web for cycling news sites in any language (Dutch, French, Italian, Spanish, Danish, Slovenian, German, English, Basque, Norwegian, etc.) and locate their actual RSS feed URLs (often /feed/, /rss, or linked in the page head).

Respond ONLY with valid JSON, no markdown:
{"candidates":[{"name":"Site name","url":"https://direct-rss-feed-url","lang":"two-letter language code"}]}
"lang" must reflect the LANGUAGE the articles are written in, not the country: e.g. a Flemish/Belgian site (like Sporza, HLN) is "nl", a French-Canadian site is "fr" — never a country code like "be".
Max 10 candidates. Only include URLs you have strong reason to believe are real feed endpoints.`;

console.log(`Bekende bronnen: ${feeds.length}. Op zoek naar nieuwe…`);
let candidates = [];
try {
  const raw = await askClaude(prompt);
  const start = raw.indexOf('{"candidates"');
  candidates = start >= 0 ? (JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1))?.candidates || []) : [];
} catch (e) {
  console.error("Claude-fout: " + e.message);
  process.exit(0); // geen wijzigingen, geen mislukte workflow
}
console.log(`${candidates.length} kandidaten om te testen.`);

const parser = new Parser({ timeout: 20000, headers: { "User-Agent": "Mozilla/5.0 (compatible; KoersRadio/1.0)" } });
const fresh14d = Date.now() - 14 * 24 * 3600 * 1000;
let added = 0;

for (const c of candidates) {
  if (added >= MAX_ADD_PER_RUN || feeds.length >= MAX_TOTAL) break;
  if (!c?.url || !c?.name || knownHosts.has(host(c.url))) continue;
  try {
    const feed = await parser.parseURL(c.url);
    const recent = (feed.items || []).filter((it) => {
      const d = new Date(it.isoDate || it.pubDate || 0);
      return it.title && it.link && !isNaN(d) && d.getTime() > fresh14d;
    });
    if (recent.length < 2) throw new Error(`slechts ${recent.length} recente artikelen`);
    feeds.push({ name: c.name, url: c.url, lang: (c.lang || "en").slice(0, 2).toLowerCase() });
    knownHosts.add(host(c.url));
    added++;
    console.log(`✚ toegevoegd: ${c.name} (${c.url})`);
  } catch (e) {
    rejected.push(c.url);
    knownHosts.add(host(c.url));
    console.log(`✗ afgekeurd: ${c.name} — ${e.message}`);
  }
}

fs.writeFileSync(FEEDS_FILE, JSON.stringify(feeds, null, 2) + "\n");
fs.writeFileSync(REJECTED_FILE, JSON.stringify([...new Set(rejected)].slice(-200), null, 2) + "\n");
console.log(`Klaar: ${added} nieuwe bron(nen), totaal ${feeds.length}.`);
