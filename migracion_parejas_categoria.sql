-- ============================================================
-- Migración: la categoría pasa a vivir en la propia pareja (parejas.categoria),
-- no solo en "inscripciones".
--
-- Por qué: "inscripciones" tiene UNIQUE(torneo_id, jugador_id) -- un jugador
-- solo puede tener UNA fila ahí por torneo, aunque juegue dos categorías (con
-- dos parejas distintas). Hasta ahora, parejas_publicas() sacaba la categoría
-- de esa única inscripción de jugador1 -- para alguien que juega dos
-- categorías, eso mostraba la categoría equivocada en una de sus dos parejas
-- (se detectó cargando las parejas de jugadores que juegan 2 categorías a la
-- vez, ej. Emanuel Espinola, Alan Jagner, Lautaro Pereira). Con esta
-- migración cada pareja guarda su propia categoría, así que siempre es
-- correcta sin importar cuántas categorías juegue cada uno.
--
-- Seguro de re-correr (columna con "if not exists", funciones con "or replace").
-- ============================================================

alter table parejas add column if not exists categoria text;
update parejas set categoria = (
  select i.categoria from inscripciones i
  where i.torneo_id = parejas.torneo_id and i.jugador_id = parejas.jugador1_id
) where categoria is null;

drop function if exists parejas_publicas(uuid);
create or replace function parejas_publicas(p_torneo_id uuid) returns table (
  id uuid, jugador1_id uuid, jugador2_id uuid, jugador1_nombre text, jugador2_nombre text,
  categoria text, estado text, motivo_rechazo text
) language sql stable security definer set search_path = public as $$
  select p.id, p.jugador1_id, p.jugador2_id,
    j1.nombre || ' ' || j1.apellido, j2.nombre || ' ' || j2.apellido,
    coalesce(p.categoria, i1.categoria), coalesce(i1.estado, 'pendiente'), i1.motivo_rechazo
  from parejas p
  join jugadores j1 on j1.id = p.jugador1_id
  join jugadores j2 on j2.id = p.jugador2_id
  left join inscripciones i1 on i1.torneo_id = p.torneo_id and i1.jugador_id = p.jugador1_id
  where p.torneo_id = p_torneo_id;
$$;

create or replace function inscribirse_con_pareja(p_torneo_id uuid, p_pareja_jugador_id uuid default null, p_categoria text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_mi_id uuid;
begin
  select id into v_mi_id from jugadores where auth_user_id = auth.uid();
  if v_mi_id is null then
    raise exception 'Completá tu perfil de jugador antes de inscribirte';
  end if;
  if p_pareja_jugador_id is null or p_pareja_jugador_id = v_mi_id then
    raise exception 'Elegí con quién vas a jugar antes de inscribirte: no te podés anotar solo/a';
  end if;
  if p_categoria is null or not exists (
    select 1 from torneo_categorias where torneo_id = p_torneo_id and categoria = p_categoria
  ) then
    raise exception 'Elegí en qué categoría van a jugar este torneo';
  end if;

  insert into inscripciones (torneo_id, jugador_id, categoria)
  values (p_torneo_id, v_mi_id, p_categoria)
  on conflict (torneo_id, jugador_id) do update set categoria = excluded.categoria, estado = 'pendiente', motivo_rechazo = null
  where inscripciones.estado in ('cancelada', 'rechazada');

  insert into inscripciones (torneo_id, jugador_id, categoria)
  values (p_torneo_id, p_pareja_jugador_id, p_categoria)
  on conflict (torneo_id, jugador_id) do update set categoria = excluded.categoria, estado = 'pendiente', motivo_rechazo = null
  where inscripciones.estado in ('cancelada', 'rechazada');

  -- antes: bloqueaba si YA tenías cualquier pareja en el torneo, sin importar
  -- la categoría -- eso impedía anotarse a una segunda categoría. Ahora el
  -- chequeo es por categoría, así que jugar dos categorías con parejas
  -- distintas funciona.
  if not exists (
    select 1 from parejas
    where torneo_id = p_torneo_id and categoria = p_categoria
      and (jugador1_id in (v_mi_id, p_pareja_jugador_id) or jugador2_id in (v_mi_id, p_pareja_jugador_id))
  ) then
    insert into parejas (torneo_id, jugador1_id, jugador2_id, categoria) values (p_torneo_id, v_mi_id, p_pareja_jugador_id, p_categoria);
  end if;

  insert into notificaciones (jugador_id, mensaje, torneo_id, pantalla)
  select p_pareja_jugador_id,
    (select nombre || ' ' || apellido from jugadores where id = v_mi_id) || ' te anotó como su pareja en un torneo. ¡Ya quedaste inscripto!',
    p_torneo_id, 'mi-inscripcion';
end;
$$;
