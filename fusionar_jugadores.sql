-- ============================================================
-- Herramienta para UNIFICAR dos perfiles de jugador que son la misma
-- persona. No hay ningún botón para esto en la app todavía (no existía
-- el caso hasta ahora) — se corre una vez por par confirmado.
--
-- Qué hace fusionar_jugadores(mantener, eliminar):
--  1) Repuntea a "mantener" todo lo que hoy apunta a "eliminar":
--     parejas (jugador1_id/jugador2_id), inscripciones, ranking_categoria
--     y notificaciones — sin perder historial de partidos ni de
--     inscripciones, porque no se toca ninguna fila de "parejas" ni
--     "partidos", solo se les cambia a quién apuntan.
--  2) Si "eliminar" ya estaba inscripto en un torneo donde "mantener"
--     TAMBIÉN estaba inscripto (choque de "un jugador, una inscripción
--     por torneo"), se queda con la de "mantener" y borra la duplicada
--     en vez de romper.
--  3) Si "eliminar" tenía puntos en una categoría de ranking_categoria
--     donde "mantener" también tenía fila, SUMA los puntos y partidos en
--     vez de pisarlos.
--  4) Suma jugadores.puntos_ranking/partidos_jugados/partidos_ganados de
--     "eliminar" dentro de "mantener".
--  5) Si "eliminar" tiene una cuenta propia (auth_user_id, o sea que esa
--     persona alguna vez entró a la app con ESE perfil) y "mantener" no
--     tiene, le pasa el login a "mantener" -- así esa persona sigue
--     pudiendo entrar, ahora al perfil unificado. Si LOS DOS tienen login
--     propio, la función frena con un error en vez de decidir sola: eso
--     hay que resolverlo a mano vos (juntar dos logins reales de una vez
--     no es seguro hacerlo a ciegas).
--  6) Borra el perfil "eliminar" (ya no le queda nada apuntando).
--
-- Corré esto UNA VEZ para crear la función:
-- ============================================================

create or replace function fusionar_jugadores(p_mantener uuid, p_eliminar uuid) returns text as $$
declare
  v_login_mantener uuid;
  v_login_eliminar uuid;
  v_nombre_mantener text;
  v_nombre_eliminar text;
begin
  if p_mantener = p_eliminar then
    raise exception 'Los dos ids son el mismo jugador — no hay nada que fusionar';
  end if;

  select auth_user_id, nombre || ' ' || apellido into v_login_mantener, v_nombre_mantener from jugadores where id = p_mantener;
  select auth_user_id, nombre || ' ' || apellido into v_login_eliminar, v_nombre_eliminar from jugadores where id = p_eliminar;

  if v_login_mantener is null then
    raise exception 'No existe ningún jugador con id % (a mantener)', p_mantener;
  end if;
  if v_nombre_eliminar is null then
    raise exception 'No existe ningún jugador con id % (a eliminar)', p_eliminar;
  end if;
  if v_login_mantener is not null and v_login_eliminar is not null then
    raise exception 'Los dos perfiles (% y %) tienen cuenta propia (auth_user_id) — resolvé a mano cuál de las dos cuentas de acceso se conserva antes de fusionar', v_nombre_mantener, v_nombre_eliminar;
  end if;

  -- parejas: si por algún motivo "eliminar" y "mantener" ya estaban
  -- juntos en la MISMA pareja (no debería pasar en la práctica), no se
  -- puede dejar jugador1_id = jugador2_id -- se salta esa fila y avisa.
  update parejas set jugador1_id = p_mantener where jugador1_id = p_eliminar and jugador2_id <> p_mantener;
  update parejas set jugador2_id = p_mantener where jugador2_id = p_eliminar and jugador1_id <> p_mantener;
  if exists (select 1 from parejas where (jugador1_id = p_eliminar and jugador2_id = p_mantener) or (jugador2_id = p_eliminar and jugador1_id = p_mantener)) then
    raise notice 'Hay una pareja donde % y % ya estaban juntos como compañeros -- esa fila no se tocó, revisala a mano (probablemente un error de carga aparte)', v_nombre_mantener, v_nombre_eliminar;
  end if;

  -- inscripciones: unique (torneo_id, jugador_id) -- si "mantener" ya
  -- tenía inscripción en ese torneo, se descarta la de "eliminar".
  delete from inscripciones i
    where i.jugador_id = p_eliminar
      and exists (select 1 from inscripciones i2 where i2.jugador_id = p_mantener and i2.torneo_id = i.torneo_id);
  update inscripciones set jugador_id = p_mantener where jugador_id = p_eliminar;

  -- ranking_categoria: unique (jugador_id, categoria) -- si las dos
  -- tenían fila en la misma categoría, se suman puntos y partidos.
  update ranking_categoria rc_m set
    puntos_ranking = rc_m.puntos_ranking + rc_e.puntos_ranking,
    partidos_jugados = rc_m.partidos_jugados + rc_e.partidos_jugados,
    partidos_ganados = rc_m.partidos_ganados + rc_e.partidos_ganados,
    updated_at = now()
    from ranking_categoria rc_e
    where rc_e.jugador_id = p_eliminar and rc_m.jugador_id = p_mantener and rc_m.categoria = rc_e.categoria;
  delete from ranking_categoria rc_e
    where rc_e.jugador_id = p_eliminar
      and exists (select 1 from ranking_categoria rc_m where rc_m.jugador_id = p_mantener and rc_m.categoria = rc_e.categoria);
  update ranking_categoria set jugador_id = p_mantener where jugador_id = p_eliminar;

  -- notificaciones: no tiene restricción de unicidad, se repuntea directo.
  update notificaciones set jugador_id = p_mantener where jugador_id = p_eliminar;

  -- puntos/estadísticas globales + login (si "eliminar" tenía uno y "mantener" no).
  -- OJO: jugadores tiene un trigger (trg_proteger_categoria) que descarta
  -- cambios a puntos_ranking/categoria salvo que is_admin() dé true -- y
  -- corriendo esto desde el SQL Editor no hay sesión de admin logueada, así
  -- que sin desactivarlo un ratito la suma de puntos se pisa en silencio
  -- (se pierde) aunque el resto de la fusión salga bien. Se reactiva antes
  -- de terminar, pase lo que pase.
  alter table jugadores disable trigger trg_proteger_categoria;
  update jugadores m set
    puntos_ranking = m.puntos_ranking + e.puntos_ranking,
    partidos_jugados = m.partidos_jugados + e.partidos_jugados,
    partidos_ganados = m.partidos_ganados + e.partidos_ganados,
    auth_user_id = coalesce(m.auth_user_id, e.auth_user_id),
    email = coalesce(m.email, e.email)
    from jugadores e
    where m.id = p_mantener and e.id = p_eliminar;
  alter table jugadores enable trigger trg_proteger_categoria;

  delete from jugadores where id = p_eliminar;

  return format('Fusionado: %s (id %s) absorbido por %s (id %s)', v_nombre_eliminar, p_eliminar, v_nombre_mantener, p_mantener);
end;
$$ language plpgsql;

-- ============================================================
-- Uso: UNA línea por par ya confirmado (mirá antes preview_fusion_duplicados.sql
-- para elegir cuál id conviene conservar -- normalmente el que tiene más
-- puntos/partidos/login propio). Corré de a un select por vez la primera
-- vez, para leer el mensaje de confirmación de cada fusión.
-- ============================================================

-- select fusionar_jugadores('<id a MANTENER>'::uuid, '<id a ELIMINAR>'::uuid);

-- Ejemplo real con el caso que preguntaste (ajustá si preferís conservar
-- el otro id -- "Facundo Vera" tiene más puntos y categoría más alta, por
-- eso lo dejo como el que se mantiene; confirmá antes de correrlo):
-- select fusionar_jugadores('bdd2a705-b964-4d8d-89cd-63d3536a1f12'::uuid, 'ba851067-602d-4471-8c49-75e8e357379e'::uuid);
