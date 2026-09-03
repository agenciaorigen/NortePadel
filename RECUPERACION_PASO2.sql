-- ============================================================
-- RECUPERACIÓN DE EMERGENCIA — PASO 2 de 2
-- ============================================================
-- Corré esto DESPUÉS del PASO 1, en una consulta nueva. Para cada persona
-- (agrupando por nombre completo) crea UNA cuenta real (auth.users +
-- jugadores) con la categoría de mayor puntaje como principal, con la
-- contraseña provisoria "Padel2026" (la misma que ya repartiste con el CSV
-- — quien entre por primera vez con su usuario y esa clave va a tener que
-- cambiarla, como estaba planeado). Todas sus categorías (incluida la
-- principal) quedan reflejadas en ranking_categoria.
-- ============================================================

do $$
declare
  grupo record;
  fila record;
  v_auth_id uuid;
  v_jugador_id uuid;
  v_nombre text;
  v_apellido text;
  nombre_split text[];
begin
  -- 1) una cuenta por persona (agrupando por clave_persona, no por
  --    nombre_completo directo — ver comentario en el PASO 1), con su
  --    categoría de mayor puntaje como principal
  for grupo in
    select distinct on (t.clave_persona)
      t.clave_persona, t.nombre_completo, t.categoria, t.usuario, t.puntos
    from _recuperacion_circuito t
    order by t.clave_persona, t.puntos desc
  loop
    nombre_split := regexp_split_to_array(trim(grupo.nombre_completo), '\s+');
    v_nombre := nombre_split[1];
    v_apellido := array_to_string(nombre_split[2:array_length(nombre_split,1)], ' ');
    if v_apellido is null or v_apellido = '' then v_apellido := v_nombre; end if;

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change, email_change_token_new,
      is_super_admin
    ) values (
      '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
      grupo.usuario, crypt('Padel2026', gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}', '{}',
      '', '', '', '',
      false
    )
    returning id into v_auth_id;

    insert into jugadores (nombre, apellido, categoria, puntos_ranking, auth_user_id, email, activo, debe_cambiar_clave)
    values (initcap(v_nombre), initcap(v_apellido), grupo.categoria, grupo.puntos, v_auth_id, grupo.usuario, true, true)
    returning id into v_jugador_id;

    insert into ranking_categoria (jugador_id, categoria, puntos_ranking)
    values (v_jugador_id, grupo.categoria, grupo.puntos)
    on conflict (jugador_id, categoria) do nothing;

    -- guardamos el id ya resuelto en TODAS las filas de esta persona (no
    -- volvemos a buscar por nombre después — evita fallar con nombres de una
    -- sola palabra, tipo "Robiño" o "Marcos", donde nombre+apellido no
    -- reconstruye igual al nombre_completo original)
    update _recuperacion_circuito set jugador_id = v_jugador_id where clave_persona = grupo.clave_persona;
  end loop;

  -- 2) el resto de las categorías de cada persona (si juega en más de una)
  for fila in
    select t.jugador_id, t.categoria, t.puntos from _recuperacion_circuito t
  loop
    if fila.jugador_id is not null then
      insert into ranking_categoria (jugador_id, categoria, puntos_ranking)
      values (fila.jugador_id, fila.categoria, fila.puntos)
      on conflict (jugador_id, categoria) do update set puntos_ranking = excluded.puntos_ranking, updated_at = now();
    end if;
  end loop;
end $$;

drop table _recuperacion_circuito;

-- resumen
select count(*) as jugadores_totales from jugadores;
select count(*) as filas_ranking_categoria from ranking_categoria;

-- lista de las 17 categorías que quedaron en 0 puntos, para corregir a mano
select j.nombre, j.apellido, rc.categoria, rc.puntos_ranking
from ranking_categoria rc
join jugadores j on j.id = rc.jugador_id
where rc.puntos_ranking = 0
order by j.nombre, j.apellido;
