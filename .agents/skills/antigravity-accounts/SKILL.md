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
- **Anti-Ban Reforzado**: 
  - Delay aleatorio entre cuentas ampliado a **6s–15s** con jitter durante el escaneo para evitar rate-limiting de Google APIs.
  - Interrupción inmediata (Safety Break) del ciclo de escaneo si se detecta un código **HTTP 429 (Too Many Requests)**, protegiendo todas las cuentas restantes del pool contra bloqueos en cascada.
- **Protección contra Sobre-Refresco (Defaults Seguros)**:
  - `autoRefreshEnabled` desactivado por defecto (`false`) para no disparar peticiones innecesarias al abrir el panel o iniciar el IDE.
  - `refreshIntervalMinutes` fijado a `0` (desactivado por defecto).
  - Eliminado el polling en bucle de 30 segundos sobre la cuenta activa: la verificación periódica sólo se ejecuta si `autoRotateEnabled` está activo, y con un intervalo seguro de 10 minutos.
  - Cooldown de 5 minutos al cambiar de cuenta y 30 segundos de debouncing al refrescar cuentas individuales.
  - User-Agent dinámico que refleja la versión real instalada de Antigravity IDE.

---

## 6. Recomendaciones de Seguridad y Límites de Cuentas (~75–78 Cuentas)

- **Límite máximo recomendado**: No crear ni superar ~75 a 78 cuentas en un mismo entorno / IP / máquina.
- **Motivo**: Los sistemas heurísticos de abuso de Google detectan patrones masivos de creación a partir de ese umbral y proceden a suspender o solicitar verificación inmediata en las cuentas nuevas.
- Mantener un pool de 70 a 78 cuentas activas garantiza rotación continua y máxima vida útil sin bloqueos.
- Se recomienda no abusar del botón de "Refrescar todas las cuentas" manualmente y dejar que el sistema opere con las cuotas cacheadas.

---

## 7. Lecciones Técnicas, Ingeniería Inversa de Antigravity Core y Prevención de Errores

### 7.1. Ingeniería Inversa de la Resolución de Endpoints en Antigravity IDE (`out/main.js`)
Mediante herramientas de ingeniería inversa (REA) sobre el código empaquetado del IDE (`C:\Users\Usuario\AppData\Local\Programs\Antigravity IDE\resources\app\out\main.js`), se extrajo la función canónica de selección de endpoints (`NAl`):
```javascript
function NAl({ isDevMode: e, isGoogleInternal: t, isGcpTos: r, isTierGCPTos: n, cloudCodeUrlOverride: i }) {
  return i || (t && e ? Zis : t ? Dis : r || n === true || n === undefined ? Gis : Uis);
}
// Zis = "https://autopush-cloudcode-pa.sandbox.googleapis.com"
// Dis = "https://preprod-daily-cloudcode-pa.sandbox.googleapis.com"
// Gis = "https://cloudcode-pa.googleapis.com" (PRODUCCIÓN)
// Uis = "https://daily-cloudcode-pa.googleapis.com" (DAILY / PERSONAL SIN GCP TOS)
```

**Regla de Oro:**
- Cuentas de usuario particulares sin acuerdos comerciales GCP ToS (`isGcpTos === false`) deben consultar obligatoriamente `https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`.
- El endpoint de producción `cloudcode-pa.googleapis.com` devuelve de forma estática `remainingFraction: 1` (100%) para todos los modelos en cuentas personales, falseando por completo el saldo real.

### 7.2. El Problema de las Claves Zombi (`gemini-3.8-flash-high` vs `gemini-3.8-flash-tiered`)
- **Causa Raíz de la Discrepancia (Tarjeta en 100% vs Barra Inferior en 4% o 7%)**:
  1. Google PA **nunca** devuelve la clave `gemini-3.8-flash-high`. La clave canónica devuelta por Google es `gemini-3.8-flash-tiered`.
  2. En versiones anteriores de la extensión existía el alias `gemini-3.8-flash-high` guardado en `account.balances` dentro de SQLite (`state.vscdb`).
  3. Cuando se actualizaba la cuenta desde `daily-cloudcode-pa`, Google inyectaba `gemini-3.8-flash-tiered: 4`, pero al hacer spread de balances antiguos (`...oldBalances`), la clave `gemini-3.8-flash-high: 100` permanecía almacenada indefinidamente.
  4. En `model.utils.ts`, ambas claves mapeaban al nombre amigable `"3.8 Flash (High)"`. Al recorrer `Object.entries(balances)`, `gemini-3.8-flash-high` aparecía primero en el orden de iteración y devolvía 100% de inmediato.
  5. En el webview, `friendlyModelMap` registraba primero `gemini-3.8-flash-high` (100%) y descartaba silenciosamente `gemini-3.8-flash-tiered` (4%).
- **Solución Implementada**:
  - `model.utils.ts` (`getModelBalanceValue` y `getModelBalanceEntry`): recopila todas las coincidencias del modelo y prioriza estrictamente las claves canónicas con sufijo `-tiered` sobre alias heredados (`-high`, `-med`).
  - `accounts-webview.provider.ts` y `status-bar.provider.ts`: deduplicación activa por nombre amigable donde la clave `-tiered` sobrescribe cualquier alias previo.
  - `account.service.ts`: `mergeBalancesPreservingResetTime` purga de forma destructiva las claves `gemini-3.8-flash-high` y `gemini-3.8-flash` cuando la clave `-tiered` existe en balances nuevos o antiguos.
  - `extension.ts`: Migración automática de almacenamiento v4 (`storageMigration_v4_done`) que limpia en el arranque de la extensión todas las cuentas persistidas en cualquier equipo o instalación.

### 7.3. Causa y Solución del Temporizador que se Resetea a 59 Minutos al Refrescar
- **Causa 1 (Omisión de Merge en Refresco Individual)**:
  - En `account.service.ts`, `refreshBalancesWorkflow` utilizaba `mergeBalancesPreservingResetTime`, pero `refreshSingleAccountBalance` (el botón de refresco individual de cada tarjeta) guardaba directamente `balances: balanceInfo.balances`.
  - Google devuelve una ventana dinámica relativa de `now + 7 days` para cuentas al 100%. Al pulsar el botón manual de refresco, Google recalculaba la fecha con respecto al segundo exacto de la petición, reseteando la cuenta atrás del usuario a 59 minutos.
  - **Solución**: `refreshSingleAccountBalance` invoca siempre `this.mergeBalancesPreservingResetTime(oldBalances, balanceInfo.balances)` para retener el ciclo original si el saldo se mantiene al 100%.
- **Causa 2 (Competencia Desordenada de Modelos en la Cabecera de la Tarjeta)**:
  - En `accounts-webview.provider.ts`, la variable `nextResetTime` se calculaba buscando la diferencia mínima (`minDiffMs`) sobre todos los modelos devueltos por Google.
  - Modelos terciarios como `gpt-oss-120b-medium` devolvían timestamps ligeramente desfasados con respecto al modelo preferido, monopolizando el contador y provocando saltos bruscos.
  - **Solución**: Si hay un modelo preferido (`preferredModelData`) con `resetTime` en el futuro:
    1. Si está consumido (`< 100%`), su tiempo es la máxima prioridad.
    2. Si está al 100%, solo se cede la cabecera si otro modelo consumido recarga antes. Si todos están al 100%, la cabecera muestra determinísticamente la renovación del modelo preferido.

### 7.4. Barra de Estado Sincronizada y Multiplataforma
- **Barra de Estado**: Antes mostraba una cadena ilegible de 10 porcentajes sin contexto (`💰 100/100/100/100/4/4`). Ahora lee `getModelBalanceEntry` para el modelo preferido y muestra `$(hubot) [Alias] | 💰 [Modelo]: [X]%`, garantizando coincidencia al 100% con la tarjeta del webview.
- **Empaquetado Multiplataforma**: Generar siempre paquetes universales mediante `npx -y @vscode/vsce package` (`antigravity-account-X.X.X.vsix`) sin la bandera `--target win32-x64` para permitir la instalación directa en Ubuntu, Debian, macOS (ARM64/x64) y Windows.

