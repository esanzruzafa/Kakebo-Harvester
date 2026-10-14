# Dependencias del empaquetador

El override de `global-agent` 4.1.3 se limita a `@electron/get` 3.x, utilizado por `electron-builder`. Elimina la cadena `global-agent` 3 → `roarr` 2 → `sprintf-js` 1.1.3, afectada por [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). Es una dependencia de desarrollo, no una biblioteca de la aplicación distribuida.

La versión 4 conserva la función CommonJS `bootstrap()` que utiliza `initializeProxy()` del descargador. La prueba `electron-download-proxy.test.mjs` comprueba esa integración con un proxy HTTP local en un proceso aislado. La construcción y verificación del portable comprueban además el empaquetador y SQLite dentro de Electron.

Al actualizar `electron-builder`, revisar si su descargador ya elimina esta cadena por sí mismo. En ese caso, retirar el override y confirmar con `npm audit`, la prueba del proxy y la construcción del portable. No reemplazarlo por una excepción de auditoría ni por la desactivación de TLS.
