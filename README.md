# ADAN

Bot autónomo de paper trading para mercados **Polymarket crypto Up/Down de 5 a 15 minutos**. Lee el mercado cada minuto, tasa la probabilidad de cierre con un modelo cerrado, arbitra el riesgo con un LLM, ejecuta contra el libro real y aprende de cada resolución. Tiene un solo propósito: **demostrar edge verificable y superar el shadow gate de [Brier Protocol](https://brier.world) para abrir el primer vault.**

> **Estado honesto (2026-07-05):** paper trading, edge todavía **no demostrado en la métrica que importa.** El motor está recableado y auditado; el registro público de Brier arranca por debajo de la línea y la campaña limpia recién empieza. Este README describe lo que el código hace hoy, no lo que aspiramos a que haga.

---

## El marcador que cuenta

Hay dos números y no son lo mismo. El honesto es el segundo.

| Métrica | Valor | Qué mide |
|---|---|---|
| Brier interno GAUSS | ~0.16 | Calibración absoluta del modelo contra el resultado |
| **Brier público (Brier Protocol)** | **~0.26** | Si ADAN le gana al **precio del mercado**, comprometido antes del hecho |
| relativeSkill | **negativo** | Skill sobre el baseline del CLOB (el gate exige > 0) |

Ganar apostando a favoritos casi seguros da un Brier absoluto lindo y plata de papel, pero no prueba nada: el mercado también lo sabía. El gate de Brier solo paga por ver lo que el precio no vio. Esa es la barra, y hoy no está cruzada. Las próximas ~90 predicciones limpias son el experimento real.

## El camino del dinero (pipeline único, cada ~60 s)

1. **Leer** — mercados crypto Up/Down con ventana de 5 o 15 min positivamente identificada. Sin bid/ask real de dos puntas el mercado se descarta: **no hay fallback a 0.5** (`src/api/polymarket.js`).
2. **Tasar (modelos primarios):**
   - **GAUSS** (`src/core/window_pricer.js`) — modelo de distribución terminal. A mitad de ventana, `P(UP) = Φ( ln(precio/inicio) / (σ·√min_restantes) )`, con precio spot fresco de Binance. Es la tesis del edge de latencia hecha pricing, no análisis técnico.
   - **Escáneres hijos** (`CHILD_SPECS`) — RSI/volumen/VWAP/tendencia; evolucionan por selección estadística.
3. **Filtrar** — mispricing neto de fees, gate de confianza calibrada, dedup por ventana, tilt guard temporal, circuit breaker, cotización descartada si tiene más de 25 s.
4. **Cotizar** — libro L2 en vivo por WebSocket del CLOB (DNS bypass), con fallback a Gamma. Veto de spread ancho (`OrderBookIntel`).
5. **EV real** — valor esperado contra el **precio ejecutable** (ask para YES, 1-bid para NO), no contra el mid.
6. **Arbitrar** — una llamada LLM liviana como **meta-label** (López de Prado cap. 3): el lado ya está elegido, el LLM solo decide ejecutar o no y a qué tamaño. Timeout 8 s, **fail-open**: si no responde, decide el quant.
7. **Ejecutar** — fill taker al precio real; la posición guarda `pSide`, `pYes`, `entryPrice`, `spreadAtEntry`, `conditionId`. PnL neto de fee taker de Polymarket, sin simulación de slippage (el spread se paga de verdad al entrar).
8. **Reportar** — commit a Brier antes de conocer el resultado, con `conditionId` CTF real y probabilidad en marco P(YES) (`src/api/brier-reporter.js`).

**Invariante de marco:** `myProb` es **P(YES)** en todo el sistema. `pSide` es la confianza en el lado elegido. Los productores convierten una vez; los consumidores (Kelly, EV, reporter) nunca re-flipean. Toda probabilidad clampeada a [0.03, 0.97].

## Lo que aprende (vivo)

- **Metacalibración** — cada resolución ajusta cuánto creerle a la confianza declarada; alimentada con confianza cruda; GAUSS excluido (escala distinta).
- **Ledger** (`trades.jsonl`) — cada trade con marco, fill y spread reales. `learning_loop.js` diagnostica sangrado por régimen/hora/activo y aplica **mutaciones dirigidas cada 5 tandas de resoluciones** sobre el singleton vivo de hijos.
- **Evolución** (`src/core/genetics.js`) — calificación contra el precio de Binance **al cierre exacto de la ventana**; absorción de ADN al padre solo con **Wilson ≥ 0.50 y n ≥ 30**; bailout de hijos hábiles y quebrados (máx. 3, conservan ADN e historial); crossover que re-sortea estilo cognitivo (fix del colapso de diversidad).
- **Validación out-of-sample** (`walk_forward.js`, `purged_walkforward.js`, `calibrator.js`) — implementadas y correctas, dormidas hasta acumular 100-250 resoluciones limpias. Se activan solas con volumen.

## Lo estacionado (no borrado)

- **Oráculo multi-cerebro** (Golden Round Table, dual-AI, scenario forecaster): ejecutó 0 de los primeros 91 trades reales. Parked detrás de `ADAN_ORACLE=on`.
- **SOUL narrativo, nietos Monte Carlo sintéticos (linaje PERP), whale tracker / VPIN**: dormidos hasta ganarse su lugar con datos.

## Endurecimiento (auditoría adversarial, 2026-07-04/05)

El motor pasó por dos auditorías adversariales multi-agente sobre el diff del recableado. Once defectos cazados y corregidos, dos de ellos críticos y ya activos en producción:

- **TILT GUARD** era un bloqueo permanente por activo (BTC/SOL muertos ~17 h); ahora es un cooldown temporal.
- **Grading al cierre** filtraba llamadas HTTP sin límite (800+ shadows atascadas ahogando el loop); ahora con caché, tope por ciclo y evicción.
- Más: probación de drawdown que no se respetaba, calificación con un minuto de retraso, mutaciones dirigidas que no mutaban nada, ensemble con marco invertido, meta-label descartado, fills contra cotizaciones viejas, bailout con presupuesto ilusorio, probabilidades sin clamp.

## Cómo correrlo

```bash
node --env-file=.env adan-pred.js     # directo
./start-adan.sh                       # con watchdog (mata y reinicia si el heartbeat envejece >5 min)
pm2 start adan-pred.js --name ADAN-MIND --node-args="--env-file=.env"   # VPS
```

`.env` mínimo:

```
GEMINI_API_KEY=...        # router multi-modelo Gemini (free tier, fail-open)
BRIER_URL=http://...      # instancia de Brier a la que reporta
BOT_SLUG=adan
BRIER_API_KEY=...
BRIER_API_SECRET=...
ADAN_MODE=LIVE            # LIVE aplica gates estrictos; TRAINING los relaja
# ADAN_ORACLE=on          # revive el cerebro oráculo (no recomendado)
```

Estado de runtime en `~/.adan-pred/`. Logs no versionados.

## Límites conocidos (léase antes de creer cualquier número)

- **Es paper trading.** Fills taker contra el libro real, pero sin impacto de mercado ni riesgo de cola de ejecución. PnL positivo acá es necesario, no suficiente.
- **Edge no demostrado.** Hasta que el relativeSkill en Brier cruce a positivo con datos limpios, toda rentabilidad es hipótesis.
- **Proveedor único de LLM** (Google, free tier). El pipeline sobrevive sin LLM; el arbitraje degrada a "siempre ejecutar".
- **config.json mutado en runtime** por el sistema de influencias; conflictos de pull en deploy (workaround: `git checkout -- config.json` antes de pull).

## Estructura

```
adan-pred.js              loop principal, gates, evaluate_and_trade, resoluciones
adan-llm-router.js        router Gemini multi-modelo con cuotas y backoff
adan-brain-complete.js    oráculo multi-cerebro (parked)
src/core/window_pricer.js GAUSS: pricer de distribución terminal (modelo primario)
src/core/genetics.js      evolución de hijos: torneo, absorción, bailout, crossover
src/core/child_learning.js shadows de hijos, calificación al cierre, DNA pools
src/core/learning_loop.js ledger, Wilson, mutaciones dirigidas
src/core/order_book.js    análisis de spread y veto
src/api/polymarket.js     Gamma REST (DNS bypass), normalización con libro real
src/api/polymarket_ws.js  libro L2 del CLOB por WebSocket
src/api/brier-reporter.js commits a Brier Protocol (dedup, conditionId, marco P(YES))
src/ml/                   walk-forward, purged CV, calibrador isotónico, ES, CUSUM (dormidos hasta tener volumen)
```

---

*Recableado, auditado dos veces y congelado el 2026-07-05. La disciplina ahora es no tocar el motor y dejar que el registro de Brier responda. Historial completo en los commits de la rama `fix/rewire-p0`.*
