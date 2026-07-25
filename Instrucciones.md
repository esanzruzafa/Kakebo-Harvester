# Kakebo Harvester

## 1. Objetivo

Construir **Kakebo Harvester**, una aplicación local y de solo lectura que utilice **Enable Banking** para obtener automáticamente la información bancaria disponible mediante PSD2/Open Banking y exportarla a un formato consumible por el Excel Kakebo mediante Power Query.

La aplicación debe permitir:

- Conectar inicialmente una cuenta bancaria de prueba.
- Autorizar el acceso mediante el flujo oficial del banco.
- Obtener las cuentas accesibles, sus saldos y movimientos.
- Guardar la información localmente sin duplicados.
- Exportar una tabla consolidada en CSV.
- Ejecutar sincronizaciones posteriores sin repetir manualmente la importación.
- Añadir nuevos bancos y cuentas sin tener que rehacer la arquitectura.
- Mantener el Excel Kakebo como capa de categorización, presupuesto y reporting.

La solución será exclusivamente de **información de cuentas (AISP)**. No debe implementar pagos, transferencias ni ninguna operación financiera.

---

## 2. Expectativas y limitaciones

Enable Banking se utilizará mediante su API de agregación Open Banking.

La primera versión debe asumir que solo se obtendrán los productos expuestos por cada entidad a través de PSD2/Open Banking, normalmente:

- Cuentas de pago.
- Saldos.
- Movimientos.
- En algunos casos, cuentas de tarjeta o información adicional si el banco la expone.

No se debe asumir que la API proporcionará:

- Hipotecas.
- Préstamos personales.
- Fondos de inversión.
- Planes de pensiones.
- Seguros.
- Todos los movimientos de todas las tarjetas.

La arquitectura debe quedar preparada para incorporar en el futuro:

- Importaciones manuales mediante CSV/Excel.
- Otros proveedores Open Banking/Open Finance.
- Información adicional de productos financieros.
- Una segunda capa de categorización automática.

Queda expresamente fuera de alcance:

- Automatizar la web de un banco con Selenium, Playwright o scraping.
- Guardar usuario, contraseña, PIN o códigos SMS del banco.
- Automatizar la introducción de credenciales bancarias.
- Iniciar pagos o transferencias.
- Exponer el servicio públicamente en Internet durante la PoC.

---

## 3. Estrategia de entornos

La implementación debe soportar dos entornos completamente separados.

### 3.1. Sandbox

Objetivo:

- Validar la firma JWT.
- Validar llamadas a la API.
- Implementar el flujo de autorización.
- Procesar el callback.
- Intercambiar el código por una sesión.
- Descargar cuentas, saldos y movimientos simulados.
- Validar el almacenamiento y la exportación.

Los datos de sandbox no deben mezclarse con producción.

### 3.2. Production Restricted Mode

Tras completar sandbox, se creará otra aplicación independiente en producción.

Se utilizará la opción de Enable Banking para activar la aplicación vinculando cuentas propias. Esta modalidad debe utilizarse exclusivamente para uso personal y no comercial.

Consideraciones:

- Solo deben estar disponibles las cuentas expresamente vinculadas o autorizadas para la aplicación restringida.
- Si una autorización funciona, pero la API devuelve una lista de cuentas vacía, comprobar primero que la cuenta concreta haya sido vinculada a la aplicación.
- Sandbox y producción deben usar claves privadas, identificadores de aplicación, bases de datos y archivos de configuración diferentes.
- Nunca copiar sesiones o identificadores de cuentas entre entornos.

---

## 4. Stack técnico recomendado

Implementar la PoC con:

- **Node.js 20 o superior**.
- **TypeScript** con `strict: true`.
- **Fastify** o **Express** para el callback HTTP local.
- `fetch` nativo o una librería HTTP mantenida.
- `jose` para generar y firmar JWT con RS256.
- **SQLite** como almacenamiento local.
- Un ORM ligero como `drizzle-orm`, o acceso directo con una librería SQLite mantenida.
- `zod` para validación de configuración y respuestas externas.
- `pino` para logs estructurados.
- `vitest` para pruebas.
- Exportación CSV compatible con Excel en configuración regional española.

No utilizar Fabric, Azure ni una base de datos cloud en la primera versión.

---

## 5. Arquitectura

```text
┌────────────────────┐
│ Enable Banking API │
└─────────┬──────────┘
          │ HTTPS + JWT firmado
          ▼
┌─────────────────────────────┐
│ Aplicación local TypeScript │
│                             │
│ - API client                │
│ - Auth flow                 │
│ - Callback local            │
│ - Sync service              │
│ - Normalización             │
│ - Deduplicación             │
│ - Exportación               │
└──────────┬──────────────────┘
           │
           ▼
┌──────────────────────┐
│ SQLite local         │
│ - accounts           │
│ - sessions           │
│ - balances           │
│ - transactions_raw   │
│ - transactions       │
│ - sync_runs          │
└──────────┬───────────┘
           │
           ▼
┌────────────────────────────┐
│ kakebo_movements.csv       │
│ consumido por Power Query  │
└────────────────────────────┘
```

Debe existir una separación clara entre:

1. Respuesta original del proveedor.
2. Modelo normalizado interno.
3. Exportación específica para el Kakebo.

No acoplar el Excel directamente al JSON de Enable Banking.

---

## 6. Estructura del proyecto

```text
kakebo-harvester/
├─ README.md
├─ package.json
├─ tsconfig.json
├─ .env.example
├─ .gitignore
├─ config/
│  ├─ accounts.example.json
│  └─ categorization-rules.example.json
├─ data/
│  ├─ sandbox/
│  │  ├─ kakebo-sandbox.sqlite
│  │  ├─ raw/
│  │  └─ exports/
│  └─ production/
│     ├─ kakebo-production.sqlite
│     ├─ raw/
│     └─ exports/
├─ private/
│  └─ .gitkeep
├─ src/
│  ├─ index.ts
│  ├─ config.ts
│  ├─ cli.ts
│  ├─ server.ts
│  ├─ enable-banking/
│  │  ├─ client.ts
│  │  ├─ jwt.ts
│  │  ├─ types.ts
│  │  ├─ schemas.ts
│  │  └─ errors.ts
│  ├─ auth/
│  │  ├─ authorization-service.ts
│  │  ├─ callback-controller.ts
│  │  └─ state-store.ts
│  ├─ accounts/
│  │  ├─ account-service.ts
│  │  └─ account-mapper.ts
│  ├─ transactions/
│  │  ├─ transaction-service.ts
│  │  ├─ transaction-mapper.ts
│  │  ├─ deduplication.ts
│  │  └─ movement-key.ts
│  ├─ storage/
│  │  ├─ database.ts
│  │  ├─ migrations/
│  │  └─ repositories/
│  ├─ export/
│  │  └─ csv-exporter.ts
│  ├─ sync/
│  │  ├─ sync-service.ts
│  │  └─ sync-window.ts
│  └─ utils/
│     ├─ dates.ts
│     ├─ crypto.ts
│     └─ text.ts
└─ tests/
   ├─ fixtures/
   ├─ unit/
   └─ integration/
```

---

## 7. Configuración

Crear `.env.example` sin secretos reales:

```dotenv
APP_ENV=sandbox
APP_PORT=8000
APP_BASE_URL=http://localhost:8000

ENABLE_BANKING_API_BASE_URL=https://api.enablebanking.com
ENABLE_BANKING_APPLICATION_ID=
ENABLE_BANKING_PRIVATE_KEY_PATH=./private/enable-banking-sandbox.pem
ENABLE_BANKING_REDIRECT_URL=http://localhost:8000/callback

DATABASE_PATH=./data/sandbox/kakebo-sandbox.sqlite
RAW_DATA_DIRECTORY=./data/sandbox/raw
EXPORT_DIRECTORY=./data/sandbox/exports

DEFAULT_COUNTRY=ES
DEFAULT_PSU_TYPE=personal
DEFAULT_LANGUAGE=es
SYNC_LOOKBACK_DAYS=15
LOG_LEVEL=info
```

Buenas prácticas:

- Validar todas las variables al arrancar.
- Fallar inmediatamente si falta una variable obligatoria.
- No incluir valores por defecto peligrosos para producción.
- No guardar la clave privada en `.env`; guardar únicamente su ruta.
- Añadir a `.gitignore`:
  - `.env`
  - `private/*.pem`
  - `data/**/*.sqlite`
  - `data/**/raw/*`
  - `data/**/exports/*`
  - logs
- Documentar cómo crear un `.env.sandbox` y `.env.production`.
- No registrar en logs la clave, el JWT completo, códigos de autorización ni datos bancarios completos.

Para producción local:

- usar `https://localhost:8000/callback` como redirect URL;
- servir Fastify con el PFX local generado mediante `npm run setup:https`;
- guardar el PFX y su contraseña bajo `private/`, fuera de Git;
- mantener sandbox en `http://localhost:8000/callback`;
- no utilizar GitHub Pages ni exponer SQLite, el PEM de Enable Banking o el servidor local a Internet.

---

## 8. Autenticación de la aplicación

Implementar la autenticación siguiendo la documentación vigente de Enable Banking.

La aplicación debe:

1. Leer la clave privada PEM desde el sistema de archivos.
2. Generar el JWT requerido por Enable Banking.
3. Firmarlo mediante RS256.
4. Incluir el identificador de aplicación y los claims exigidos por la API vigente.
5. Usar una expiración corta.
6. Generar un JWT nuevo para cada solicitud o reutilizarlo solo durante un periodo corto y controlado.
7. Nunca persistir el JWT en la base de datos.
8. Nunca imprimir el JWT completo en logs.

No asumir claims ni cabeceras basándose únicamente en ejemplos antiguos. Consultar la referencia API actual y los ejemplos oficiales antes de implementar.

Crear pruebas unitarias para:

- Lectura correcta de la clave.
- Error comprensible si el archivo no existe.
- Generación de JWT válido.
- Expiración.
- Firma RS256.
- Ausencia de secretos en logs.

---

## 9. Flujo de conexión bancaria

### 9.1. Obtener bancos disponibles

Implementar un comando:

```bash
npm run cli -- banks --country ES
```

Debe llamar a la operación equivalente a:

```text
GET /aspsps
```

Requisitos:

- Filtrar por España.
- Mostrar nombre del banco, tipos de usuario y métodos de autenticación disponibles.
- Obtener siempre el nombre actual del banco desde la API.
- No persistir identificadores inventados.
- Permitir búsqueda por texto:

```bash
npm run cli -- banks --country ES --search Kutxa
```

### 9.2. Iniciar autorización

Implementar:

```bash
npm run cli -- connect \
  --bank "Kutxabank" \
  --country ES \
  --psu-type personal
```

El comando debe:

1. Consultar el banco en `GET /aspsps`.
2. Generar un `state` criptográficamente aleatorio.
3. Persistir temporalmente:
   - `state`.
   - banco.
   - fecha de creación.
   - redirect URL.
   - entorno.
4. Llamar a la operación equivalente a:

```text
POST /auth
```

5. Solicitar únicamente acceso de información de cuentas.
6. No solicitar pagos.
7. Mostrar la URL de autorización.
8. Abrir opcionalmente el navegador predeterminado.
9. Indicar que el usuario debe autenticarse únicamente en la pantalla oficial del banco o del flujo gestionado por Enable Banking.

### 9.3. Callback local

Implementar:

```text
GET /callback
```

El callback debe:

1. Validar que el `state` recibido coincide con uno pendiente y no expirado.
2. Rechazar callbacks repetidos.
3. Gestionar:
   - `code`.
   - `state`.
   - `error`.
   - `error_description`.
4. Intercambiar el `code` mediante la operación equivalente a:

```text
POST /sessions
```

5. Persistir:
   - `session_id`.
   - fecha de creación.
   - fecha de validez si se devuelve.
   - banco.
   - estado de sesión.
   - cuentas devueltas.
6. Mostrar una página local sencilla indicando éxito o error.
7. No mostrar IDs internos completos ni datos financieros en el navegador.

---

## 10. Sesiones y cuentas

Crear tablas similares a las siguientes.

### `bank_connections`

- `id`
- `provider`
- `environment`
- `bank_name`
- `bank_country`
- `psu_type`
- `status`
- `created_at`
- `last_authorized_at`
- `valid_until`
- `last_sync_at`
- `reauthorization_required`
- `error_code`
- `error_message_safe`

### `provider_sessions`

- `id`
- `bank_connection_id`
- `provider_session_id`
- `created_at`
- `valid_until`
- `status`
- `raw_response_path`

### `accounts`

- `id`
- `bank_connection_id`
- `provider_account_id`
- `identification_hash`
- `iban_masked`
- `currency`
- `name`
- `display_name`
- `account_alias`
- `account_type`
- `active`
- `first_seen_at`
- `last_seen_at`
- `raw_response_path`

Consideraciones:

- El `provider_account_id` puede estar ligado a una sesión y no debe considerarse el identificador estable definitivo.
- Usar `identification_hash` cuando esté disponible.
- Permitir asignar un alias local, por ejemplo:
  - `Cuenta nómina Kutxabank`
  - `Cuenta común`
  - `Tarjeta familiar`
- No almacenar el IBAN completo salvo necesidad justificada.
- Mostrar identificadores enmascarados.
- Conservar el JSON original cifrado o en una carpeta local protegida solo para diagnóstico; hacerlo configurable.

---

## 11. Obtención de saldos

Implementar:

```bash
npm run cli -- sync-balances
```

Debe utilizar la operación vigente equivalente a:

```text
GET /accounts/{account_id}/balances
```

Guardar:

- Cuenta.
- Tipo de saldo.
- Importe.
- Moneda.
- Fecha de referencia.
- Fecha de extracción.
- JSON raw opcional.

No asumir que todos los bancos devuelven los mismos tipos de saldo.

---

## 12. Obtención de movimientos

Implementar:

```bash
npm run cli -- sync-transactions
```

Y permitir:

```bash
npm run cli -- sync-transactions --from 2026-01-01 --to 2026-07-24
```

Utilizar la operación vigente equivalente a:

```text
GET /accounts/{account_id}/transactions
```

Requisitos:

- Soportar `date_from` y `date_to`.
- Soportar paginación mediante `continuation_key` o el mecanismo vigente.
- Continuar hasta recuperar todas las páginas.
- Aplicar límites de seguridad para evitar bucles infinitos.
- Guardar cada respuesta raw antes de normalizarla.
- Procesar tanto movimientos contabilizados como pendientes si se devuelven.
- Diferenciar `booked` y `pending`.
- No consolidar permanentemente un pendiente como si fuese definitivo.
- Actualizar el movimiento cuando pase de pendiente a contabilizado.
- Ser tolerante a campos ausentes.
- Validar las respuestas con esquemas flexibles pero seguros.

---

## 13. Modelo normalizado de movimientos

Crear una tabla `transactions` con:

- `id`
- `movement_key`
- `provider`
- `environment`
- `bank_connection_id`
- `account_id`
- `provider_transaction_id`
- `entry_reference`
- `status`
- `booking_date`
- `value_date`
- `transaction_datetime`
- `amount`
- `currency`
- `direction`
- `description_raw`
- `description_normalized`
- `merchant_name`
- `creditor_name`
- `debtor_name`
- `counterparty_iban_masked`
- `bank_transaction_code`
- `merchant_category_code`
- `balance_after`
- `first_seen_at`
- `last_seen_at`
- `imported_at`
- `source_raw_file`
- `raw_fingerprint`

No todos los campos estarán siempre disponibles.

### Convención de importes

Usar una única convención interna:

- Ingresos: importe positivo.
- Gastos: importe negativo.

Conservar el importe y el indicador originales en raw para diagnóstico.

Usar `decimal` o almacenar importes como enteros en la unidad mínima de moneda. No usar `number` de JavaScript para cálculos financieros sin una estrategia explícita.

---

## 14. Deduplicación

Implementar una estrategia por niveles.

### Nivel 1: referencia estable

Cuando exista:

```text
identification_hash de la cuenta
+ entry_reference
```

### Nivel 2: identificador del proveedor

Cuando exista:

```text
identification_hash
+ provider_transaction_id
```

### Nivel 3: huella de fallback

Cuando no existan referencias fiables:

```text
account_stable_key
+ status
+ booking_date
+ value_date
+ amount
+ currency
+ description_normalized
+ counterparty
```

Crear `movement_key` mediante SHA-256.

Buenas prácticas:

- No usar únicamente fecha e importe.
- Permitir que un movimiento pendiente se reconcilie con el contabilizado.
- Registrar colisiones y no sobrescribir silenciosamente.
- Hacer la sincronización idempotente.
- Ejecutar dos sincronizaciones seguidas no debe crear duplicados.

---

## 15. Ventana de sincronización

En sincronizaciones automáticas:

```text
date_from = hoy - SYNC_LOOKBACK_DAYS
date_to = hoy
```

Valor inicial:

```text
SYNC_LOOKBACK_DAYS=15
```

Motivo:

- Movimientos pendientes que posteriormente se contabilizan.
- Cambios de descripción o referencia.
- Devoluciones.
- Retrasos en la publicación bancaria.

Para la primera carga, permitir una importación histórica configurable:

```bash
npm run cli -- initial-sync --from 2025-01-01
```

No asumir que todos los bancos permiten el mismo histórico.

---

## 16. Exportación para Power Query

Generar:

```text
data/<environment>/exports/kakebo_movements.csv
```

Columnas:

```text
MovementKey
Date
ValueDate
Bank
Account
AccountAlias
ProductType
Description
Merchant
Counterparty
Amount
Currency
Direction
Status
CategoryAuto
SubcategoryAuto
Reviewed
Source
ImportedAt
```

Reglas:

- Codificación UTF-8 con BOM para compatibilidad con Excel.
- Separador configurable; por defecto `;` para entorno es-ES.
- Fechas ISO `YYYY-MM-DD`.
- Decimales con formato estable y documentado.
- No exportar datos técnicos innecesarios.
- No exportar IBAN completo.
- Ordenar por fecha y cuenta.
- Usar escritura atómica:
  1. Crear archivo temporal.
  2. Validarlo.
  3. Sustituir el CSV anterior.
- Mantener opcionalmente una copia fechada:
  - `kakebo_movements_YYYYMMDD_HHmmss.csv`

Implementar:

```bash
npm run cli -- export
```

Y:

```bash
npm run cli -- sync-all
```

`sync-all` debe:

1. Validar sesiones.
2. Sincronizar cuentas.
3. Sincronizar saldos.
4. Sincronizar movimientos.
5. Deduplicar.
6. Exportar CSV.
7. Generar un resumen final.

---

## 17. Categorización

En la primera versión, la categorización automática será opcional y sencilla.

Crear un archivo:

```text
config/categorization-rules.json
```

Ejemplo:

```json
[
  {
    "priority": 10,
    "field": "descriptionNormalized",
    "operator": "contains",
    "value": "MERCADONA",
    "category": "Alimentación",
    "subcategory": "Supermercado"
  },
  {
    "priority": 20,
    "field": "descriptionNormalized",
    "operator": "contains",
    "value": "IBERDROLA",
    "category": "Vivienda",
    "subcategory": "Electricidad"
  }
]
```

Buenas prácticas:

- Normalizar a mayúsculas.
- Eliminar espacios repetidos.
- Permitir normalización de tildes.
- Aplicar reglas por prioridad.
- No sobrescribir una categoría manual ya revisada.
- Exportar sin categoría cuando no se encuentre ninguna regla.
- No mezclar las categorías propias del proveedor con las categorías Kakebo.

La aplicación no debe modificar directamente las tablas dinámicas ni gráficos del Excel.

---

## 18. Seguridad

### Obligatorio

- Solo lectura.
- No implementar pagos.
- No almacenar credenciales del banco.
- No almacenar OTP/SMS.
- No registrar tokens completos.
- No exponer el callback fuera de localhost.
- Usar HTTP local únicamente en sandbox y HTTPS local en producción.
- Validar `state`.
- Usar tiempos de expiración para autorizaciones pendientes.
- Proteger el archivo PEM con permisos del usuario.
- Separar claves de sandbox y producción.
- Añadir MFA a la cuenta de Enable Banking.
- Mantener dependencias actualizadas.
- Ejecutar auditoría de dependencias.
- No subir datos bancarios a repositorios.
- Enmascarar números de cuenta.
- No enviar telemetría externa.

### Recomendado

- Cifrar localmente identificadores de sesión almacenados.
- Utilizar el almacén de credenciales del sistema operativo o una clave maestra local.
- Añadir una opción para no conservar JSON raw.
- Crear un comando de borrado seguro:

```bash
npm run cli -- disconnect --connection <alias>
```

Debe:

- Marcar la conexión como revocada.
- Eliminar sesiones locales.
- Explicar que también puede ser necesario revocar el consentimiento desde el banco o Enable Banking.
- No borrar movimientos históricos sin confirmación explícita.

---

## 19. Gestión de errores

Crear errores tipados:

- `ConfigurationError`
- `PrivateKeyError`
- `EnableBankingAuthenticationError`
- `AuthorizationDeniedError`
- `InvalidStateError`
- `SessionExpiredError`
- `ReauthorizationRequiredError`
- `BankUnavailableError`
- `RateLimitError`
- `MalformedProviderResponseError`
- `DatabaseError`
- `ExportError`

Los mensajes al usuario deben ser comprensibles y no exponer datos sensibles.

Implementar reintentos solo para errores transitorios:

- HTTP 429.
- HTTP 502.
- HTTP 503.
- HTTP 504.
- Timeouts.

Usar backoff exponencial con jitter.

No reintentar automáticamente:

- Credenciales/autorización denegada.
- Consentimiento cancelado.
- Sesión expirada.
- Errores de validación.
- HTTP 400/401/403 salvo caso documentado.

---

## 20. Logging y auditoría

Registrar:

- Inicio y fin de sincronización.
- Banco y alias de cuenta.
- Número de páginas consultadas.
- Número de movimientos recibidos.
- Insertados.
- Actualizados.
- Ignorados por duplicado.
- Pendientes reconciliados.
- Errores seguros.
- Duración.

No registrar:

- Clave privada.
- JWT completo.
- Authorization code.
- Session ID completo.
- IBAN completo.
- Conceptos completos de movimientos en logs de nivel normal.
- Respuestas JSON completas en consola.

Crear tabla `sync_runs`:

- `id`
- `started_at`
- `finished_at`
- `status`
- `bank_connection_id`
- `account_id`
- `date_from`
- `date_to`
- `pages`
- `received`
- `inserted`
- `updated`
- `duplicates`
- `error_code`
- `error_message_safe`

---

## 21. Automatización local

Preparar instrucciones para Windows Task Scheduler.

Comando:

```bash
npm run cli -- sync-all
```

Frecuencia recomendada:

- Una vez al día.
- No ejecutar más frecuentemente sin necesidad.

Requisitos:

- El proceso debe devolver código `0` si termina correctamente.
- Código distinto de `0` si falla.
- No debe quedarse esperando interacción si la sesión es válida.
- Si necesita reautorización:
  - no abrir el navegador automáticamente durante una tarea programada;
  - registrar el estado;
  - generar un mensaje claro;
  - terminar con código específico.

No incluir credenciales en los argumentos de la tarea programada.

---

## 22. CLI esperada

```bash
npm run cli -- doctor
npm run cli -- banks --country ES
npm run cli -- connect --bank "Kutxabank" --country ES
npm run cli -- connections
npm run cli -- accounts
npm run cli -- sync-accounts
npm run cli -- sync-balances
npm run cli -- sync-transactions
npm run cli -- sync-transactions --from 2026-01-01 --to 2026-07-24
npm run cli -- initial-sync --from 2025-01-01
npm run cli -- sync-all
npm run cli -- export
npm run cli -- disconnect --connection "Kutxabank personal"
```

`doctor` debe comprobar:

- Versión de Node.
- Configuración.
- Acceso a la clave privada.
- Acceso de escritura a SQLite.
- Acceso de escritura al directorio de exportación.
- Conectividad con Enable Banking.
- Coincidencia entre entorno y rutas.
- Redirect URL.
- Que no se esté utilizando una clave sandbox en producción.

---

## 23. Pruebas

### Unitarias

- Generación JWT.
- Normalización de texto.
- Convención de importes.
- Generación de `movement_key`.
- Deduplicación.
- Reconciliación pending/booked.
- Validación de `state`.
- Paginación.
- Reintentos.
- Exportación CSV.
- Enmascarado de identificadores.

### Integración

Utilizar fixtures y mocks para:

- `GET /aspsps`.
- `POST /auth`.
- Callback correcto.
- Callback con error.
- `POST /sessions`.
- Listado de cuentas.
- Saldos.
- Movimientos paginados.
- Campos ausentes.
- Sesión expirada.
- Cuenta no vinculada.
- Lista de cuentas vacía.
- Error temporal de banco.
- Rate limit.

### Criterios

- Cobertura razonable en la lógica crítica.
- Ninguna prueba debe requerir credenciales o claves reales.
- No llamar a producción desde tests automáticos.
- Separar tests manuales de sandbox.

---

## 24. README que debe generar Codex

El `README.md` final debe incluir:

1. Qué hace la aplicación.
2. Qué no hace.
3. Requisitos.
4. Instalación.
5. Creación de la aplicación sandbox.
6. Configuración de redirect URL.
7. Ubicación segura del PEM.
8. Variables de entorno.
9. Primera conexión.
10. Prueba sandbox.
11. Creación de Production Restricted.
12. Vinculación de cuentas propias.
13. Primera sincronización real.
14. Exportación para Excel.
15. Configuración de Power Query.
16. Automatización con Windows Task Scheduler.
17. Renovación de autorización.
18. Resolución de errores frecuentes.
19. Procedimiento para añadir otro banco.
20. Procedimiento de desconexión y borrado.
21. Advertencia sobre limitaciones PSD2.

---

## 25. Integración con el Excel Kakebo

No modificar el Excel durante la primera fase.

Documentar cómo crear en Excel una consulta Power Query que lea:

```text
data/production/exports/kakebo_movements.csv
```

El Kakebo seguirá siendo responsable de:

- Categorías.
- Subcategorías.
- Presupuesto anual.
- Correcciones manuales.
- Tablas dinámicas.
- Gráficas.
- Seguimiento familiar.

Evitar que una actualización del CSV borre categorías manuales. La integración debe utilizar `MovementKey` como clave estable para relacionar:

- Tabla importada.
- Tabla de correcciones manuales.
- Tabla final para reporting.

Diseño recomendado en Excel:

```text
OpenBanking_Raw
        +
Kakebo_Manual_Adjustments
        +
Categorization_Rules
        ↓
Movements_Final
        ↓
Tablas dinámicas y gráficas
```

---

## 26. Fases de ejecución para Codex

### Fase 1 — Scaffold

- Crear proyecto.
- Configuración TypeScript.
- CLI.
- Logging.
- SQLite.
- Migraciones.
- `.env.example`.
- `.gitignore`.
- Tests básicos.

### Fase 2 — Sandbox

- JWT.
- Cliente HTTP.
- `GET /aspsps`.
- `POST /auth`.
- Callback.
- `POST /sessions`.
- Cuentas.
- Saldos.
- Movimientos.
- Paginación.
- Raw JSON.
- Normalización.
- CSV.

### Fase 3 — Robustez

- Deduplicación.
- Pending/booked.
- Reintentos.
- Errores tipados.
- `doctor`.
- Sincronización idempotente.
- Pruebas.

### Fase 4 — Producción restringida

- Configuración separada.
- Checklist de seguridad.
- Conexión con una cuenta real.
- Primera carga de 30 días.
- Validación de datos.
- Carga de 90 días.
- Exportación real.

### Fase 5 — Escalado

- Múltiples conexiones.
- Alias.
- Más cuentas del mismo banco.
- Segundo banco.
- Tarea programada.
- Reglas básicas de categorización.

No avanzar automáticamente a producción hasta que sandbox funcione y los tests estén correctos.

---

## 27. Criterios de aceptación

La PoC se considerará terminada cuando:

- Se pueda crear una autorización sandbox.
- El callback valide correctamente `state`.
- Se obtenga una sesión.
- Se listen las cuentas accesibles.
- Se descarguen saldos.
- Se descarguen todos los movimientos paginados.
- Los datos se guarden en SQLite.
- Dos sincronizaciones consecutivas no creen duplicados.
- Se pueda repetir una ventana de 15 días de forma idempotente.
- Se genere `kakebo_movements.csv`.
- Excel pueda importar el CSV.
- No se almacenen credenciales bancarias.
- No exista funcionalidad de pagos.
- La clave privada no esté en Git.
- Sandbox y producción estén aislados.
- La aplicación avise cuando haga falta reautorizar.
- Añadir un nuevo banco requiera configuración y autorización, no cambios estructurales importantes.
- Existan tests y documentación de uso.

---

## 28. Entregables

Codex debe entregar:

- Código fuente completo.
- Migraciones SQLite.
- Tests.
- `.env.example`.
- `.gitignore`.
- `README.md`.
- Ejemplos de configuración.
- Fixtures sin datos reales.
- CSV de ejemplo generado con datos ficticios.
- Instrucciones para sandbox.
- Instrucciones para Production Restricted.
- Instrucciones para Power Query.
- Instrucciones para Windows Task Scheduler.
- Lista de limitaciones conocidas.
- Lista de decisiones técnicas tomadas.
- Lista de acciones manuales que debe realizar el usuario en Enable Banking.

Antes de finalizar, Codex debe:

- Ejecutar lint.
- Ejecutar typecheck.
- Ejecutar tests.
- Revisar que no haya secretos.
- Revisar que todos los comentarios y nombres técnicos estén en inglés.
- Mantener el README y las instrucciones para el usuario en castellano.
- Informar claramente de cualquier parte que no haya podido validar contra una cuenta real.

---

## 29. Principios de implementación

- Priorizar seguridad frente a automatización.
- No inventar campos de la API.
- Consultar la documentación API vigente.
- Mantener una capa de adaptación del proveedor.
- Evitar acoplamiento con Enable Banking en el modelo del Kakebo.
- Ser tolerante a diferencias entre bancos.
- Ser idempotente.
- Conservar trazabilidad.
- No ocultar errores.
- No sobrescribir datos manuales.
- No suponer que todos los bancos devuelven las mismas propiedades.
- No suponer que PSD2 incluye hipotecas o todos los productos.
- Implementar el mínimo funcional antes de añadir categorización avanzada.

---

## 30. Referencias oficiales que debe consultar Codex

Antes de implementar, revisar la versión vigente de:

- Quick Start:  
  https://enablebanking.com/docs/api/quick-start/

- API Reference:  
  https://enablebanking.com/docs/api/reference/

- Control Panel:  
  https://enablebanking.com/docs/api/control-panel/

- Restricted production / linked accounts:  
  https://enablebanking.com/docs/api/linked-accounts/

- FAQ:  
  https://enablebanking.com/docs/faq/

- Particularidades de España:  
  https://enablebanking.com/docs/markets/es/

- Repositorios y ejemplos oficiales:  
  https://github.com/enablebanking

Codex debe tratar los ejemplos antiguos o archivados como orientación, no como especificación definitiva. La referencia API vigente debe ser la fuente principal.
