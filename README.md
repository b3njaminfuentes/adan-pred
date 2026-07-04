# ADAN

Bot autónomo de paper trading para mercados **Polymarket crypto Up/Down de 5 a 15 minutos**. Lee el mercado cada minuto, propone lado con escáneres cuantitativos, arbitra riesgo con un LLM, ejecuta contra el libro real y aprende de cada resolución. Su propósito es uno solo: **demostrar edge verificable y superar el shadow gate de [Brier Protocol](https://brier.world) para abrir el primer vault.**

> Estado: **paper trading, edge no demostrado todavía.** Este README describe lo que el código hace hoy, no lo que aspiramos a que haga. El registro honesto empieza el 2026-07-04, después del recableado descrito abajo.

---

## Estado real

- **Corre en:** VPS Finlandia (pm2, `ADAN-MIND`) contra un Brier self-hosted, y una instancia sandbox en Mac (`start-adan.sh` watchdog). Rama activa: `fix/rewire-p0`.
- **Historial previo (2026-07-01 a 07-04):** 91 trades resueltos, 52.7% de aciertos, Brier interno 0.2592, fondo de papel -12.5%. Ese registro se midió con dos defectos graves ya corregidos (inversión de marco de probabilidad y fills sintéticos a precio medio), así que **no es evidencia ni a favor ni en contra del edge**. La calibración aprendida sobre esos datos fue reseteada.
- **Registro público en Brier:** limpio (1 predicción). La campaña oficial de 21 días empieza cuando el pipeline demuestre estabilidad.

## El camino del dinero (pipeline único)

Cada ~60 segundos (`SCAN_INTERVAL_MS`, `src/core/config.js`):

1. **Leer:** mercados crypto Up/Down con ventana **positivamente identificada de 5 o 15 min** (`fetchPolymarkets` + filtro estricto en `doScan`). Sin bid/ask real de dos puntas el mercado se descarta: **no existe fallback a precio 0.5** (`normalizePolymarket`, `src/api/polymarket.js`).
2. **Proponer:** los escáneres hijos (`CHILD_SPECS`, señales de RSI/volumen/VWAP/tendencia sobre Binance) eligen lado y confianza. Son el modelo primario: generaron el 100% de los trades reales desde el origen.
3. **Filtrar:** mispricing neto de fees > 3%, gate de confianza calibrada, dedup universal (una ventana de mercado = una posición), tilt guard por activo, circuit breaker por racha.
4. **Cotizar:** libro L2 en vivo por WebSocket del CLOB (144 assets, DNS bypass vía 1.1.1.1) con fallback a bestBid/bestAsk de Gamma. Veto de spread ancho (`OrderBookIntel`).
5. **EV real:** el valor esperado se calcula contra el **precio ejecutable** (ask para YES, 1-bid para NO), no contra el mid.
6. **Arbitrar:** una sola llamada LLM liviana como **meta-label** (López de Prado cap. 3): el lado ya está elegido, el LLM solo decide ejecutar o no y a qué fracción de tamaño. Timeout 8s, **fail-open**: si el LLM no responde, decide el quant. La cuota de Gemini nunca detiene la operación.
7. **Ejecutar:** fill taker al precio real del libro. La posición guarda `pSide`, `pYes`, `entryPrice`, `spreadAtEntry`, `conditionId`. El PnL a resolución paga contra el fill real más fee taker de Polymarket, sin simulación de slippage (el spread ya se pagó de verdad al entrar).
8. **Reportar:** commit a Brier antes de conocer el resultado, con `conditionId` CTF real y probabilidad en marco correcto (`src/api/brier-reporter.js`).

**Convención de marco de probabilidad (invariante):** `myProb` es **P(YES)** en todo el sistema. `pSide` es la confianza en el lado elegido. Los constructores de decisión convierten una sola vez; consumidores (Kelly, gate de EV, reportero) nunca re-flipean.

## Lo que aprende (vivo hoy)

- **Metacalibración:** cada resolución ajusta cuánto creerle a la confianza declarada, alimentada con confianza **cruda** (pre-calibración, para no componer el multiplicador sobre sí mismo). Reseteada el 2026-07-04.
- **Ledger cuantitativo** (`trades.jsonl`): cada trade fotografiado con marco, fill y spread reales. `learning_loop.js` diagnostica sangrado por régimen/hora/activo y aplica **mutaciones dirigidas cada 5 tandas de resoluciones**, sin esperar a que un drawdown dispare el dream mode.
- **Evolución de hijos** (`src/core/genetics.js`), con reglas estadísticas:
  - Calificación contra el precio de Binance **al cierre exacto de la ventana**, no al momento en que corre el loop.
  - **Absorción de ADN al padre solo con Wilson lower bound ≥ 0.50 y n ≥ 30 trades.** Nada de promover rachas de suerte.
  - **Bailout:** un hijo con evidencia de habilidad (Wilson ≥ 0.40, n ≥ 10) que quiebra en papel recibe recarga del tesoro y conserva ADN e historial. La quiebra contable no borra la evidencia estadística.
  - Crossover re-sortea `cognitiveStyle` y semilla de mutación (fix del colapso de diversidad que dejó 8 de 9 hijos idénticos).
- **Validación out-of-sample** (`walk_forward.js`, `purged_walkforward.js`, `calibrator.js` isotónico): implementadas y correctas, **dormidas por diseño** hasta acumular 100 a 250 trades resueltos limpios. Se activan solas con volumen.

## Lo estacionado (no borrado)

- **El oráculo multi-cerebro** (Golden Round Table, dual-AI, scenario forecaster): ejecutó 0 de los primeros 91 trades reales consumiendo ~670 llamadas LLM cada 2 días. Parked detrás de `ADAN_ORACLE=on`; revive el día que gane su lugar con datos.
- **SOUL narrativo:** las reglas autoeditadas nunca influyeron en el camino que opera. Duerme junto al oráculo.
- **Nietos por Monte Carlo sintético** (`child_learning.js`, linaje PERP): fitness contra precios `Math.random()`. No toca a los hijos de Polymarket. Auditar antes de cualquier uso con capital real.
- **Whale tracker / VPIN:** dormidos (fuentes de datos muertas o no verificadas).

## El objetivo: gate de Brier

La única prueba que cuenta es el registro público comprometido antes del hecho: **100 predicciones resueltas contra el precio real del CLOB, LCB > 0 sostenido, drawdown ≤ 25%, 21 días.** Si el edge existe (la hipótesis: los libros finos de 5-15 min se actualizan más lento que el order flow de Binance que ADAN lee), este pipeline lo demuestra barato y rápido. Si no existe, también lo demuestra, y eso vale igual: significa que el gate de Brier no deja pasar monedas al aire.

## Cómo correrlo

```bash
node --env-file=.env adan-pred.js     # directo
./start-adan.sh                       # con watchdog (mata y reinicia si el heartbeat envejece >5min)
pm2 start adan-pred.js --name ADAN-MIND --node-args="--env-file=.env"   # VPS
```

`.env` mínimo:

```
GEMINI_API_KEY=...        # router multi-modelo Gemini (free tier soportado, fail-open)
BRIER_URL=http://...      # instancia de Brier a la que reporta
BOT_SLUG=adan
BRIER_API_KEY=...
BRIER_API_SECRET=...
ADAN_MODE=LIVE            # LIVE aplica gates estrictos; TRAINING los relaja
# ADAN_ORACLE=on          # revive el cerebro oráculo (no recomendado)
```

Estado de runtime en `~/.adan-pred/` (posiciones, pnl, ledger, calibración, hijos). Los logs no se versionan.

## Límites conocidos (léase antes de creer cualquier número)

- **Es paper trading.** Los fills son taker contra el libro real pero sin impacto de mercado ni riesgo de cola de ejecución. Un PnL positivo acá es condición necesaria, no suficiente.
- **Edge no demostrado.** Hasta que el gate de Brier se cumpla con datos limpios, toda afirmación de rentabilidad es hipótesis.
- **Proveedor único de LLM** (Google, free tier, modelos preview). El pipeline sobrevive sin LLM por diseño, pero el arbitraje degrada a "siempre ejecutar".
- **config.json es mutado en runtime** por el sistema de influencias; genera conflictos de pull en deploy (workaround: `git checkout -- config.json` antes de pull).

## Estructura

```
adan-pred.js              loop principal, gates, evaluate_and_trade, resoluciones
adan-brain-complete.js    oráculo multi-cerebro (parked)
adan-llm-router.js        router Gemini multi-modelo con cuotas y backoff
src/api/polymarket.js     Gamma REST (DNS bypass), normalización con libro real
src/api/polymarket_ws.js  libro L2 del CLOB por WebSocket
src/api/brier-reporter.js commits a Brier Protocol (dedup, conditionId, marco P(YES))
src/core/genetics.js      evolución de hijos: torneo, absorción, bailout, crossover
src/core/child_learning.js shadows de hijos, calificación al cierre, DNA pools
src/core/learning_loop.js ledger, Wilson, mutaciones dirigidas
src/core/order_book.js    análisis de spread y veto
src/ml/                   walk-forward, purged CV, calibrador isotónico, ES, CUSUM (mayoría dormidos hasta tener volumen)
```

---

*Auditado adversarialmente y recableado el 2026-07-04. Historial completo en los mensajes de commit de la rama `fix/rewire-p0`.*
