// KoersRadio updater — draait via GitHub Actions.
// 1. Haalt alle RSS-feeds uit feeds.json op (kapotte feeds worden overgeslagen)
// 2. Filtert artikelen van de laatste 48 uur
// 3. Laat Claude nieuwe artikelen clusteren met bestaande groepen en samenvatten
// 4. Schrijft docs/data.json die de app uitleest

import Parser from "rss-parser";
import fs from "fs";
import crypto from "crypto";

const HOURS = 48;
const MAX_NEW_PER_RUN = 80;
const DATA_FILE = "docs/data.json";
const MODEL = process.env.KOERS_MODEL || "claude-haiku-4-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY ontbreekt (repo Settings → Secrets → Actions).");
  process.exit(1);
}

// waakhond: kapt het script zelf af als iets ondanks alle time-outs toch blijft hangen
const watchdog = setTimeout(() => {
  console.error("WAAKHOND: script draaide 10 min — afgebroken. Kijk hierboven welke bron als laatste werd gelogd.");
  process.exit(1);
}, 10 * 60 * 1000);
watchdog.unref();

const feeds = JSON.parse(fs.readFileSync("feeds.json", "utf8"));
const parser = new Parser({
  timeout: 20000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; KoersRadio/1.0)" },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// fetch met harde time-out; voorkomt dat één hangende verbinding de hele run blokkeert
const tfetch = (url, opts = {}, ms = 60000) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const cutoff = Date.now() - HOURS * 3600 * 1000;

// ——— 1+2: feeds ophalen ———
async function fetchAll() {
  const items = [];
  await Promise.all(
    feeds.map(async (f) => {
      try {
        const feed = await Promise.race([
          parser.parseURL(f.url),
          new Promise((_, rej) => { const t = setTimeout(() => rej(new Error("feed-timeout 25s")), 25000); t.unref(); }),
        ]);
        let n = 0;
        for (const it of feed.items || []) {
          const d = new Date(it.isoDate || it.pubDate || 0);
          if (!it.link || !it.title || isNaN(d) || d.getTime() < cutoff) continue;
          items.push({
            title: it.title.trim().replace(/\s+/g, " "),
            url: it.link.split("?utm")[0],
            date: d.toISOString(),
            source: f.name,
            lang: f.lang,
          });
          n++;
        }
        console.log(`✓ ${f.name}: ${n} recente artikelen`);
      } catch (e) {
        console.log(`✗ ${f.name}: ${e.message}`);
      }
    })
  );
  return items;
}

// ——— Claude API ———
async function askClaude(prompt) {
  for (let a = 0; a < 3; a++) {
    const res = await tfetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    }, 90000);
    const data = await res.json();
    if (data.error) {
      if (/overload|rate|529/i.test(data.error.type + data.error.message) && a < 2) {
        await new Promise((r) => setTimeout(r, 20000));
        continue;
      }
      throw new Error(data.error.message);
    }
    return (data.content || []).map((b) => b.text || "").join("");
  }
  throw new Error("API unavailable");
}

// ——— ProCyclingStats: laatste uitslagen van de homepage ———
async function fetchPCSResults() {
  try {
    const res = await tfetch("https://www.procyclingstats.com/", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KoersRadio/1.0)" },
    }, 30000);
    const html = await res.text();
    const rows = [];
    const push = (race, winner, link) => {
      race = race.replace(/\s+/g, " ").trim();
      winner = winner.replace(/\s+/g, " ").trim();
      if (race && winner && !rows.some((r) => r.race === race && r.winner === winner)) {
        rows.push({ race, winner, url: "https://www.procyclingstats.com/" + link });
      }
    };
    // patroon A: race-link gevolgd door renner-link; patroon B: omgekeerd
    const reA = /<a[^>]+href="(race\/[^"]+)"[^>]*>([^<]{3,80})<\/a>([\s\S]{0,400}?)<a[^>]+href="rider\/[^"]+"[^>]*>([^<]{3,60})<\/a>/g;
    const reB = /<a[^>]+href="rider\/[^"]+"[^>]*>([^<]{3,60})<\/a>([\s\S]{0,400}?)<a[^>]+href="(race\/[^"]+)"[^>]*>([^<]{3,80})<\/a>/g;
    let m;
    while ((m = reA.exec(html)) && rows.length < 12) push(m[2], m[4], m[1]);
    while ((m = reB.exec(html)) && rows.length < 12) push(m[4], m[1], m[3]);
    console.log(rows.length ? `✓ ProCyclingStats: ${rows.length} uitslagen` : "✗ ProCyclingStats: geen uitslagen herkend (paginastructuur gewijzigd?)");
    return rows;
  } catch (e) {
    console.log(`✗ ProCyclingStats: ${e.message}`);
    return [];
  }
}

// ——— ProCyclingStats: actuele vormranking (basis voor Scorito-tips) ———
async function fetchPCSForm() {
  try {
    const res = await tfetch("https://www.procyclingstats.com/rankings.php?p=form", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KoersRadio/1.0)" },
    }, 30000);
    const html = await res.text();
    const riders = [];
    const re = /href="(rider\/[^"]+)"[^>]*>([^<]{3,40})<\/a>[\s\S]{0,250}?>(\d{2,5})</g;
    let m;
    while ((m = re.exec(html)) && riders.length < 15) {
      const name = m[2].replace(/\s+/g, " ").trim();
      if (!riders.some((r) => r.name === name)) riders.push({ name, pts: m[3] });
    }
    console.log(riders.length ? `✓ PCS vormranking: ${riders.length} renners` : "✗ PCS vormranking: niets herkend");
    return riders;
  } catch (e) {
    console.log(`✗ PCS vormranking: ${e.message}`);
    return [];
  }
}

function extractJSON(raw, key) {
  const clean = raw.replace(/```json|```/g, "").trim();
  const start = clean.indexOf(`{"${key}"`);
  if (start === -1) return null;
  try { return JSON.parse(clean.slice(start)); } catch { return null; }
}

// ——— main ———
const articles = await fetchAll();
console.log(`Totaal ${articles.length} artikelen binnen ${HOURS}u.`);

let data = { updated: null, groups: [] };
try { data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}

// oude groepen buiten het venster weggooien
data.groups = (data.groups || []).filter((g) => new Date(g.date).getTime() >= cutoff);

const seen = new Set(data.groups.flatMap((g) => g.sources.map((s) => s.u)));
const fresh = articles.filter((a) => !seen.has(a.url)).slice(0, MAX_NEW_PER_RUN);
console.log(`${fresh.length} nieuwe artikelen om te clusteren.`);

if (fresh.length) {
  const existing = data.groups.map((g, i) => `G${i}: ${g.t}`).join("\n") || "(none)";
  const fresh_list = fresh.map((a, i) => `N${i} [${a.lang}] ${a.title} (${a.source})`).join("\n");
  const prompt = `You cluster cycling news. Headlines are in several languages; the same story across languages belongs in ONE group.

Headlines about the same race, same rider(s), and same result/event are ONE story — merge them even if they cover different angles (the result itself, a post-race quote, a record/stat note, a recap, a preview) or are phrased very differently. Live races produce bursts of headlines like this within minutes of each other; treat that as the normal case to merge, not the exception. Only keep headlines apart when they are about genuinely different races, riders, or events.

EXISTING groups:
${existing}

NEW headlines:
${fresh_list}

Assign every NEW headline: either to an existing group (if same story) or to a new group with the other new headlines about that story. For each NEW group write a title (t) and a 1-2 sentence summary (s) in natural Dutch, regardless of the source language(s) of the underlying headlines. Also assign a category (c: race|transfer|gear|health|other).

Respond ONLY with valid JSON, no markdown:
{"groups":[{"g":"G2","m":[0,4]},{"g":"new","m":[1,3],"t":"...","s":"...","c":"race"}]}
Every N-index appears exactly once. "m" holds N-indices as numbers.`;

  let assigned = null;
  try {
    assigned = extractJSON(await askClaude(prompt), "groups");
  } catch (e) {
    console.log(`Claude-fout: ${e.message} — artikelen worden ongesorteerd toegevoegd.`);
  }

  const used = new Set();
  const addTo = (group, idxs) => {
    for (const i of idxs) {
      const a = fresh[i];
      if (!a || used.has(i)) continue;
      used.add(i);
      if (!group.sources.some((s) => s.u === a.url)) {
        group.sources.push({ n: a.source, u: a.url, l: a.lang });
      }
      if (new Date(a.date) > new Date(group.date)) group.date = a.date;
    }
  };

  for (const g of assigned?.groups || []) {
    const idxs = (g.m || []).filter((i) => Number.isInteger(i) && fresh[i]);
    if (!idxs.length) continue;
    if (g.g && g.g !== "new") {
      const ex = data.groups[parseInt(g.g.slice(1), 10)];
      if (ex) { addTo(ex, idxs); continue; }
    }
    const first = fresh[idxs[0]];
    const grp = {
      id: hash(first.url),
      t: g.t || first.title,
      s: g.s || "",
      c: g.c || "other",
      date: first.date,
      sources: [],
    };
    addTo(grp, idxs);
    data.groups.push(grp);
  }
  // vangnet: alles wat Claude oversloeg wordt een eigen groep
  fresh.forEach((a, i) => {
    if (used.has(i)) return;
    data.groups.push({ id: hash(a.url), t: a.title, s: "", c: "other", date: a.date, sources: [{ n: a.source, u: a.url, l: a.lang }] });
  });
}

// ——— vertaalpas: alle titels in batches naar het Nederlands,
// inclusief een passende categorie (haalt ook de oude achterstand weg) ———
for (let batch = 0; batch < 6; batch++) {
  const todo = data.groups.filter((g) => !g.type && !g.s && !g.tr).slice(0, 40);
  if (!todo.length) break;
  try {
    const raw = await askClaude(`These cycling headlines are in various languages (lang shown in brackets). Translate every headline to natural Dutch (if already Dutch, just clean it up naturally, keep the meaning unchanged). Assign a category (race|transfer|gear|health|other) for every headline. Respond ONLY with valid JSON, no markdown, same count and order:
{"t":[{"t":"Dutch headline","c":"race"}]}
Headlines:
${todo.map((g, i) => `${i} [${g.sources?.[0]?.l || "?"}]: ${g.t}`).join("\n")}`);
    const t = extractJSON(raw, "t")?.t;
    if (!Array.isArray(t)) break;
    todo.forEach((g, i) => {
      if (t[i]?.t) { g.t = String(t[i].t); g.c = t[i].c || g.c; g.tr = 1; }
    });
    console.log(`✓ vertaalpas batch ${batch + 1}: ${todo.length} titels`);
  } catch (e) {
    console.log(`✗ vertaalpas: ${e.message}`);
    break;
  }
}

// ——— samenvoegpas: bestaande items over hetzelfde verhaal fuseren tot één ———
const newsGroups = data.groups.filter((g) => !g.type).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 150);
if (newsGroups.length > 1) {
  try {
    const raw = await askClaude(`These are cycling news items, sometimes in different languages. Different items about the SAME underlying story — the same race, the same rider(s), the same result or event (e.g. "Pogacar wins the Tour" reported by several outlets or languages, previews of the same stage, the same transfer rumour) — must be grouped, even if they cover different angles (the result itself, a post-race quote, a record/stat note, a recap, a preview) or are phrased very differently. Live races produce bursts of near-duplicate headlines about the same result within minutes of each other — merge those aggressively.

Items:
${newsGroups.map((g, i) => `${i}: ${g.t}`).join("\n")}

Respond ONLY with valid JSON, no markdown: {"g":[[0,5,12],[3,7]]}
List ONLY groups with 2 or more members. Each index at most once. Only skip grouping when you are unsure whether two items are about different races, riders, or events entirely.`);
    const g = extractJSON(raw, "g")?.g || [];
    const removed = new Set();
    for (const grp of g) {
      const members = grp
        .filter((i) => Number.isInteger(i) && newsGroups[i] && !removed.has(newsGroups[i].id))
        .map((i) => newsGroups[i]);
      if (members.length < 2) continue;
      members.sort((a, b) => new Date(a.date) - new Date(b.date)); // oudste behoudt zijn id (gelezen-status)
      const keep = members[0];
      for (const m of members.slice(1)) {
        for (const src of m.sources || []) {
          if (!keep.sources.some((x) => x.u === src.u)) keep.sources.push(src);
        }
        if (new Date(m.date) > new Date(keep.date)) keep.date = m.date;
        if (!keep.s && m.s) keep.s = m.s;
        removed.add(m.id);
      }
    }
    if (removed.size) {
      data.groups = data.groups.filter((x) => !removed.has(x.id));
      console.log(`✓ samenvoegpas: ${removed.size} dubbele items gefuseerd`);
    } else {
      console.log("✓ samenvoegpas: geen dubbelingen gevonden");
    }
  } catch (e) {
    console.log(`✗ samenvoegpas: ${e.message}`);
  }
}

// ——— uitslagenkaart (dagelijks vernieuwd; OK verbergt hem tot morgen) ———
let pcsRows = await fetchPCSResults();
if (!pcsRows.length) {
  // PCS blokkeert GitHub-servers soms; haal uitslagen dan uit de nieuwskoppen zelf
  try {
    const heads = data.groups.filter((g) => !g.type).slice(0, 50).map((g) => "- " + g.t).join("\n");
    const raw = await askClaude(`From these cycling headlines, extract explicit race RESULTS only (a rider winning a named race/stage). Respond ONLY with valid JSON, no markdown:
{"res":[{"race":"Race or stage","winner":"Rider"}]}
Max 10. Skip anything uncertain.
Headlines:
${heads}`);
    const res = extractJSON(raw, "res")?.res || [];
    pcsRows = res.filter((r) => r?.race && r?.winner).map((r) => ({
      race: r.race, winner: r.winner,
      url: "https://www.procyclingstats.com/search.php?term=" + encodeURIComponent(r.race),
    }));
    console.log(pcsRows.length ? `✓ uitslagen uit nieuwskoppen: ${pcsRows.length}` : "✗ ook geen uitslagen in de koppen gevonden");
  } catch (e) { console.log(`✗ uitslagen-vangnet: ${e.message}`); }
}
data.groups = data.groups.filter((g) => g.type !== "results");
if (pcsRows.length) {
  data.groups.push({
    id: "results-" + new Date().toISOString().slice(0, 10),
    type: "results",
    t: "Laatste uitslagen — ProCyclingStats",
    s: "",
    c: "race",
    date: new Date().toISOString(),
    rows: pcsRows,
    sources: [{ n: "ProCyclingStats", u: "https://www.procyclingstats.com/", l: "en" }],
  });
}

// ——— Scorito-tips: 1x per dag, op basis van PCS-vorm + het nieuws van nu ———
const today = new Date().toISOString().slice(0, 10);
const hasPicksToday = data.groups.some((g) => g.id === "scorito-" + today);
data.groups = data.groups.filter((g) => g.type !== "picks" || g.id === "scorito-" + today);
if (!hasPicksToday) {
  const form = await fetchPCSForm();
  const newsCtx = data.groups.filter((g) => !g.type).slice(0, 40).map((g) => "- " + g.t).join("\n");
  const formCtx = form.map((r) => `${r.name} (${r.pts} form pts)`).join(", ") || "(unavailable)";
  try {
    const raw = await askClaude(`You advise players of Scorito, a fantasy cycling game where you pick riders for upcoming races.

Current PCS form ranking (last weeks): ${formCtx}

Cycling news headlines from the last 48h:
${newsCtx || "(none)"}

Give 6 Scorito picks: riders who are clearly in form right now, or visibly building toward an upcoming goal race mentioned in the news. Mix both types. Base every pick ONLY on the data above — do not invent results.

Respond ONLY with valid JSON, no markdown:
{"picks":[{"r":"Rider Name","w":"one short Dutch line: why, and for which upcoming race if known"}]}`);
    const picks = extractJSON(raw, "picks")?.picks?.filter((p) => p?.r && p?.w).slice(0, 8) || [];
    if (picks.length) {
      data.groups.push({
        id: "scorito-" + today,
        type: "picks",
        t: "Scorito-tips — renners in vorm",
        s: "",
        c: "race",
        date: new Date().toISOString(),
        rows: picks,
        sources: [{ n: "PCS form ranking", u: "https://www.procyclingstats.com/rankings.php?p=form", l: "en" }],
      });
      console.log(`✓ Scorito-tips: ${picks.length} picks`);
    } else {
      console.log("✗ Scorito-tips: geen bruikbare picks in het antwoord");
    }
  } catch (e) {
    console.log(`✗ Scorito-tips: ${e.message}`);
  }
}

data.groups.sort((a, b) => new Date(b.date) - new Date(a.date));
data.updated = new Date().toISOString();
fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 1));
console.log(`Klaar: ${data.groups.length} nieuwsgroepen in ${DATA_FILE}.`);
process.exit(0); // expliciet afsluiten: open verbindingen kunnen het proces anders laten hangen
