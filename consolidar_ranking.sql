-- ============================================================
-- CONSOLIDACIÓN DEL RANKING PRE-CARGADO
-- ============================================================
-- Los jugadores que entraron al club con el ranking del circuito (fecha 7 en
-- curso) se cargaron con un email/cuenta provisorio por categoría —una
-- persona que juega en 3 categorías quedó como 3 "jugadores" distintos en vez
-- de uno solo con 3 puntajes. Este script junta esas filas en UNA por
-- persona, con todas sus categorías reflejadas en ranking_categoria (que es
-- lo que muestra la pantalla de Ranking), y borra las filas de más.
--
-- Si la persona YA tiene una cuenta real (se registró de verdad), sus
-- categorías provisorias se juntan en SU cuenta real en vez de crear una
-- nueva — no se pisa su categoría principal ni sus puntos actuales.
--
-- Es un solo bloque atómico (no crea tablas intermedias), corré todo de una
-- sola vez en una consulta nueva.
-- ============================================================

create extension if not exists unaccent;

-- 1) asegurar que TODOS los jugadores (reales y provisorios) tengan su
--    categoría principal reflejada en ranking_categoria (igual que hace
--    schema.sql en el alta inicial — acá cubre a los provisorios, que se
--    insertaron directo en la tabla jugadores)
insert into ranking_categoria (jugador_id, categoria, puntos_ranking)
select id, categoria, puntos_ranking from jugadores
on conflict (jugador_id, categoria) do nothing;

-- 2) juntar los duplicados por nombre+apellido
do $$
declare
  grupo record;
  fila record;
  v_real_id uuid;
  v_canonico_id uuid;
begin
  for grupo in
    select unaccent(upper(trim(nombre || ' ' || apellido))) as clave
    from jugadores
    where email like '%@circuito.nortepadel'
    group by clave
  loop
    -- ¿ya existe una cuenta REAL (no provisoria) con este mismo nombre?
    select id into v_real_id
    from jugadores
    where unaccent(upper(trim(nombre || ' ' || apellido))) = grupo.clave
      and email not like '%@circuito.nortepadel'
    limit 1;

    if v_real_id is not null then
      v_canonico_id := v_real_id;
    else
      select id into v_canonico_id
      from jugadores
      where unaccent(upper(trim(nombre || ' ' || apellido))) = grupo.clave
        and email like '%@circuito.nortepadel'
      order by puntos_ranking desc, created_at asc
      limit 1;
    end if;

    for fila in
      select id, categoria, puntos_ranking, auth_user_id
      from jugadores
      where unaccent(upper(trim(nombre || ' ' || apellido))) = grupo.clave
        and email like '%@circuito.nortepadel'
        and id <> v_canonico_id
    loop
      insert into ranking_categoria (jugador_id, categoria, puntos_ranking)
      values (v_canonico_id, fila.categoria, fila.puntos_ranking)
      on conflict (jugador_id, categoria) do update set puntos_ranking = excluded.puntos_ranking, updated_at = now();

      if fila.auth_user_id is not null then
        delete from auth.users where id = fila.auth_user_id;
      else
        delete from jugadores where id = fila.id;
      end if;
    end loop;
  end loop;
end $$;

-- resumen: cuántos jugadores quedaron y cuántas filas de ranking_categoria
select count(*) as jugadores_totales from jugadores;
select count(*) as filas_ranking_categoria from ranking_categoria;

-- lista final para repartir usuario/clave: UN solo usuario por persona (el
-- que sobrevivió después de juntar sus categorías) — la clave sigue siendo
-- la misma provisoria que ya repartiste (Padel2026), esto es solo para que
-- sepas cuál de los emails de cada persona es el que sigue existiendo.
select nombre, apellido, email as usuario, categoria as categoria_principal
from jugadores
where email like '%@circuito.nortepadel'
order by nombre, apellido;
