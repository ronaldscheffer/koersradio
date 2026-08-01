# CLAUDE.md — Koersradio

Persoonlijke wielernieuws-PWA van Ronald. Live op https://ronaldscheffer.github.io/koersradio/

## Architectuur
- `scripts/update.js` — draait elke 30 min via GitHub Actions (`.github/workflows/update.yml`, timeout 15 min):
  haalt RSS-feeds uit `feeds.json` (48u-venster) → clustert nieuwe items met Claude API →
  vertaalpas (batches, NL-titels blijven NL, andere talen → Engels + categorie) → samenvoegpas (bestaande dubbele
  verhalen fuseren, oudste id behouden i.v.m. gelezen-status) → uitslagenkaart (ProCyclingStats-scrape;
  bij blokkade vangnet: uitslagen uit nieuwskoppen via Claude) → dagelijkse Scorito-pickskaart
  (PCS-vormranking + nieuws) → schrijft `docs/data.json` → `process.exit(0)` (belangrijk: zonder
  expliciete exit blijft het proces hangen op open verbindingen).
- `scripts/discover.js` — wekelijks (`discover.yml`, ma 06:00): zoekt via Claude + web search nieuwe
  wieler-RSS-feeds, valideert ze echt (parseerbaar, ≥2 recente items), voegt werkende toe aan
  `feeds.json`, afgekeurde naar `feeds-rejected.json`. Max 5/week, 40 totaal.
- `docs/` — statische PWA op GitHub Pages (main:/docs). `index.html` leest `data.json`;
  OK ✓-knop verbergt items via localStorage (`koersradio_read`, group-id's).
- Secret: `ANTHROPIC_API_KEY`. Modellen: updater `claude-haiku-4-5`, discovery `claude-sonnet-4-6`
  (overschrijfbaar via env `KOERS_MODEL` / `KOERS_DISCOVER_MODEL`).

## Datamodel (docs/data.json)
`{updated, groups:[{id, t (titel: NL blijft NL, andere talen → EN), s (samenvatting), c (race|transfer|gear|health|other), date,
sources:[{n,u,l}], type? ("results"|"picks" voor de kaarten, met rows), tr? (1 = vertaald)}]}`
- `s` leeg + geen `tr` = onvertaald vangnet-item (vertaalpas pakt het op).
- `id` nooit wijzigen bij bestaande groepen: de gelezen-status op telefoons hangt eraan.

## Geleerde lessen (niet opnieuw tegenaan lopen)
- ALLE netwerkcalls hebben harde time-outs (tfetch/AbortSignal + Promise.race per feed) én er is
  een 10-min waakhond; ProCyclingStats en sommige feeds blokkeren of vertragen GitHub-runners.
- Het Nieuwsblad, Wielerorakel (403) en Scorito (geen RSS) werken niet als feed; Scorito-tips
  komen uit de dagelijkse 🎯-kaart. Sporza/Gazzetta-feed-url's zijn onzeker: check ✓/✗ in het Actions-log.
- In workflows: `git pull --rebase` ná de commit-stap, anders faalt de push.
- API-antwoorden altijd via `extractJSON()` parsen (modellen leveren soms tekst rond de JSON).

## Wensen van Ronald
Compacte feed zonder dubbelingen; NL-bronnen blijven NL, andere talen → EN (app-UI). Scorito-speler: vorm/piek-info
is welkom. Kosten laag houden (Haiku).
