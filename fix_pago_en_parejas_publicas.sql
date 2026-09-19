-- Bug encontrado: parejas_publicas() e inscriptos_publicos() nunca devolvían
-- la columna de pago (inscripciones.pago), aunque el panel de Inscripciones
-- ya la lee (jugador1_pago/jugador2_pago) y ya tiene los botones para
-- marcarla. Resultado: los ✅/⬜ de pago en el admin siempre mostraban "no
-- pagó", tocaras lo que tocaras -- probable causa de la confusión con los
-- pagos tardíos del último torneo.
--
-- Este script:
-- 1) Se asegura de que inscripciones.pago exista (no debería hacer nada si
--    ya está, es solo un resguardo).
-- 2) Agrega esa columna a las dos funciones públicas que alimentan el panel
--    de Inscripciones y el armado de fixture.
--
-- Corré esto una sola vez en el SQL Editor de Supabase.

alter table inscripciones add column if not exists pago boolean not null default false;

drop function if exists inscriptos_publicos(uuid);
create or replace function inscriptos_publicos(p_torneo_id uuid) returns table (
  jugador_id uuid, nombre text, apellido text, categoria text, categoria_torneo text, estado text, pago boolean
) language sql stable security definer set search_path = public as $$
  select j.id, j.nombre, j.apellido, j.categoria, i.categoria, i.estado, i.pago
  from inscripciones i join jugadores j on j.id = i.jugador_id
  where i.torneo_id = p_torneo_id
  order by j.apellido;
$$;

drop function if exists parejas_publicas(uuid);
create or replace function parejas_publicas(p_torneo_id uuid) returns table (
  id uuid, jugador1_id uuid, jugador2_id uuid, jugador1_nombre text, jugador2_nombre text,
  categoria text, estado text, motivo_rechazo text, jugador1_pago boolean, jugador2_pago boolean
) language sql stable security definer set search_path = public as $$
  select p.id, p.jugador1_id, p.jugador2_id,
    j1.nombre || ' ' || j1.apellido, j2.nombre || ' ' || j2.apellido,
    coalesce(p.categoria, i1.categoria), coalesce(i1.estado, 'pendiente'), i1.motivo_rechazo,
    coalesce(i1.pago, false), coalesce(i2.pago, false)
  from parejas p
  join jugadores j1 on j1.id = p.jugador1_id
  join jugadores j2 on j2.id = p.jugador2_id
  left join inscripciones i1 on i1.torneo_id = p.torneo_id and i1.jugador_id = p.jugador1_id
  left join inscripciones i2 on i2.torneo_id = p.torneo_id and i2.jugador_id = p.jugador2_id
  where p.torneo_id = p_torneo_id;
$$;
