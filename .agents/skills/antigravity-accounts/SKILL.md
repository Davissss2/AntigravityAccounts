---
name: antigravity-accounts
description: Contexto técnico integral, arquitectura interna, inyección de tokens en state.vscdb, modelos Cloud Code PA, algoritmos de ordenamiento, ciclo de escaneo y UI de la extensión Antigravity Accounts.
---

# Antigravity Accounts — Manual de Arquitectura y Desarrollo

## 1. Visión General del Proyecto
**Antigravity Accounts** es una extensión diseñada exclusivamente para **Antigravity IDE** (basado en Electron/VS Code). Permite gestionar múltiples cuentas de Google, alternar entre ellas sin perder la sesión, supervisar cuotas y tiempos de recarga de modelos de IA (Gemini 3.7 Flash, Gemini 3.5 Flash, Gemini 3.1 Pro, Claude Sonnet/Opus, GPT-OSS 120B), e inyectar credenciales directamente en la base de datos interna SQLite de Antigravity (`state.vscdb`).

---

## 2. Arquitectura de Directorios (Clean Architecture)

```
src/
├── core/
│   ├── constants/app.constants.ts       # Constantes: URLs, endpoints PA, IDs de modelos, claves de storage
│   ├── domain/models/                   # Modelos de dominio (Account, AccountTokens, DeviceProfile, Balance)
│   ├── domain/repositories/             # Interfaces de repositorios (IAccountRepository)
│   └── utils/
│       ├── crypto.utils.ts              # Cifrado AES-256-GCM para copias de seguridad
│       ├── logger.ts                    # Logger centralizado
│       ├── model.utils.ts               # Mapeo y formateo de modelos amigables (friendly names)
│       ├── path.utils.ts                # Resolución multiplataforma de rutas (%APPDATA%\Antigravity IDE)
│       ├── protobuf.utils.ts            # Serialización y deserialización Protobuf para state.vscdb
│       └── version.utils.ts             # Detección de versión de Antigravity
├── features/
│   └── accounts/
│       └── account.service.ts           # Lógica de negocio, auto-rotación, refresco de balances, flujo OAuth
├── infrastructure/
│   ├── auth/oauth.service.ts            # Servidor local HTTP y flujo OAuth 2.0 con Google
│   ├── storage/
│   │   ├── account.repository.impl.ts   # Persistencia segura de cuentas y perfiles
│   │   ├── inject-worker.js             # Worker detached para inyección de SQLite tras cierre de ventana
│   │   └── state-db.service.ts          # Orquestador de inyección en state.vscdb y storage.json
├── presentation/
│   └── providers/
│       ├── accounts-webview.provider.ts # Webview interactiva, ordenamiento, filtrado, barra de progreso
│       └── status-bar.provider.ts       # Item en la barra de estado de Antigravity
├── i18n/
│   ├── i18n.service.ts                  # Servicio de traducción (es, en, ar)
│   └── locales/                         # Archivos de idioma JSON
└── extension.ts                         # Punto de entrada y registro de comandos/providers
```

---

## 3. Mecanismo de Inyección en `state.vscdb` (Account Switching)

Antigravity mantiene la base de datos `state.vscdb` en memoria y sobreescribe el archivo al salir. Por tanto:
1. Se genera un payload con los tokens serializados en **Protobuf** (`antigravityUnifiedStateSync.oauthToken`, `antigravityUnifiedStateSync.userStatus`, `antigravityOnboarding`).
2. Se escribe un perfil de dispositivo aleatorizado (`DeviceProfile`) en `storage.json` y `state.vscdb` para evitar vinculación de cuentas por telemetría.
3. Se inicia un subproceso independiente desacoplado (`inject-worker.js`) con `ELECTRON_RUN_AS_NODE=1`.
4. Se cierra la ventana de Antigravity (lo que provoca el volcado de memoria a disco).
5. El worker espera a que todos los procesos de Antigravity finalicen, inyecta las filas en SQLite con `sql.js` y relanza Antigravity.

---

## 4. Algoritmos de Ordenamiento de Cuentas

1. **Cuenta Activa Anclada (`_pinnedActiveEmail`)**: La cuenta actualmente en uso en Antigravity se mantiene en primera posición.
2. **Orden por Defecto (`default`)**:
   - Primero las cuentas con cuota disponible (> 0%), ordenadas de mayor a menor porcentaje.
   - A continuación, las cuentas con cuota agotada (0%), ordenadas por **tiempo de regeneración más próximo** (las que antes se recargan primero; `diffMs <= 0` cuenta como recarga inmediata).
   - Al final, cuentas con sesión expirada, error o no elegibles.
   - Desempate por nombre / email (`localeCompare`).
3. **Cuota Restante (`quota`)**: Mayor cuota primero; en caso de empate o 0%, menor tiempo hasta recarga.
4. **Tiempo de Regeneración (`quota-regen`)**: Ordenadas ascendentemente por tiempo restante hasta renovación (`nextResetTime`).
5. **Fecha de Adición (`date-added`)**: Cuentas añadidas más recientemente primero.

---

## 5. Ciclo de Escaneo y Barra de Progreso

- **Escaneo de Segmentos**:
  - `all`: Escanea todas las cuentas.
  - `with-quota`: Escanea cuentas activas que tienen cuota > 0%.
  - `without-quota`: Escanea cuentas agotadas (0%), expiradas o con error.
- **Persistencia de la Barra de Progreso**:
  - El estado del escaneo (`isRefreshing`, `currentIndex`, `totalAccounts`, `currentEmail`) se conserva en el backend (`AccountsWebviewProvider`).
  - Si el usuario cambia de pestaña o cierra el panel, al reabrirse se inicializa con el progreso actual sin perderse ni bloquear la interfaz.
- **Insignia de Cuentas con Cuota**:
  - Muestra en la cabecera un contador en tiempo real (`● X/Y con cuota`).
- **Anti-Ban**: Delay aleatorio entre cuentas (3s a 7s) durante el escaneo para evitar rate-limiting de Google APIs.

---

## 6. Recomendaciones de Seguridad y Límites de Cuentas (~75–78 Cuentas)

- **Límite máximo recomendado**: No crear ni superar ~75 a 78 cuentas en un mismo entorno / IP / máquina.
- **Motivo**: Los sistemas heurísticos de abuso de Google detectan patrones masivos de creación a partir de ese umbral y proceden a suspender o solicitar verificación inmediata en las cuentas nuevas.
- Mantener un pool de 70 a 78 cuentas activas garantiza rotación continua y máxima vida útil sin bloqueos.
