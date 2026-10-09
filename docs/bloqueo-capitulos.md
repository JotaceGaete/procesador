# Bloqueo de capítulos

Un capítulo revisado se puede bloquear para que nada lo modifique por accidente: ni el autor al
escribir en el capítulo equivocado, ni el Asistente al insertar una propuesta pensada para otro.

## Estados

- 🔓 **En edición** (todos los capítulos, por defecto; también los que ya existían).
- 🔒 **Revisado y bloqueado**: se puede leer, seleccionar, copiar y consultar al Consejero y al
  Crítico. No se puede escribir, pegar, borrar, dar formato, insertar o quitar imágenes, aplicar
  propuestas del Asistente, restaurar una versión, renombrarlo ni enviarlo a la papelera.

## Interfaz

- En la barra superior, junto al estado de guardado, un candado discreto: 🔓 bloquea el capítulo
  abierto (antes guarda lo pendiente); 🔒 *Revisado* lo desbloquea tras una confirmación.
- En el índice de capítulos, 🔒 junto al título; *Renombrar* y *Eliminar* no aparecen.
- Si se intenta escribir en un capítulo bloqueado, un aviso bajo la barra dice por qué.
- En el teléfono el editor no cambia de tamaño ni provoca zoom al bloquear o desbloquear: el
  editor de texto queda en sólo lectura y el visual deja de ser editable con la misma tipografía.
- El Asistente nunca bloquea ni desbloquea: sólo el autor, con el candado.

## Propuestas del Asistente vinculadas a su capítulo

Cada petición al Asistente guarda el id del capítulo para el que se hizo. Antes de aplicar una
propuesta (*Insertar*, *Reemplazar*, también desde *Abrir propuesta*):

1. Se comparan tres identificadores: el capítulo de la propuesta, el capítulo abierto y el
   capítulo del editor que recibiría el texto. Deben ser el mismo.
2. Se comprueba que ese capítulo no esté bloqueado.
3. Se guarda la copia previa (versión «ai») en el servidor, que la rechaza (423) si el capítulo
   está bloqueado.
4. Se vuelve a comprobar 1 y 2, porque el autor pudo cambiar de capítulo mientras se guardaba.

Si algo no coincide, no se aplica nada y el panel lo dice: «Esta propuesta fue preparada para
«Capítulo 8», pero ahora estás en «Capítulo 9». La inserción se ha detenido para evitar modificar
el capítulo equivocado.», con *Volver a «Capítulo 8»*. Mientras la propuesta está a la vista en
otro capítulo, *Insertar* y *Reemplazar* esperan desactivados, la vista previa no se dibuja sobre
el texto ajeno, y *Otra versión* / *Probar con…* piden volver a su capítulo (si no, mezclarían la
petición de un capítulo con el texto de otro).

## Persistencia y servidor

- `chapters.locked` (falso por defecto) y `chapters.locked_at`. `novel_outline` devuelve el
  candado para el índice. Migración: `supabase/actualizar-bloqueo-reserva.sql`, conjunta con la reserva
  (docs/integracion-bloqueo-reserva.md), o `schema.sql` completo.
- `PATCH /api/chapters/:id { locked }` bloquea o desbloquea; es una petición propia: nunca se
  desbloquea y se escribe texto a la vez.
- Guardar texto o título de un capítulo bloqueado responde **423**, también desde una pestaña
  desactualizada o un guardado automático tardío (la consulta exige `locked = false` además de la
  revisión). La pestaña muestra «No se guardó: el capítulo está bloqueado», pasa a sólo lectura y
  conserva en pantalla lo escrito; al desbloquear, lo guarda con la comprobación de revisión de
  siempre.
- 423 también para: enviarlo a la papelera, la copia previa a aplicar la IA o a restaurar una
  versión, y cambiar, reemplazar o eliminar una imagen del libro colocada en él.
- **La base lo hace cumplir**: el trigger `chapters_guard_locked` rechaza (SQLSTATE `P0423`)
  cualquier `update` que cambie `content` o `title` de un capítulo bloqueado, venga de donde venga;
  `trash_chapter` también lo rechaza. El orden de los guardados frente al bloqueo lo decide el
  bloqueo de fila de Postgres: lo que llega después del candado no entra.
- Las tablas siguen con RLS y sin acceso para las claves públicas: sólo el servidor, con la
  contraseña de la app, bloquea y desbloquea.

## Decisiones

- Reordenar capítulos sí está permitido (no cambia el texto).
- Duplicar una novela crea la copia con todos los capítulos desbloqueados (es una copia de trabajo).
  El original no cambia.
- Eliminar la novela entera (acción explícita y confirmada) no se impide por sus candados.
- Guardar una versión con nombre de un capítulo bloqueado sí se permite: no modifica el texto.
