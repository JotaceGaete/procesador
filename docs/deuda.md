# Deuda técnica y funcional

Lo que falta y está decidido que debe hacerse. Ordenado por prioridad.

## Prioritaria — antes de la producción definitiva

### Papelera de novelas completas

- **Estado:** pendiente. Registrada al aceptar la Fase 0 ([versiones](versiones.md)).
- **Problema:** los capítulos ya no se pierden (versiones automáticas, papelera de 30 días), pero **eliminar una novela sigue siendo definitivo**: el `delete` de `novels` borra en cascada capítulos, versiones, Memoria, lectura del Consejero e imágenes. La única protección es la confirmación explícita y la copia de seguridad descargable, que depende de que el autor la haya hecho.
- **Requisito:** no llegar a producción definitiva con eliminación irreversible de una novela.
- **Dirección prevista** (sin implementar):
  - Eliminar una novela la marca como eliminada (`novels.deleted_at`) en vez de borrarla; desaparece de la biblioteca y de todas las rutas, que deben filtrarla.
  - Una *Papelera* en la biblioteca la recupera durante 30 días; pasado ese plazo se borra de verdad, junto con sus archivos de Storage (como hoy `sweep_assets`).
  - Duplicar, la copia de seguridad y el Consejero no deben ver novelas eliminadas.
  - Requerirá actualizar Supabase (columna, filtros, función de vaciado) y pruebas de esquema y E2E equivalentes a las de la papelera de capítulos.

## Pendiente, sin prioridad fijada

- **PDF para imprenta (KDP, IngramSpark)** ([exportación](exportacion.md#8-fuera-de-esta-fase)): composición en el servidor con partición silábica, viudas y huérfanas, fuentes incrustadas y sangrado. Hoy: *DOCX · Libro* con el tamaño de KDP, a PDF desde Word o LibreOffice. También: cubierta completa con lomo, índice en el DOCX, notas al pie, partes.
- Restaurar sólo una parte de una versión de capítulo.
- Incluir las versiones en la copia de seguridad, y restaurar una novela desde una copia.
- Avisar de un `[[separador]]` escrito dentro de un párrafo ([formato](formato-texto.md)).
- **Ignorancia temporal, riesgo residual** ([contexto del Asistente](asistente-contexto.md#8-ignorancia-temporal-al-escribir-una-escena-fase-2-del-plan-profesional)): las fichas de personaje (secretos, qué sabe, arco) y las relaciones son atemporales y llegan a todas las escenas; un hecho sin capítulo cuenta como conocido desde el principio; los hechos del capítulo actual van aunque se revelen tras el cursor. Encaja con la cronología.
- **Cronología, pasos 5 y 6** ([diseño](cronologia-edades.md#estado-de-la-implementación)): edades declaradas en hechos, propuesta de ancla desde la nota libre, marcas dentro de un capítulo, edad de las imágenes de personaje; recuperar de la papelera un capítulo no recupera su marca de tiempo.

