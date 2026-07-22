# Pendolarismo lavoro 2021

Mappa web dei flussi di pendolarismo per lavoro tra comuni italiani, dati ISTAT 2021. Visualizzazione ad archi (stile [regio.toekom.st](https://regio.toekom.st/)) su base MapLibre GL + deck.gl, filtri geografici a cascata e pannello statistiche per comune.


## Dati

- `dati/matrix_pendoLAVORO_2021.txt`: TSV ISTAT, 523.950 righe, colonne `Prov_res Procom_res Prov_lav Procom_lav Pendolari`. `Procom_*` = codice ISTAT comune (6 cifre), univoco a livello nazionale.
- Confini comunali: `comuni.pmtiles` (vector tiles, layer `comuni`, letto via HTTP range request, nessun tile server).

## Pipeline

Script one-off in `scripts/`, eseguiti localmente, output in `sito/data/`:

- `build_flows.py` → `sito/data/flows.json`: array di triple `[res, lav, pendolari]` da `matrix_pendoLAVORO_2021.txt`.
- `build_centroidi.py` → `sito/data/centroidi.json`: centroide + nome per ogni comune, estratto da `comuni.pmtiles`.

```bash
python scripts/build_flows.py
python scripts/build_centroidi.py
```

Test:

```bash
cd scripts && python -m pytest
```

## Sito

Statico, nessuna build: `sito/index.html` + `sito/js/app.js` + `sito/css/style.css`. Librerie da CDN: MapLibre GL JS, pmtiles, deck.gl.

Avvio locale:

```bash
cd sito && python -m http.server 8642
```

Poi apri `http://localhost:8642`.

### Funzionalità

- Basemap dark (CartoDB) con poligoni comunali semitrasparenti.
- Filtri a cascata regione → provincia → comune, sincronizzati con click/selezione sulla mappa.
- Archi uscita (residenti verso altri comuni) / entrata (occupati da altri comuni), spessore scalato su `sqrt(pendolari)`.
- Pannello laterale: totali residenti/interni/uscita/entrata, ranking comuni collegati, flussi cross-regione.
- Toggle "mostra tutti i collegamenti" (disattiva soglia top 25 / quota ≥1%).
- Tooltip on hover su comuni e archi.

## Riferimenti

- Design/spec: `docs/superpowers/specs/2026-07-21-mappa-pendolarismo-design.md`
- Piano: `docs/superpowers/plans/2026-07-21-mappa-pendolarismo.md`

## Licenza

Rilasciato sotto [Creative Commons Attribuzione 4.0 Internazionale (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/deed.it).

Sei libero di condividere e adattare il materiale, anche per uso commerciale, citando la fonte.
