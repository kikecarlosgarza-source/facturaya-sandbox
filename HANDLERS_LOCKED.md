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
| Bloque Home Depot dentro de `services/automationService.js` (`PORTALES['home depot']`, ~línea 61) | **PAUSADO** — no tocar hasta nueva orden | — |
| Bloque Petro7 dentro de `services/automationService.js` (`PORTALES['petro']`, ~línea 651) | **FUNCIONAL** | — |

## Qué SÍ se puede tocar libremente

Cualquier archivo que **no** esté en la lista de arriba (handlerUniversal, claudeAgent, scout, agentService, rutas, OCR, etc.) — siempre que la tarea esté instruida por el usuario.

## Cómo desbloquear

El usuario puede levantar el lock de un archivo en cualquier momento diciéndolo explícitamente ("desbloquea X" / "ya puedes editar X"). Cuando eso pase, actualizar este archivo en el mismo commit que el cambio.
