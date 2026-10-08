---
trigger: always_on
description: Reglas Obligatorias y Anti-Patrones — antigravity-account
---
# Reglas Obligatorias del Proyecto (antigravity-account)
Estas reglas han sido registradas en Obsidian Second Brain y son de OBLIGATORIO CUMPLIMIENTO en cada intervencion del agente en este workspace:
## Condiciones y Flujo de Trabajo
- `[2026-10-05]` [antigravity-account] Nunca reducir el delay anti-ban de escaneo; mantener siempre el ritmo 'medio medio' de 4s a 8s con pausas naturales de 6s-10s cada 8-12 cuentas para evitar bloqueos de Google.
- `[2026-10-05]` [antigravity-account] Validar siempre el flujo de autenticacion con el proveedor antigravity_auth ademas de 'google' antes de fiarse de lecturas estaticas de state.vscdb.
- `[2026-10-05]` [antigravity-account] Obligatorio en cada modificacion: actualizar version en package.json, actualizar CHANGELOG.md, compilar con npm run build, empaquetar archivo .vsix para Windows, y hacer commit y push a origin/main.
- `[2026-10-05]` [antigravity-account] Usar el proyecto canonico 'aicode-consumers' en fetchAvailableModels para cuentas sin projectId propio para asegurar deteccion de cuota 0%.

## Anti-Patrones y Trampas Prohibidas (Errores Recurrentes)
- **PROHIBIDO:** Nunca reducir el delay anti-ban de escaneo por debajo de 4s
