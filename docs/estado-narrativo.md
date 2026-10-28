# Estado narrativo de los personajes

Memoria de continuidad por personaje y capítulo: dónde está, qué sabe, en qué estado físico
está, qué lleva y si vive al terminar cada capítulo. Responde a la pregunta «¿en qué punto
estaba este personaje cuando empieza esta escena?», que la Memoria actual no contesta.

## Estado de la implementación

- [x] Núcleo puro (`src/lib/narrative-state.ts`): tipo, estado vigente antes de un capítulo,
  descripción para el contexto y advertencia por personaje muerto que vuelve a aparecer.
  Pruebas en `tests/unit/narrative-state.test.ts`.
- [x] Persistencia: tabla `character_states` (`supabase/actualizar-estado-narrativo.sql` y
  `schema.sql`), con el patrón de `facts`: RLS, claves compuestas, una fila por personaje y
  capítulo. La posición del capítulo no se guarda: se calcula al leer (`loadCharacterStates`
  en `src/lib/narrative-state-server.ts`), así reordenar capítulos no la deja desfasada.
  Verificada en PostgreSQL 16: migración sobre el esquema anterior, repetida dos veces, y
  esquema completo dos veces.
- [ ] Lectura automática: la lectura de capítulos (`chapter_digests`) propone estados al
  cerrar un capítulo, con cita verificada; nunca cuentan hasta que el autor los aprueba.
- [ ] Escritura y edición: falta la ruta que guarda y aprueba estados (ahora sólo se leen)
- [ ] Edición en la ficha del personaje (memoria visual y fichas de Memoria).
- [ ] Contexto del Asistente: el estado vigente de cada personaje en escena entra en la
  sección de memoria, junto a sus fichas.
- [ ] Advertencias de continuidad en la propuesta, con `deadCharacterWarnings`, integradas
  en `continuity.ts`.

## Reglas

- Sólo los estados `approved` cuentan. Los `suggested` viven en la lectura, no en la Memoria.
- El estado vigente de un capítulo es el aprobado del capítulo anterior más reciente. Los
  estados del propio capítulo no se usan al escribirlo.
- Una advertencia de muerte es un «revisa»: un personaje que muere puede recordarse. La
  detección mira menciones cercanas con verbos de memoria y no bloquea nada.
- Como en el resto de la Memoria, nada se escribe en el manuscrito sin el autor.

## Decisiones

- Tabla propia, no dentro de `chapter_digests`: cada estado se edita y aprueba por separado.
