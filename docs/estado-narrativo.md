# Estado narrativo de los personajes

Memoria de continuidad por personaje y capítulo: dónde está, qué sabe, en qué estado físico
está, qué lleva y si vive al terminar cada capítulo. Responde a la pregunta «¿en qué punto
estaba este personaje cuando empieza esta escena?», que la Memoria actual no contesta.

## Estado de la implementación

- [x] Núcleo puro (`src/lib/narrative-state.ts`): tipo, estado vigente antes de un capítulo,
  descripción para el contexto y advertencia por personaje muerto que vuelve a aparecer.
  Pruebas en `tests/unit/narrative-state.test.ts`.
- [ ] Persistencia: tabla propia en `supabase/` con el mismo patrón que `facts`
  (`novel_id`, claves compuestas, RLS con `procesador_secure_table`).
- [ ] Lectura automática: la lectura de capítulos (`chapter_digests`) propone estados al
  cerrar un capítulo, con cita verificada; nunca cuentan hasta que el autor los aprueba.
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

## Pendiente de decisión

- ¿La lectura de capítulos guarda los estados dentro de `chapter_digests` (un campo más, sin
  tabla nueva) o en tabla propia? Propuesta: tabla propia, para poder editar y aprobar cada
  estado por separado.
