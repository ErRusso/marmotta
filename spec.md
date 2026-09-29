# Marmotta

Node.js ha sempre permesso la creazione di moduli nativi chiamati addons i
quali sono particolari componenti che permettono di richiamare codice nativo
scritto in C o C++. Nel 2017 con l’introduzione di N-API ora noto anche come
Node-API è stata creata una nuova API per l’implementazione di moduli nativi
che oltre a garantire la stabilità API potesse anche garantire la stabilità a
livello di ABI. Per raggiungere questo scopo tutte le funzioni sono state
esportate come funzioni C documentate a questo link <https://nodejs.org/docs/latest/api/n-api.html>.
Tutte le funzioni esportate sono disponibili anche in questo repository <https://github.com/nodejs/node-api-headers>.
Attualmente ci sono diversi strumenti o tools per eseguire la build di addons
nativi:
<https://github.com/nodejs/node-gyp>
<https://github.com/cmake-js/cmake-js>
In questo progetto voglio creare un nuovo strumento di build basato su zig <https://ziglang.org/>
sfruttando le sue capacità di compilare codice C e C++ e soprattutto di
garantire la cross compilation. Lo scopo di questo tool è di prendere in input
un progetto e di compilare e restituire come output un native addon.
Partendo dal codice sorgente come quello di seguito riportato:

```c
#include <assert.h>
#include <node_api.h>


static napi_value Method(napi_env env, napi_callback_info info) {
    napi_status status;
    napi_value world;
    status = napi_create_string_utf8(env, "world", 5, &world);
    assert(status == napi_ok);
    return world;
}


static napi_value Initialize(napi_env env, napi_value exports) {
    napi_status status;
    napi_property_descriptor desc = { "hello", 0, Method, 0, 0, 0, napi_default, 0 };
    status = napi_define_properties(env, exports, 1, &desc);
    assert(status == napi_ok);
    return exports;
}


NAPI_MODULE(hello, Initialize)
```

si può eseguire la build eseguendo questi comandi:

## Linux and macOS

```bash
zig cc hello.c -I./node-api-headers/include -shared -o hello.node -Xlinker --allow-shlib-undefined
```

## Windows

```bash
 zig c++ -shared -std=c++17  -I node-api-headers/include -o hello.node hello.cc -L . -lnode_api
```

Per windows occorre creare un libreria stub e ciò può essere fatto andando a
scaricare `node-api-headers` <https://github.com/nodejs/node-api-headers> e poi
creando uno script come quello di seguito riportato:

```js
'use strict'

const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { def_paths } = require('node-api-headers')

async function main() {
    await exec(` dlltool -d ${def_paths.node_api_def} -y libnode_api.a`)
}
main().catch(err => console.error(err))
```

Usand TypeScript implementa un nuovo strumento di build che usi le capacità
del compilatore zig e che sin grado di compilare sia codice C che C++. Il tool
deve avere gli stessi comandi di `node-gyp` e `cmake-js` e deve funzionare così
come di seguito riportato:
Una volta installato come tool da riga di comando quando si avvia la prima volta
se non esiste crea la cartella `.marmotta` all'interno della cartella home
dell'utente. Quesga cartella sarà la root per il funzionamento e l'elaborazione di
tutte le operazioni di build. Se la cartella esiste già non verrà eseuita nessuna
operazione si deve dare per scontato che questa inizializzazione si già stata
eseguita. Il sistema a questo punto deve controllare che sia presente nel sistema
un'installazione del compilatore zig in caso contrario ne scaricherà una da questo
indirizzo base <https://ziglang.org/download/>. a questo punto il sistema imposta
tutti i path necessari per l'esecuzione dei comandi necessari per la compilazione
del codice C / C++.
