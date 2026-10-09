# «La manta»: escenas de prueba ficticias

**Estos textos NO son la escena de Juan.** Son escenas de prueba escritas para las pruebas del
Consejero a partir de la descripción que Juan dio de las dos versiones (2026-10-09). Sirven
para comprobar que Procesador lee la selección completa, respeta la continuidad, no inventa
acontecimientos y juzga una escena adulta por su oficio. Cuando Juan recupere los textos
reales, se usarán en una segunda ronda (`scripts/la-manta-eval.ts --original … --defectuosa …`).

- `original.txt`: la versión del autor (prueba). Pola, de 18 años y embarazada, viaja en bus
  a Santiago. Ya conoce a don Eduardo, que le ofrece su manta por el frío. Más tarde ella lo
  invita a compartirla, y la intimidad crece con gestos, silencios y contacto.
- `defectuosa.txt`: la reescritura que se quiere evitar (prueba). Eduardo es un desconocido.
  Hay una parada de carretera, monedas para el baño, un bolso, un boleto y una casualidad que
  los sienta juntos. La progresión emocional desaparece.

Las dos se usan en `tests/unit/la-manta-prueba.test.ts`, `tests/e2e/revisar-escena.test.mjs`
y `scripts/la-manta-eval.ts`.
