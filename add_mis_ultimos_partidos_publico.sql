-- Nueva función para "Tus últimos partidos" (Inicio, solo con sesión iniciada):
-- últimos partidos JUGADOS de un jugador puntual, en cualquier torneo/categoría
-- en que haya participado. Devuelve las mismas columnas que ya usa
-- partidos_publicos() para la tarjeta de partido (pareja1_nombre, sets, etc.)
-- más torneo_nombre/categoria, para poder reutilizar la tarjeta ya existente
-- (llavePartidoCardHtml en app.js) sin duplicar ese template.
--
-- Corre esto una sola vez en el SQL Editor de Supabase. No toca funciones
-- existentes ni datos.

drop function if exists mis_ultimos_partidos_publico(uuid, int);

create or replace function mis_ultimos_partidos_publico(p_jugador_id uuid, p_limit int default 5)
returns table (
  id uuid, torneo_id uuid, torneo_nombre text, categoria text, ronda text, slot_cuadro text,
  horario timestamptz, estado text, sets jsonb,
  cancha_nombre text, complejo_nombre text,
  pareja1_id uuid, pareja2_id uuid, ganador_pareja_id uuid,
  pareja1_nombre text, pareja2_nombre text
) language sql stable security definer set search_path = public as $$
  select pa.id, pa.torneo_id, t.nombre, pa.categoria, pa.ronda, pa.slot_cuadro,
    pa.horario, pa.estado, pa.sets,
    c.nombre, comp.nombre,
    pa.pareja1_id, pa.pareja2_id, pa.ganador_pareja_id,
    coalesce(j1a.nombre || ' ' || j1a.apellido || ' / ' || j1b.nombre || ' ' || j1b.apellido, '?'),
    coalesce(j2a.nombre || ' ' || j2a.apellido || ' / ' || j2b.nombre || ' ' || j2b.apellido, '?')
  from partidos pa
  join torneos t on t.id = pa.torneo_id
  join parejas mia on mia.id in (pa.pareja1_id, pa.pareja2_id)
    and (mia.jugador1_id = p_jugador_id or mia.jugador2_id = p_jugador_id)
  left join canchas c on c.id = pa.cancha_id
  left join complejos comp on comp.id = c.complejo_id
  left join parejas p1 on p1.id = pa.pareja1_id
  left join jugadores j1a on j1a.id = p1.jugador1_id
  left join jugadores j1b on j1b.id = p1.jugador2_id
  left join parejas p2 on p2.id = pa.pareja2_id
  left join jugadores j2a on j2a.id = p2.jugador1_id
  left join jugadores j2b on j2b.id = p2.jugador2_id
  where pa.estado = 'jugado' and pa.ganador_pareja_id is not null
  order by pa.horario desc nulls last, pa.created_at desc
  limit p_limit;
$$;
