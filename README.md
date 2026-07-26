# Koers. — Radio Koers 🚴

Je eigen wielernieuws-app: elke 30 minuten worden 18+ nieuwsbronnen in 9 talen opgehaald, clustert Claude dubbele berichten tot één verhaal met Engelse samenvatting, en lees je alles in een app op je beginscherm. Tik OK ✓ en het item verdwijnt; via de bronknoppen klik je door naar het originele artikel.

## Installatie (± 10 minuten, het makkelijkst op een computer)

**1. Maak een repository**
Ga naar github.com → New repository → naam `koersradio` → zet op **Public** → Create.

**2. Upload deze bestanden**
Klik "uploading an existing file" en sleep de *inhoud* van deze map erin (behoud de mappenstructuur: `scripts/`, `docs/`, `.github/workflows/`, plus de losse bestanden). Commit.
> Tip: mappen slepen werkt alleen op desktop. Lukt het niet, gebruik dan "Add file → Create new file" en typ bij de bestandsnaam bv. `scripts/update.js` — GitHub maakt de map dan zelf aan.

**3. API-key toevoegen**
Maak een key aan op console.anthropic.com (API Keys → Create Key; je hebt een account met tegoed nodig — dit project kost doorgaans enkele centen per dag met het standaardmodel Haiku).
In je repo: Settings → Secrets and variables → **Actions** → New repository secret:
- Name: `ANTHROPIC_API_KEY`
- Secret: *(plak je key)*

**4. GitHub Pages aanzetten**
Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, map: `/docs` → Save.

**5. Eerste run starten**
Tab **Actions** → zonodig workflows enablen → "Update cycling news" → **Run workflow**. Na 1–2 minuten staat er nieuws klaar. In het log van de run zie je per bron ✓ of ✗ — een ✗ betekent dat die feed-URL niet klopt; pas hem dan aan in `feeds.json`.

**6. Op je telefoon zetten**
Open `https://JOUWNAAM.github.io/koersradio/` in Safari/Chrome → Deel → **Zet op beginscherm**. Klaar: de app ververst zichzelf elke keer dat je hem opent.

## Uitslagen & nieuwe bronnen
- **ProCyclingStats**: bij elke update worden de laatste uitslagen van procyclingstats.com opgehaald en als 🏆-kaart bovenaan de feed gezet (koers — winnaar, met link naar de volledige uitslag). Tik OK en hij verdwijnt tot de volgende dag. Verandert PCS zijn paginaopbouw, dan zie je "✗ ProCyclingStats" in het Actions-log en wordt de kaart gewoon overgeslagen.
- **Wekelijkse bronverkenning**: elke maandagochtend zoekt de workflow "Discover new sources" via Claude + web search naar wieler-RSS-feeds die nog niet in je lijst staan. Elke kandidaat wordt écht getest (parseerbaar, minimaal 2 recente artikelen) en alleen werkende feeds worden toegevoegd aan `feeds.json` (max 5 per week, max 40 totaal). Afgekeurde feeds komen in `feeds-rejected.json` zodat ze niet opnieuw worden geprobeerd. Bron verwijderen? Haal hem uit `feeds.json` en zet de url in `feeds-rejected.json`.

## Scorito
Elke dag verschijnt bovenin een 🎯-kaart met 6 Scorito-picks: renners die volgens de actuele PCS-vormranking in vorm zijn of volgens het nieuws toewerken naar een aankomend doel, elk met een korte motivatie. Tik OK en hij verdwijnt tot morgen. Daarnaast staan Scorito.com en Wielerorakel als kandidaat-bron in `feeds.json` — check in het Actions-log (✓/✗) of hun feed-url werkt en pas hem zonodig aan.

## Aanpassen
- **Bronnen**: bewerk `feeds.json` (naam, RSS-url, taalcode). Kapotte feeds worden automatisch overgeslagen.
- **Model**: standaard `claude-haiku-4-5` (goedkoop). Wil je betere samenvattingen, voeg in `.github/workflows/update.yml` onder `env:` toe: `KOERS_MODEL: claude-sonnet-4-6`.
- **Tijdvenster**: `HOURS` bovenin `scripts/update.js` (standaard 48 uur).
- **Frequentie**: de `cron`-regel in `.github/workflows/update.yml`.

## Hoe het werkt
`GitHub Actions (elke 30 min) → scripts/update.js haalt RSS-feeds op → Claude clustert & vat samen → docs/data.json → GitHub Pages serveert de app (docs/index.html)`. Gelezen items worden alleen op je eigen telefoon bewaard (localStorage).
