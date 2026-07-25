# Kakebo Harvester

**Kakebo Harvester** es una aplicación local, de solo lectura, que obtiene cuentas, saldos y movimientos mediante la API AISP de Enable Banking, los conserva en SQLite y genera un CSV estable para Power Query. No inicia pagos ni transferencias, no automatiza la web bancaria y nunca solicita ni almacena credenciales, PIN, OTP o SMS.

La implementación está preparada para sandbox y producción restringida, pero esos entornos se mantienen totalmente separados. La activación de producción es siempre una acción manual posterior a la validación del sandbox.

## Alcance y seguridad

- JWT RS256 nuevo por solicitud, con vida de cinco minutos.
- Identificadores de sesión cifrados localmente con AES-256-GCM.
- `state` aleatorio; SQLite conserva únicamente su hash y lo acepta una sola vez durante 15 minutos.
- Callback enlazado exclusivamente a `127.0.0.1`.
- Importes guardados como cadenas decimales exactas, nunca calculados con `number`.
- IBAN enmascarado; el modelo normalizado y el CSV no contienen el IBAN completo.
- Respuestas raw opcionales, fuera de Git y con permisos locales restrictivos.
- Sin telemetría y sin endpoints de pagos.

PSD2 no garantiza hipotecas, préstamos, fondos, seguros ni todas las tarjetas. La disponibilidad, el histórico y los campos varían por banco.

## Requisitos

- Node.js 20 o superior.
- npm.
- Una aplicación de Enable Banking.
- Excel con Power Query para consumir el resultado.

En Windows, las dependencias nativas de SQLite pueden necesitar las herramientas de compilación de Visual Studio si no existe un binario precompilado para la versión de Node.

## Instalación

```powershell
npm install
Copy-Item .env.example .env.sandbox
Copy-Item config/categorization-rules.example.json config/categorization-rules.json
```

Genera la clave local que cifra las sesiones:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copia el resultado en `SESSION_ENCRYPTION_KEY` dentro de `.env.sandbox`. Protege ese archivo con los permisos de tu usuario y realiza una copia segura de la clave: si se pierde, las sesiones guardadas no se pueden descifrar.

Si solo existe un archivo de entorno, la aplicación lo detecta automáticamente. Si conservas `.env.sandbox` y `.env.production` a la vez, selecciona explícitamente el que corresponda en cada terminal:

```powershell
$env:KAKEBO_ENV_FILE = ".env.sandbox"
```

## Crear y probar la aplicación sandbox

1. Regístrate en el Control Panel de Enable Banking y crea una aplicación `SANDBOX`.
2. Registra exactamente `http://localhost:8000/callback` como redirect URL.
3. Descarga el PEM y muévelo a `private/enable-banking-sandbox.pem`.
4. Copia el ID de aplicación a `ENABLE_BANKING_APPLICATION_ID`.
5. Revisa las rutas sandbox de `.env.sandbox`.
6. Activa MFA en la cuenta de Enable Banking.
7. Ejecuta el diagnóstico:

```powershell
npm run cli -- doctor
```

Consulta bancos y usuarios/métodos de autenticación publicados por la API:

```powershell
npm run cli -- banks --country ES
npm run cli -- banks --country ES --search Kutxa
```

Deja el callback local activo en una terminal:

```powershell
npm run cli -- server
```

En otra terminal con el mismo `KAKEBO_ENV_FILE`, inicia la conexión:

```powershell
npm run cli -- connect --bank "Kutxabank" --country ES --psu-type personal
```

Abre la URL mostrada y autentícate únicamente en la pantalla oficial del banco o en el flujo servido por Enable Banking. En sandbox utiliza solo las credenciales ficticias que la respuesta de `banks`/Control Panel facilite.

Después del callback:

```powershell
npm run cli -- connections
npm run cli -- accounts
npm run cli -- initial-sync --from 2026-01-01
```

También se pueden ejecutar pasos independientes:

```powershell
npm run cli -- sync-accounts
npm run cli -- sync-balances
npm run cli -- sync-transactions
npm run cli -- sync-transactions --from 2026-01-01 --to 2026-07-24
npm run cli -- export
```

`sync-transactions` usa por defecto una ventana móvil de 15 días. La paginación se detiene si se repite una clave o se alcanza `MAX_TRANSACTION_PAGES`.

## Producción restringida

No reutilices la aplicación, el PEM, la base de datos ni las sesiones de sandbox.

1. Crea otra aplicación en el Control Panel y selecciona `PRODUCTION`.
2. Registra el mismo callback local.
3. Usa **Activate by linking accounts** para vincular exclusivamente tus cuentas.
4. Guarda el nuevo PEM como `private/enable-banking-production.pem`.
5. Copia `.env.example` a `.env.production`.
6. Cambia `APP_ENV=production`, el ID, el PEM y todas las rutas a `data/production/...`.
7. Genera una clave de cifrado distinta.
8. Ejecuta `doctor` y comprueba que la aplicación y las rutas son de producción.
9. Autoriza de nuevo la cuenta mediante `connect`; el vínculo del Control Panel no sustituye el consentimiento API.
10. Prueba primero 30 días, valida los datos y solo después amplía a 90 días si el banco lo permite.

Si la autorización funciona pero no aparecen cuentas, verifica antes que esa cuenta concreta esté vinculada a la aplicación restringida.

## CSV y Power Query

La exportación se escribe atómicamente en:

```text
data/<environment>/exports/kakebo_movements.csv
```

Usa UTF-8 con BOM, `;`, fechas ISO e importes con punto decimal. Puede activarse una copia fechada con `EXPORT_KEEP_BACKUP=true`. Hay un ejemplo ficticio en `examples/kakebo_movements.example.csv`.

En Excel, crea una consulta en **Datos > Obtener datos > Desde otras fuentes > Consulta en blanco** y adapta la ruta:

```powerquery
let
    Source = Csv.Document(
        File.Contents("C:\ruta\kakebo\data\production\exports\kakebo_movements.csv"),
        [Delimiter=";", Encoding=65001, QuoteStyle=QuoteStyle.Csv]
    ),
    Headers = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
    Types = Table.TransformColumnTypes(
        Headers,
        {
            {"MovementKey", type text},
            {"Date", type date},
            {"ValueDate", type date},
            {"Amount", type number},
            {"Reviewed", type logical},
            {"ImportedAt", type datetimezone}
        },
        "en-US"
    )
in
    Types
```

Nombra esa consulta `OpenBanking_Raw`. Mantén las correcciones en una tabla independiente `Kakebo_Manual_Adjustments` y combínala mediante un *left join* por `MovementKey`. La tabla final debe preferir categoría/subcategoría manual cuando exista. Así una actualización del CSV no borra decisiones del usuario:

```text
OpenBanking_Raw + Kakebo_Manual_Adjustments + Categorization_Rules
                              ↓
                       Movements_Final
                              ↓
                 Tablas dinámicas y gráficas
```

La aplicación no modifica el libro de Excel.

## Categorización opcional

`config/categorization-rules.json` admite reglas `contains`, `equals`, `startsWith` y `regex`, aplicadas por prioridad sobre texto en mayúsculas y sin tildes. Si el archivo no existe o ninguna regla coincide, el CSV deja la categoría vacía. El campo `Reviewed` evita que una actualización interna sobrescriba una categoría revisada; las correcciones principales deben seguir en Excel.

## Automatización con Windows Task Scheduler

Configura una tarea diaria, con el directorio del repositorio como inicio:

- Programa: `powershell.exe`
- Argumentos: `-NoProfile -ExecutionPolicy Bypass -File "C:\ruta\kakebo\scripts\sync-production.ps1"`
- Frecuencia: una vez al día.

El script solo referencia `.env.production`; no coloca secretos en argumentos. `sync-all` valida la sesión, actualiza cuentas, saldos y movimientos, y exporta. Devuelve `0` al terminar bien y `10` cuando se requiere reautorización. La tarea programada nunca abre el navegador.

## Renovación y desconexión

Cuando `connections` muestre `REAUTHORIZATION_REQUIRED`, ejecuta manualmente `connect` y completa de nuevo el consentimiento. En España, una nueva autenticación puede invalidar la sesión anterior para el mismo usuario y TPP.

Para desconectar:

```powershell
npm run cli -- disconnect --connection "Kutxabank personal"
```

El comando intenta cerrar la sesión remota, elimina las sesiones locales y marca la conexión como revocada. Conserva los movimientos históricos. Revoca también el consentimiento desde el banco o Enable Banking cuando corresponda. El borrado de históricos requiere una operación manual explícita sobre una copia de seguridad.

## Resolución de problemas

- `CONFIGURATION_ERROR`: revisa campos vacíos, URL local, clave base64 y que todas las rutas incluyan el entorno.
- `PRIVATE_KEY_ERROR`: verifica ruta, formato PKCS#8 PEM y permisos del usuario.
- HTTP 401/403: confirma el application ID, el PEM y el entorno; no se reintenta.
- `SELF_SIGNED_CERT_IN_CHAIN`: en Windows la aplicación carga por defecto las autoridades instaladas en el sistema antes de la primera conexión. Requiere Node 22.19 o superior; en versiones anteriores configura `NODE_EXTRA_CA_CERTS` antes de arrancar. Puede desactivarse con `NODE_USE_SYSTEM_CA=0`. No desactives la validación TLS.
- Cuenta vacía en producción restringida: vincúlala en el Control Panel y autoriza después mediante la API.
- `REAUTHORIZATION_REQUIRED`: renueva el consentimiento manualmente.
- Banco no disponible o HTTP 429/502/503/504: la aplicación reintenta con backoff y jitter; prueba más tarde si persiste.
- Historial incompleto: reduce o divide el intervalo; cada ASPSP fija su máximo.
- Callback rechazado: el `state` caduca a los 15 minutos y solo puede usarse una vez.

## Añadir otro banco

No requiere cambios de código: consulta `banks`, ejecuta `connect` con el nombre publicado por la API y asigna después un alias de cuenta en SQLite o mediante una futura interfaz. Cada conexión mantiene su propia sesión, cuentas y trazabilidad.

## Decisiones técnicas

- Fastify para el callback local y `fetch` nativo para HTTP.
- `jose` para JWT RS256.
- SQLite con migración versionada y transacciones para escrituras.
- Zod con esquemas externos tolerantes a campos adicionales y estrictos en los campos utilizados.
- Identidad de movimientos por referencia estable, ID del proveedor y huella SHA-256 de fallback.
- Reconciliación pending/booked mediante una segunda huella sin estado.
- Respuesta raw separada del modelo normalizado y de la vista CSV.
- Datos monetarios como cadenas decimales exactas.

## Limitaciones conocidas

- No se ha validado contra credenciales, cuenta bancaria ni sandbox reales.
- Las cabeceras PSU especiales que ciertos conectores indiquen en `required_psu_headers` todavía requieren soporte específico.
- La rotación de `SESSION_ENCRYPTION_KEY` no está automatizada.
- Los raw JSON no se cifran: se excluyen de Git, se crean con permisos locales restrictivos y pueden desactivarse con `RETAIN_RAW_DATA=false`.
- No existe interfaz para editar alias; puede hacerse directamente en la columna `accounts.account_alias`.
- La categorización automática es deliberadamente básica.
- La reconciliación pending/booked depende de que importe, cuenta, fechas y contraparte sean suficientemente estables.

## Acciones manuales en Enable Banking

- Crear las aplicaciones sandbox y production por separado.
- Registrar la redirect URL exacta.
- descargar y proteger cada PEM.
- Activar MFA.
- Usar usuarios ficticios en sandbox.
- Vincular cuentas propias para Production Restricted.
- Completar cada consentimiento en el banco.
- Renovar o revocar consentimientos cuando corresponda.

## Desarrollo y verificación

```powershell
npm run lint
npm run typecheck
npm test
npm run check
```

Los tests usan claves efímeras, SQLite temporal, fixtures ficticios y mocks; nunca llaman a producción.

## Referencias oficiales consultadas

- [Quick Start](https://enablebanking.com/docs/api/quick-start/)
- [API Reference](https://enablebanking.com/docs/api/reference/)
- [Control Panel](https://enablebanking.com/docs/api/control-panel/)
- [Restricted production y linked accounts](https://enablebanking.com/docs/api/linked-accounts/)
- [Particularidades de España](https://enablebanking.com/docs/markets/es/)
- [Ejemplos oficiales](https://github.com/enablebanking/enablebanking-api-samples)
