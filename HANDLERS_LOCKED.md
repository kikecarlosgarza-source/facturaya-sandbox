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
| `services/handlers/alseaHandler.js` | **FUNCIONAL** — paso 1 HTTP, paso 2 vía WebView | — |
| `services/handlers/hebHandler.js` | **PENDIENTE VERIFICAR** — tratar como si funcionara | — |
| Bloque Home Depot dentro de `services/automationService.js` (`PORTALES['home depot']`, ~línea 61) | **FUNCIONAL al 6/may/2026 — primera factura timbrada exitosamente (commit `1bcd795`). Serie `4KHFEBI`, Folio `63707`. Fixes aplicados: F1 (CapSolver sin puerto), F2-A + F2-C LOTE 1 (indexSerieTienda + payload reformado), F2-LOTE-2 (impuesto IVA→002 catálogo SAT). NO TOCAR sin permiso explícito. F2-B (emisor/tienda completos) y F2-D (totales servidos) quedan como mejoras opcionales pendientes — NO aplicar sin autorización porque ya está funcionando.** | `1bcd795` |
| Bloque Petro7 dentro de `services/automationService.js` (`PORTALES['petro']`, ~línea 651) | **FUNCIONAL** | — |

## Qué SÍ se puede tocar libremente

Cualquier archivo que **no** esté en la lista de arriba (handlerUniversal, claudeAgent, scout, agentService, rutas, OCR, etc.) — siempre que la tarea esté instruida por el usuario.

## Cómo desbloquear

El usuario puede levantar el lock de un archivo en cualquier momento diciéndolo explícitamente ("desbloquea X" / "ya puedes editar X"). Cuando eso pase, actualizar este archivo en el mismo commit que el cambio.
