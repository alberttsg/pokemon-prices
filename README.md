# pokemon-prices

Precios diarios de cartas Pokémon (TCGPlayer, vía [TCGCSV](https://tcgcsv.com)) para la app Mikon, con 90 días de histórico.

Una tarea de GitHub Actions (`.github/workflows/update-prices.yml`) ejecuta cada día `node build.mjs public` y publica el resultado en la rama `gh-pages` (GitHub Pages). El formato de los archivos está descrito al principio de `build.mjs`.
