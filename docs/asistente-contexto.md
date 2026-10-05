# Asistente: la historia hasta aquí, y «Ver contexto»

> Estado: **fases 1, 2 y 3 implementadas, y la Fase 2 del plan profesional** (ignorancia temporal, comparar antes de aplicar, «Ver contexto» de la petición real; §8–§10). Decisiones tomadas al final.

## El problema

Hoy «Desarrollar escena» envía al modelo:

- ≈1.000 palabras antes del cursor y ≈250 después;
- el final del capítulo anterior, sólo si el cursor está al principio del capítulo;
- la Guía Maestra;
- la Memoria seleccionada por nombres.

De todo lo que pasó antes sólo le llega lo que el autor haya convertido en hechos aprobados. El Consejero, en cambio, ya mantiene para cada capítulo una **ficha** verificada (resumen, acontecimientos, quién está en escena, revelaciones y cabos) y una lista de **hilos**. El Asistente no la usa.

Además, el autor no puede ver qué recibe el modelo: sólo un número de tokens.

## Objetivos

1. Que el Asistente sepa **qué ha pasado hasta este punto de la novela**, quién sabe qué y qué cabos siguen abiertos.
2. **Sin coste de IA adicional al escribir.** Se usa sólo lo que ya existe; nunca se genera una ficha por debajo.
3. **Sin adelantar el futuro.** Una escena del capítulo 4 no puede apoyarse en lo que ocurre en el 7.
4. **Precedencia clara**, de más a menos autoridad:
   1. el argumento del autor;
   2. los hechos aprobados y las fichas de personaje;
   3. el texto del manuscrito;
   4. las fichas de capítulo, que son derivadas y pueden estar desactualizadas.
5. **«Ver contexto»** muestra exactamente lo que se enviará, construido por el mismo código que arma la petición.

## 1. Qué se añade a la petición de una escena

Se llama **«La historia hasta aquí»**: un bloque nuevo, entre la Memoria y la tarea. Tiene presupuesto propio y se recorta en este orden de prioridad.

### 1.1 Capítulo actual: lo anterior al cursor, más allá de la ventana

Hoy, si el cursor está en la página 20 del capítulo, las páginas 1 a 15 no se envían.

- **Propuesta:** el texto del capítulo desde su inicio hasta la ventana, hasta ~6.000 tokens. Si no cabe, se envía el comienzo y un aviso de omisión.
- **No se usa la ficha del capítulo actual:** describe el capítulo entero, incluido lo que viene después del cursor, y además se queda vieja mientras se escribe.
- **Coste:** sólo pesa en capítulos largos; en los cortos ya está todo en la ventana.

### 1.2 Fichas de los capítulos anteriores, nunca de los posteriores

Se ordenan del más cercano al más lejano, con tres niveles de detalle:

| Capítulos | Qué se envía de su ficha |
|---|---|
| El anterior (k−1) y el previo (k−2) | Ficha completa: resumen, acontecimientos (con quién), quién está en escena, revelaciones y cabos que abre, avanza o cierra. **Sin las citas ancla**: no aportan a escribir y cuestan tokens. |
| Anteriores donde aparece (`present`) algún personaje de la escena | Resumen y las revelaciones que conciernen a esos personajes |
| El resto de los anteriores | Una línea: la primera frase del resumen |

- **Recorte:** si no cabe, se pierden primero las líneas sueltas de los capítulos más antiguos, luego los resúmenes intermedios. Las dos fichas más cercanas se recortan las últimas.
- **Frescura:** se usa el estado que el Consejero ya calcula.
  - `current` y `touched`: se envían tal cual.
  - `stale`: se envían marcadas como «versión anterior del capítulo». El modelo sabe que el texto cambió después.
  - `missing`: no se envían y figuran en «Ver contexto» como *sin ficha*.
  - **No se leen capítulos automáticamente al escribir:** eso es del Consejero y tiene su propio interruptor.
- **El resumen global** (`novel_digests`) se envía **sólo si la escena va en el último capítulo con texto**. En cualquier otro caso resume también el futuro y queda fuera.

### 1.3 Quién sabe qué: revelaciones hasta aquí

Las fichas ya registran, por capítulo, qué se revela y a quién (al lector o a un personaje).

- Para los personajes de la escena se juntan sus revelaciones de los capítulos anteriores: «Elena sabe que Juan estuvo con Marta (cap. 3)».
- Se envían junto a su ficha de personaje, como complemento del *Sabe / No sabe* escrito por el autor. Si se contradicen, **manda la ficha del autor**.

Esto es lo que más protege de errores graves de continuidad: que un personaje reaccione a algo que todavía no sabe.

### 1.4 Hilos abiertos en este punto

**Un hilo cuenta como abierto aquí** si:

- se abrió en un capítulo anterior o en el actual;
- y no se cerró, o se cierra en un capítulo posterior. Para la escena sigue abierto.

**Cuáles se envían:**

- los **confirmados** o creados por el autor;
- los abandonados, no;
- los posibles, sin confirmar, según la decisión 2 abajo.

**Prioridad**, hasta 12:

1. los que tocaron los dos capítulos anteriores;
2. los que nombran a un personaje de la escena;
3. el resto, por antigüedad.

**Formato:** «Título · tipo · se abre en cap. N · última vez en cap. M — descripción». Va acompañado de la regla que el prompt de escritura ya tiene: *no resuelvas ni abras cabos que el argumento no indique*. Ahora sabrá cuáles son.

### 1.5 Ajustes a la selección de personajes

No son fichas ni hilos, pero sin ellos lo anterior pierde fuerza:

- **Más texto para detectarlos:** los nombres se buscan en todo el texto anterior enviado (≈1.000 palabras), no sólo en las últimas 250.
- **Los que acaban de estar en escena:** se incluyen los personajes `present` en la ficha del capítulo anterior, siempre que el cursor esté en las primeras ~1.500 palabras del capítulo, que es cuando la escena continúa la anterior.
- **Relaciones:** se envían las que unen a un personaje de la escena con otro incluido, igual que hoy, más las de los personajes elegidos en «En escena» con cualquiera. El otro extremo entra sólo con su nombre, no con su ficha.

### 1.6 Con «Incluir la novela completa»

- **Las fichas sobran:** el modelo lee el texto. Se quitan los niveles 1.1 y 1.2.
- **Se mantienen** las revelaciones (1.3) y los hilos (1.4): son estructura, no texto, y lo orientan.
- **Se elimina la duplicación** de hoy: la ventana antes y después del cursor ya no se repite fuera del manuscrito, sólo se indica la posición del cursor.

## 2. Presupuesto

Las cifras son orientativas y quedan como constantes.

| Bloque | Tokens |
|---|---|
| Capítulo actual anterior a la ventana (1.1) | hasta 6.000 (sólo capítulos largos) |
| Fichas anteriores (1.2) | hasta 3.000 |
| Revelaciones (1.3) | hasta 600 |
| Hilos (1.4) | hasta 800 |

Una escena típica pasa de ≈3.000 a ≈6.000–8.000 tokens de entrada: unos centavos con los precios actuales. Sigue lejos del umbral de confirmación (`AI_CONFIRM_TOKENS`).

## 3. Una sola fuente de verdad para «Ver contexto»

El constructor deja de devolver sólo texto. Devuelve **el texto y su inventario**, en la misma pasada:

```ts
interface ContextItem {
  label: string;              // "Pilar", "Cap. 3 · El puerto", "«La carta de Marta»"
  detail?: string;            // lo que verá el autor al desplegar: hecho, resumen, línea del hilo
  reason?: string;            // "nombrada en el argumento", "en escena en el cap. anterior", "elegida"
  note?: string;              // "ficha desactualizada", "sin ficha"
}
interface ContextSection {
  id: "chapter" | "previous" | "guide" | "characters" | "places" | "relationships"
    | "facts" | "story" | "knowledge" | "threads" | "argument" | "manuscript";
  label: string;
  tokens: number;
  items: ContextItem[];
}
```

- `dryRun` (el «Contexto de esta consulta» actual) devuelve `sections`.
- La petición real envía el mismo inventario en el evento `context`, para que la respuesta diga qué se usó.
- Una sección vacía no existe. Nada se lista «por si acaso».
- Las instrucciones internas se cuentan en el total, pero no se muestran como contenido de la novela.
- Una prueba compara, con el modelo simulado, el prompt recibido contra el inventario. Cada ficha, hecho o hilo listado debe estar en el prompt, y nada de la novela debe estar en el prompt sin estar listado.

## 4. Cómo se ve

Junto a «Contexto de esta consulta: ≈6 mil tokens» aparece un enlace discreto, **Ver contexto**, que despliega:

> **La IA tendrá en cuenta**
>
> - Capítulo 4 · desde el inicio hasta el cursor (≈1.800 palabras) y ≈250 palabras después
> - ▸ Lo ocurrido antes: caps. 2–3 en detalle · cap. 1 en una línea *(cap. 1: ficha desactualizada)*
> - ▸ Hilos abiertos: 3
> - ▸ Lo que saben: Pilar (2), Héctor (1)
> - Guía Maestra y sinopsis
> - ▸ Personajes: Pilar *(argumento)*, Héctor *(en escena en el cap. 3)*, Anaís *(elegida)*
> - ▸ Lugares: El puerto
> - ▸ Hechos aprobados: 6
> - ▸ Relaciones: 2
> - Tu argumento
> - **Total aproximado: 6.100 tokens**
>
> *Sin «Incluir la novela completa», el Asistente no lee el manuscrito entero: trabaja con lo de arriba.*

- Cada ▸ se despliega y muestra los elementos concretos: el texto del hecho, la línea del hilo o el resumen enviado.
- No hay botón «quitar». Para cambiar el contexto se usan los controles que ya existen («En escena», «Lugar», la Memoria, el Consejero para leer capítulos). Ver contexto **sólo informa**.
- Si algún capítulo anterior no tiene ficha, aparece una línea: «Caps. 1 y 2 sin ficha: la IA no sabe qué pasó en ellos. Puedes leerlos en Consejero → Lectura.» No hay lectura automática.

La casilla actual cambia de texto (decisión 5):

- **«Leer también la novela completa»**, con una línea de ayuda debajo.
- Activada: «Lee todo el manuscrito: más coherencia y más coste (≈N tokens más por escena).»
- Desactivada: «Usa sólo el contexto seleccionado (ver arriba).»

Se construye igual para «Editar selección». Ahí el contexto es más pequeño: sin fichas, las acciones ligeras sólo llevan personajes. Así el autor ve lo mismo en las dos pestañas.

## 5. Qué cambia en el código

| Pieza | Cambio |
|---|---|
| `src/lib/advisor/advice.ts` | `digestText` y `threadLine` pasan a un módulo compartido. El Consejero los usa igual que hoy. |
| `src/lib/ai/story.ts` (nuevo) | `storySoFar({ chapterIndex, characters, budgets, …})`: fichas anteriores, revelaciones por personaje e hilos abiertos en este punto. Sólo lectura, sin llamadas a la IA. Devuelve texto e inventario. |
| `src/app/api/assist/route.ts` | El modo escena añade el bloque, quita la duplicación con la novela completa y devuelve `sections`. |
| `src/lib/ai/context.ts` | `selectMemory` devuelve también el motivo de cada inclusión. La detección usa el texto anterior completo. |
| `src/lib/ai/prompts.ts` | `scenePrompt` gana `<historia_hasta_aqui>`, `<lo_que_saben>` e `<hilos_abiertos>`. `WRITE_INSTRUCTIONS` explica la precedencia y la ficha «versión anterior». |
| `AssistantPanel.tsx` | «Ver contexto» desplegable y el nuevo texto de la casilla. |
| Esquema | **Ninguno.** Todo sale de tablas existentes. |

Proveedores, modelos y registro de uso no cambian.

## 6. Pruebas

**Unitarias** (`story.ts`):

- Nunca entra información de capítulos posteriores: fichas, revelaciones ni resumen global.
- Un hilo cerrado en un capítulo posterior figura como abierto; uno cerrado antes, no.
- Los presupuestos y el orden de recorte se cumplen.
- Las fichas `stale` van marcadas y las `missing` se listan como *sin ficha*.
- La ficha del capítulo actual nunca se envía.
- Con la novela completa no hay fichas ni duplicación.

**E2E con el modelo simulado:**

- Novela de 6 capítulos con fichas e hilos; escena en el 4. Se comprueba:
  - el prompt contiene los caps. 1–3 y no el 5–6;
  - el hilo cerrado en el 5 aparece abierto;
  - el que se cerró en el 2, no.
- «Ver contexto» lista exactamente lo que el prompt contiene (§3), en escritorio y teléfono.
- Al desplegar «Hechos» se ven los textos de los hechos enviados, y ninguno más.
- Un capítulo sin ficha aparece como tal y no dispara ninguna lectura (el registro `ai_usage` no cambia).

## 7. Fases

1. **Inventario y «Ver contexto»** sobre lo que se envía hoy, más el nuevo texto de la casilla. No cambia lo que recibe el modelo: el autor ve la realidad actual.
2. **La historia hasta aquí:** fichas anteriores, revelaciones e hilos (1.2–1.4), visibles en «Ver contexto».
3. **Capítulo actual completo y selección de personajes** (1.1 y 1.5), y quitar la duplicación con la novela completa (1.6).

Cada fase con sus pruebas y sin regresiones. La 1 es útil sola y hace verificable la 2.

## Decisiones

Tomadas con las propuestas al pedir la fase 2:

- **Resumen global:** sólo cuando la escena va al final de la novela (ningún capítulo posterior con texto y nada después del cursor más allá de lo que ya se envía).
- **Hilos posibles sin confirmar:** no se envían; «Ver contexto» dice cuántos hay.
- **Presupuesto:** 3.000 tokens para fichas, 1.500 para el resumen global, 600 para lo que saben, 800 para los hilos (hasta 12).
- **Con la novela completa:** sin fichas ni resumen global; lo que saben y los hilos sí (se adelantó de la fase 3).
- **Fases:** la 1 primero.

Pendientes:

1. **Resumen global:** ¿sólo en el último capítulo (propuesta) o nunca para escribir?
2. **Hilos posibles, sin confirmar:** ¿se envían marcados como «posible» o se excluyen (propuesta: excluir, y mencionar cuántos hay en «Ver contexto»)?
3. **Presupuesto de la historia hasta aquí:** ¿3.000 tokens para fichas (propuesta) o más generoso?
4. **Capítulo actual completo hasta el cursor (1.1):** ¿se incluye (propuesta: sí, hasta 6.000 tokens)?
5. **Texto de la casilla** «Incluir la novela completa»: ¿el propuesto en §4 u otro?
6. **Orden de fases:** ¿la 1 primero (propuesta) o 1 y 2 juntas?

## 8. Ignorancia temporal al escribir una escena (Fase 2 del plan profesional)

Para escribir una escena, **ignorancia temporal segura antes que un spoiler que el modelo deba fingir no conocer**. Una IA que escribe el capítulo 5 no puede saber lo que el lector y los personajes descubrirán en el 20.

### Qué se encontró

- *Leer también la novela completa* enviaba **toda** la novela: los capítulos posteriores y el texto después del cursor, con una marca donde iba la escena.
- Los **hechos aprobados** de capítulos posteriores entraban si eran relevantes (un personaje de la escena, un lugar, su nombre en el texto), marcados «posterior al capítulo actual» con la instrucción de usarlos sólo para no contradecirlos. **Sí podía filtrarse:** un hecho «Elena es hija de Pedro» ligado al capítulo 20 llegaba al escribir el capítulo 5 si Elena estaba en escena; pedirle al modelo que no lo use no garantiza que no lo insinúe.

### Qué hace ahora

- **«Leer toda la historia hasta aquí»** (antes *Leer también la novela completa*, sólo en *Escribir escena*): los capítulos anteriores y el actual **hasta el cursor**, con la marca al final. Nunca un capítulo posterior ni el texto después del cursor. En *Editar selección* la opción sigue siendo la novela completa: revisar coherencia necesita ver el conjunto, y no escribe nada nuevo.
- **Hechos:** al escribir una escena, los de capítulos posteriores **no se envían** (`selectMemory` con `noLaterThan`). «Ver contexto» dice cuántos se dejaron fuera. Al editar o revisar coherencia se siguen enviando, marcados como posteriores.
- Ya era así: fichas de lectura, revelaciones e hilos sólo de antes del cursor (§1.2–1.4); el resumen global sólo al final de la novela.

### Lo que queda (riesgo residual, registrado en [deuda](deuda.md))

- Un **hecho sin capítulo** se considera conocido desde el principio. Para que un secreto no llegue antes de tiempo, hay que ligarlo al capítulo donde se revela.
- Los **hechos del capítulo actual** se envían aunque se revelen después del cursor: un hecho está ligado a un capítulo, no a un punto del texto.
- Las **fichas de personaje** (secretos, qué sabe, arco) y las **relaciones** son atemporales: lo que el autor escribe en ellas llega a todas las escenas. Un «Arco: al final traiciona a Pedro» es un spoiler para el capítulo 5. La solución natural llega con la cronología (campos con «desde el capítulo…»); hasta entonces, conviene escribir en las fichas lo que el personaje es, no lo que le pasará.

## 9. Comparar antes de aplicar

- **Reemplazar selección** muestra, antes de aceptar, el texto actual frente a la propuesta como prosa: tachado lo que se quita, resaltado lo que se añade, con un resumen («La IA propone quitar 4 palabras y añadir 5»). Pestañas *Cambios*, *Propuesta* y *Tu texto*. Las imágenes y los cambios de escena se ven como tales, no como marcadores. Es el mismo motor de comparación que el historial de versiones (`src/lib/diff.ts`), que agrupa en un solo bloque los cambios separados sólo por espacios o puntuación.
- **Insertar en el cursor** muestra la escena en su lugar, entre el final del párrafo anterior y el comienzo del siguiente, y dónde irá («al principio del capítulo», «en el cursor, entre estos párrafos»…). Sigue al cursor mientras la propuesta espera.
- **Garantías:** nada toca el manuscrito hasta aceptar; al aceptar se guarda primero una versión del texto actual (`ai`, [versiones](versiones.md)) y sólo si se guardó se aplica; si no se puede guardar, o el fragmento ya no está, la propuesta se queda en el panel con el motivo. Cursivas, separadores e imágenes se conservan (`fromModel`, `restoreImages`). En el teléfono la comparación cabe en la hoja inferior con los botones a la vista.

## 10. «Ver contexto»: correcciones

- El **modelo elegido** entra en el cálculo previo (el bloque propio de Grok se cuenta).
- **La petición real devuelve su propio inventario** (el primer evento de la respuesta): bajo cada respuesta, *Ver lo que se envió* muestra lo que de verdad se envió, no la estimación previa.
- **Ampliar** aparece como «La escena a ampliar».
- **Personajes:** cada ficha muestra sus campos con su contenido (abreviado), los mismos que recibe el modelo. Nunca las instrucciones de Procesador.
- **Hechos:** con su momento de la historia (`story_time`) cuando lo tienen.
- **Tokens:** se dice explícitamente que son **estimados** (unos 3,5 caracteres por token); los reales los informa el proveedor bajo la respuesta.


## 11. Dónde va una escena

El cursor podía quedar por accidente en mitad del capítulo, y la escena se escribía para ese punto y se insertaba allí. Ahora el destino es una decisión explícita, que se toma antes de escribir la escena y se respeta hasta insertarla.

- **«Dónde va: Al final del capítulo»** (predeterminado). La escena se escribe para continuar el final del capítulo, y *Insertar al final* la pone después del último contenido **tal como esté al aceptar**, sin mirar el cursor. Si el capítulo acaba en espacios o líneas en blanco, se sustituyen por una sola línea en blanco; un último párrafo, una imagen o un separador no se tocan, y la escena nunca queda pegada al último carácter (`placeAtEnd`, `src/lib/placement.ts`).
- **«Dónde va: En el cursor»** (deliberado). La posición se **fija** al pedir la escena, anclada al texto que la rodea (`anchorAt` / `resolveAnchor`), no a un número que se desplazaría al escribir en otro sitio. *Otra versión*, *Ampliar* y *Probar con…* conservan esa posición.
- Con destino al final, **«Insertar en el cursor…»** sigue disponible como acción secundaria: primero fija la posición actual del cursor y la muestra en la vista previa, y sólo un segundo clic inserta. *Insertar al final en su lugar* vuelve atrás.

**Mover el cursor mientras la propuesta espera no cambia el destino.** La vista previa dice siempre cuál es («Se insertará al final del capítulo» o «Se insertará en la posición actual», con el texto de alrededor) y es exactamente donde se insertará. Para cambiarlo hay que pedirlo: *Fijar en la posición actual del cursor* o *Insertar al final en su lugar*.

Si el texto alrededor de una posición fijada cambia tanto que ya no se encuentra, la vista previa lo dice, *Insertar en el cursor* queda desactivado y no se adivina otro lugar; el final siempre está disponible.

El orden al aceptar es el de la Fase 0: guardar una versión → comprobar que se guardó → resolver el destino sobre el texto de ese momento → insertar → autoguardado. Si falla la copia, el destino ya no existe o el navegador rechaza la edición, no cambia nada y la propuesta se queda.
