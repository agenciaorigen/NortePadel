-- ============================================================
-- IMPORTACIÓN DEL RANKING — PASO 2 de 2
-- ============================================================
-- Corré esto DESPUÉS del PASO 1 (una vez que terminó sin error), en una
-- consulta nueva. Toma lo que dejó el PASO 1 en _import_ranking_stage y
-- carga los puntos reales en ranking_categoria (creando jugadores nuevos
-- si hace falta). Al final te muestra el resumen actualizado/creado/ambiguo.
-- ============================================================

-- log persistente (no se borra al terminar la transacción) para poder revisar después
create table if not exists _import_ranking_log (
  id bigserial primary key,
  nombre_completo text,
  categoria text,
  puntos numeric(10,1),
  accion text, -- 'creado' | 'actualizado' | 'ambiguo'
  jugador_id uuid,
  creado_at timestamptz not null default now()
);

do $$
declare
  fila record;
  candidatos uuid[];
  nombre_split text[];
  v_nombre text;
  v_apellido text;
  v_jugador_id uuid;
begin
  for fila in select * from _import_ranking_stage loop
    -- busca por "Nombre Apellido" (primera palabra = nombre) o por "Apellido Nombre"
    -- (última palabra = nombre), sin mayúsculas ni acentos, para no depender de en qué
    -- orden esté cargado el jugador ya en la app
    select array_agg(id) into candidatos
    from jugadores
    where unaccent(upper(trim(nombre || ' ' || apellido))) = unaccent(upper(trim(fila.nombre_completo)))
       or unaccent(upper(trim(apellido || ' ' || nombre))) = unaccent(upper(trim(fila.nombre_completo)));

    if candidatos is null or array_length(candidatos, 1) is null then
      -- no existe: lo creamos con la categoría del Excel como principal.
      -- Partido heurístico nombre/apellido: primera palabra = nombre, el resto = apellido
      -- (funciona bien para nombres de una sola palabra + apellido de una o más palabras;
      -- si el jugador real usa el orden inverso, el admin lo corrige a mano una vez).
      nombre_split := regexp_split_to_array(trim(fila.nombre_completo), '\s+');
      v_nombre := nombre_split[1];
      v_apellido := array_to_string(nombre_split[2:array_length(nombre_split,1)], ' ');
      if v_apellido is null or v_apellido = '' then v_apellido := v_nombre; end if;

      insert into jugadores (nombre, apellido, categoria, puntos_ranking, activo)
      values (initcap(v_nombre), initcap(v_apellido), fila.categoria, fila.puntos, true)
      returning id into v_jugador_id;

      insert into ranking_categoria (jugador_id, categoria, puntos_ranking)
      values (v_jugador_id, fila.categoria, fila.puntos)
      on conflict (jugador_id, categoria) do update set puntos_ranking = excluded.puntos_ranking, updated_at = now();

      insert into _import_ranking_log (nombre_completo, categoria, puntos, accion, jugador_id)
      values (fila.nombre_completo, fila.categoria, fila.puntos, 'creado', v_jugador_id);

    elsif array_length(candidatos, 1) = 1 then
      v_jugador_id := candidatos[1];

      insert into ranking_categoria (jugador_id, categoria, puntos_ranking)
      values (v_jugador_id, fila.categoria, fila.puntos)
      on conflict (jugador_id, categoria) do update set puntos_ranking = excluded.puntos_ranking, updated_at = now();

      insert into _import_ranking_log (nombre_completo, categoria, puntos, accion, jugador_id)
      values (fila.nombre_completo, fila.categoria, fila.puntos, 'actualizado', v_jugador_id);

    else
      -- más de un jugador con ese nombre: no se toca nada, queda para revisión manual
      insert into _import_ranking_log (nombre_completo, categoria, puntos, accion, jugador_id)
      values (fila.nombre_completo, fila.categoria, fila.puntos, 'ambiguo', null);
    end if;
  end loop;
end $$;

drop table _import_ranking_stage;

-- resumen rápido al terminar
select accion, count(*) from _import_ranking_log group by accion order by accion;
