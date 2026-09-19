-- Fix para campeones_publico(): faltaba la categoría de cada campeonato y un
-- "limit 8" cortaba la lista cuando el torneo tiene más de 8 categorías
-- (recorta por fecha, mezclando todos los torneos/categorías juntos).
--
-- Corre esto una sola vez en el SQL Editor de Supabase. Reemplaza la función
-- completa (mismo nombre, misma firma de columnas + categoria nueva) — no
-- hace falta tocar ninguna tabla ni dato existente.

drop function if exists campeones_publico();

create or replace function campeones_publico() returns table (
  torneo_id uuid, torneo_nombre text, categoria text, fecha date,
  jugador1_id uuid, jugador1_nombre text, jugador1_apellido text, jugador1_foto text,
  jugador2_id uuid, jugador2_nombre text, jugador2_apellido text, jugador2_foto text
) language sql stable security definer set search_path = public as $$
  select t.id, t.nombre, pt.categoria, coalesce(t.fecha_fin, t.fecha_inicio),
    j1.id, j1.nombre, j1.apellido, j1.foto_url,
    j2.id, j2.nombre, j2.apellido, j2.foto_url
  from partidos pt
  join torneos t on t.id = pt.torneo_id
  join parejas p on p.id = pt.ganador_pareja_id
  join jugadores j1 on j1.id = p.jugador1_id
  join jugadores j2 on j2.id = p.jugador2_id
  where pt.ronda = 'Final' and pt.estado = 'jugado' and pt.ganador_pareja_id is not null
  order by coalesce(t.fecha_fin, t.fecha_inicio) desc, pt.categoria;
$$;
