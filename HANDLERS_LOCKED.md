# Handlers bloqueados — NO TOCAR sin permiso explícito

**Vigente desde:** 2026-05-06.

Estos archivos / bloques contienen lógica que ya funciona (o estaba estable) y se rompió en sesiones anteriores por edits "de paso". A partir de hoy:

- **NO** se editan sin instrucción explícita del usuario nombrando el archivo.
- **NO** se "limpian", "refactorizan" ni se aplican fixes laterales aunque parezcan obvios.
- Antes de cualquier commit que toque uno de estos archivos, **mostrar el diff completo al usuario y esperar confirmación**. Sin commits ciegos.

## Lista

| Archivo / bloque | Estado | Última referencia conocida |
|---|---|---|
| `services/handlers/benavidesHandler.js` | **FUNCIONAL** | commit `b73d92b` o posterior (2026-05-06) |
| `services/handlers/alseaHandler.js` | **🔒 LOCKED — FUNCIONAL al 6/may/2026 — primera factura Starbucks timbrada exitosamente vía paso 2 backend HTTP (commit `7c85cf5`). Endpoint usado: `ValidaPagina2Facturar`. Multi-marca soportada (Starbucks, Vips, Domino's, Burger King, Chili's, P.F. Chang's, Italianni's). Response esperado: `nivel:99` + mensaje HTML. NO TOCAR sin autorización explícita nombrando "alsea" o "alseaHandler.js".** | commit `7c85cf5` |
| `services/handlers/hebHandler.js` | **PENDIENTE VERIFICAR** — tratar como si funcionara | — |
| `services/handlers/costcoHandler.js` | **EN MODIFICACIÓN ACTIVA — sesión 2026-05-06.** Token OAuth público obtenido vía `POST /portales/oauth/estilos`. Aplicado: LOTE-1 (handler completo con 3 POSTs encadenados). | — |
| Bloque Home Depot dentro de `services/automationService.js` (`PORTALES['home depot']`, ~línea 61) | **🔒 LOCKED — FUNCIONAL al 6/may/2026** | commit `e73bf8e` |
| Bloque Petro7 dentro de `services/automationService.js` (`PORTALES['petro']`, ~línea 651) | **FUNCIONAL** | — |

## ⚠️ ATENCIÓN — HANDLER PROTEGIDO: Home Depot

Home Depot timbró exitosamente 2 facturas reales el 6/may/2026:
- Folio CFDI `63707` ($267, FOCO LED + LUMINARIO LED) — commit `1bcd795`
- Folio CFDI `63722` ($169, LUMINARIO LED) — verificado en logs

**Fixes aplicados que componen este estado funcional:**
- **F1** (commit `220a444`): URL CapSolver sin puerto `:2053`
- **F2-A + F2-C LOTE 1** (commit `01cd390`): `indexSerieTienda`, tipos cruzados (`tipoComprobante`/`tipoDocumento`), `tickets` como array de strings, direcciones placeholder (`NO ESPECIFICADO` / `S/N`), removido campo `cliente` sobrante
- **F2-LOTE-2** (commit `1bcd795`): mapeo `IVA → 002` al catálogo SAT `c_Impuesto`

**NO TOCAR este bloque bajo NINGUNA circunstancia sin autorización explícita del usuario** nombrando "home depot" o "automationService.js > home depot" en el mismo turno. Esta regla aplica a Claude (cualquier sesión), a otros asistentes, y al usuario en un descuido. Si el usuario abre una sesión y pide algo que indirectamente toque este bloque sin nombrarlo, **hay que pedir confirmación primero**.

**Mejoras pendientes que NO se aplican (porque ya funciona):**
- **F2-B** — objetos `emisor`/`tienda` completos en payload (hoy van con 4 y 2 campos respectivamente).
- **F2-D** — usar totales servidos por `agregarTicket` en lugar de recalcular desde conceptos.

Estas mejoras quedan documentadas como **deuda técnica conocida** pero NO se aplican porque el handler ya entrega facturas exitosamente. Aplicarlas sin razón implica riesgo de regresión.

## Qué SÍ se puede tocar libremente

Cualquier archivo que **no** esté en la lista de arriba (handlerUniversal, claudeAgent, scout, agentService, rutas, OCR, etc.) — siempre que la tarea esté instruida por el usuario.

## Cómo desbloquear

El usuario puede levantar el lock de un archivo en cualquier momento diciéndolo explícitamente ("desbloquea X" / "ya puedes editar X"). Cuando eso pase, actualizar este archivo en el mismo commit que el cambio.
