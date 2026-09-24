# Tarjetas Kutxabank: sincronización local

Implementación en validación en `feat/26-kutxabank-card-sync`. La lectura se hace desde una ventana bancaria aislada de Kakebo. Enable Banking sigue proporcionando las cuentas; el importador manual XLSX sigue disponible.

## Uso

1. En Tarjetas, abrir la ventana Kutxabank e iniciar sesión directamente en la página pública del banco. El banco puede abrir una segunda ventana para la sesión autenticada; Kakebo la utiliza y oculta la página de entrada.
2. Al completar el acceso, Kakebo actualiza y guarda las tarjetas disponibles automáticamente. **Actualizar tarjetas disponibles** permite repetir la lectura manualmente. El listado es global para todas las sesiones bancarias y los alias y las casillas de sincronización persisten entre reinicios. Una tarjeta nueva toma el alias visible en Kutxabank; el lápiz permite cambiarlo después en Kakebo. La lista muestra `****` y los cuatro últimos dígitos. El último saldo leído, su color rojo si lo tenía en el banco y la fecha y hora de lectura permanecen visibles hasta una nueva lectura, incluso tras reiniciar. La papelera quita la tarjeta del catálogo y de `cards.json`, con confirmación, pero conserva sus movimientos; si el banco vuelve a mostrarla, reaparece con el alias bancario.
3. Marcar las tarjetas que se desean sincronizar. Una tarjeta ausente en la sesión bancaria se conserva en el listado y se comunica como aviso al final; las demás continúan. Dos tarjetas con los mismos cuatro últimos dígitos requieren una asociación inequívoca antes de sincronizarse.
4. Elegir una de las cinco opciones disponibles para el periodo. Kakebo pulsa esa opción en la ventana bancaria; solo **Entre fechas** solicita las fechas concretas. Pulsar **Sincronizar tarjetas marcadas**. Si el banco solicita autorización adicional, completarla en su ventana y volver a intentar la sincronización.
5. Comprobar el resumen de filas nuevas, repetidas y actualizadas. Solo se guarda el lote después de leer todas sus páginas. Un error de exportación posterior se comunica como aviso: los movimientos ya guardados permanecen en la aplicación.
6. Para cambiar de persona, cerrar la sesión desde la web de Kutxabank antes de cerrar la ventana. Las ventanas de entrada y banca se cierran juntas, pero el perfil del navegador permanece en `%LOCALAPPDATA%\KakeboHarvester\KutxabankBrowser`; una nueva apertura puede recuperar la sesión anterior si el banco todavía la considera válida. **Olvidar este dispositivo** borra ese perfil compartido para las dos personas, con confirmación y solo cuando la ventana bancaria está cerrada. No borra las tarjetas ni los movimientos de Kakebo. El banco puede solicitar de nuevo la doble autenticación aunque se conserve el perfil.

Los cuatro últimos dígitos son una ayuda visual, no una identidad única. La aplicación reconoce la misma tarjeta entre sesiones mediante una huella criptográfica calculada localmente a partir del número observado en la web, sin guardar el número completo ni incluir la huella en `cards.json` o en la interfaz. Si se cambia la clave privada local, no se podrán asociar automáticamente las tarjetas existentes. Las tarjetas creadas con ejecutables de prueba anteriores a 2.0.0 no tienen esta huella y requieren quitarse del catálogo y volver a detectarse; sus movimientos históricos se conservan. Desconectar una conexión de tarjetas conserva sus movimientos y no revoca el acceso AIS a las cuentas.

## Conciliación y exportación

El panel de conciliación carga hasta 500 movimientos de un intervalo; si hay más, hay que acotar las fechas. Seleccionar dos filas y confirmar el tratamiento:

- **Liquidación:** un cargo AIS y su abono de tarjeta, con la misma divisa e importes opuestos. Ambos conservan el importe original, con contribución al gasto cero.
- **Duplicado:** una compra manual y su copia procedente de Kutxabank, con importe y divisa iguales. La primera fila elegida es la representante; la segunda contribuye cero.

La confirmación se puede deshacer. No se concilian filas pendientes ni se deduce una relación solo por su descripción. Si cambia el importe o divisa de una fila confirmada, la exportación vuelve a marcar la relación como pendiente de revisión y deja de excluir importes.

Para analizar gasto, activar las columnas **Contribución al gasto**, **Tratamiento económico** y **Referencia de conciliación** en la configuración de exportación. Los perfiles existentes conservan sus preferencias; las columnas nuevas pueden estar desactivadas. El importe original sigue siendo el movimiento del banco. Las compras contribuyen en positivo y las devoluciones en negativo. No sumar distintas divisas.

`review-required` indica tratamiento sin confirmar; su importe sigue incluido. Un estado vacío del portal se conserva como `unknown`, no como movimiento contabilizado. Solo `P (*)` se interpreta como pendiente.

## Límites actuales

- Se necesita el equipo encendido y una sesión interactiva. No hay ejecución desatendida con la ventana cerrada.
- No se conoce el máximo histórico del banco. El intervalo probado en Edge fue del 1 de junio al 15 de septiembre de 2026.
- El XLS descargado manualmente es BIFF8, con cuatro columnas y sin estado. No equivale al XLSX del importador actual; cambiar la extensión no lo convierte.
- Cambios del portal, navegación no admitida o páginas incoherentes detienen la lectura. No se guarda una extracción parcial ni se intenta eludir MFA.
- El titular confirmó una sincronización completa de **Entre fechas** en el portable con la pulsación real del radio. Las otras cuatro opciones y el nuevo catálogo requieren una prueba real con el paquete actualizado.

[Evidencia de investigación](kutxabank-connector-evidence.md) · [Plan y decisiones](../superpowers/plans/2026-09-14-issue-26-kutxabank-card-sync.md)
