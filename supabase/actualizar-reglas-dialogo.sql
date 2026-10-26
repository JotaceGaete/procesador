-- Reglas permanentes de voz y conducta, editables en la ficha de cada personaje.
-- Ejecutar en el proyecto Supabase de Procesador antes de desplegar la función.
ALTER TABLE public.characters
  ADD COLUMN IF NOT EXISTS dialogue_rules text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.characters.dialogue_rules IS
  'Restricciones permanentes para los diálogos del personaje; no sustituye las indicaciones particulares de cada escena.';
