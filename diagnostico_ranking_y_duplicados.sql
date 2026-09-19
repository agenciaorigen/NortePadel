-- ============================================================
-- DIAGNÓSTICO (solo lectura, no modifica nada):
-- 1) ¿se actualizó el ranking cuando se cambió un jugador de una pareja?
-- 2) ¿hay jugadores duplicados para unificar?
--
-- Cómo funciona hoy el cambio de jugador (btnCambiarJugadorPareja, en
-- "Inscripciones y parejas"): SOLO hace
--   update parejas set jugador1_id/jugador2_id = <nuevo> where id = <pareja>
-- No toca partidos, no toca jugadores.puntos_ranking, no toca
-- ranking_categoria. El trigger que suma puntos (actualizar_ranking, en
-- schema.sql) se dispara al cargar CADA resultado y en ese momento busca
-- quiénes son los 2 jugadores de la pareja ganadora/perdedora leyendo la
-- tabla "parejas" TAL COMO ESTÁ EN ESE INSTANTE. Es decir: los puntos
-- siempre quedan a nombre de quien estaba anotado en la pareja el día que
-- se cargó ESE resultado puntual, no de quien esté anotado ahora.
--
-- Consecuencia: si el cambio de jugador se hizo DESPUÉS de haber cargado
-- ya el resultado de algún partido de esa pareja, los puntos de ESE
-- partido quedaron a nombre del jugador viejo, y el jugador nuevo no
-- recibió nada por ese partido puntual (si juega partidos nuevos después
-- del cambio, esos sí se le suman bien). Si el cambio se hizo ANTES de
-- cargar cualquier resultado, no hay ningún problema.
--
-- La parte 1 de abajo detecta esto automáticamente para TODO el
-- historial, usando la tabla "notificaciones": cada vez que se carga un
-- resultado, el mismo trigger le manda una notificación a los 4
-- jugadores que en ESE momento estaban en las 2 parejas. Comparando esa
-- foto vieja contra la composición actual de la pareja, se puede ver
-- exactamente en qué partidos hubo un cambio posterior.
-- ============================================================

create extension if not exists "unaccent";
create extension if not exists "pg_trgm";

-- ------------------------------------------------------------
-- PARTE 0 — de referencia: qué columnas tiene "torneos" en esta base.
-- (La primera versión de este script asumía una columna torneos.puntos_ronda
-- que en tu base no existe con ese nombre/tabla — esta consulta es solo
-- para confirmar dónde vive el puntaje por ronda; el resto del script ya
-- no depende de que exista, así que podés ignorarla si no te interesa.)
-- ------------------------------------------------------------
select column_name, data_type
from information_schema.columns
where table_name = 'torneos'
order by ordinal_position;

-- ------------------------------------------------------------
-- PARTE 1a — caso puntual: Facundo Vera / Facu Loprette
-- Perfil actual, parejas donde figuran hoy, y sus partidos.
-- ------------------------------------------------------------
select id, nombre, apellido, categoria, email, telefono,
       puntos_ranking, partidos_jugados, partidos_ganados, created_at
from jugadores
where unaccent(lower(nombre || ' ' || apellido)) like '%facu%vera%'
   or unaccent(lower(nombre || ' ' || apellido)) like '%facu%loprette%'
order by apellido, nombre;

-- ------------------------------------------------------------
-- PARTE 1b — diagnóstico general: partidos ya jugados donde la pareja
-- cambió de integrante DESPUÉS de haberse cargado ese resultado puntual.
-- Cada fila es "un jugador afectado en un partido puntual":
--   - "TIENE PUNTOS DE MÁS": estaba en la pareja cuando se cargó el
--     resultado (se le sumaron los puntos) pero ya no está en la pareja.
--   - "LE FALTAN PUNTOS": está en la pareja ahora pero no estaba cuando
--     se cargó ese resultado (no se le sumó nada de ese partido).
-- Se incluyen los puntos de esa ronda (según torneos.puntos_ronda) para
-- saber cuánto mover manualmente.
-- ------------------------------------------------------------
with ultima_notif as (
  select partido_id, max(created_at) as t
  from notificaciones
  where partido_id is not null
  group by partido_id
),
notif_batch as (
  select n.partido_id, n.jugador_id
  from notificaciones n
  join ultima_notif u on u.partido_id = n.partido_id and u.t = n.created_at
),
actuales as (
  select p.id as partido_id, x as jugador_id
  from partidos p
  join parejas pa1 on pa1.id = p.pareja1_id
  join parejas pa2 on pa2.id = p.pareja2_id
  cross join lateral unnest(array[pa1.jugador1_id, pa1.jugador2_id, pa2.jugador1_id, pa2.jugador2_id]) as x
),
diff_viejos as (
  select nb.partido_id, nb.jugador_id
  from notif_batch nb
  where not exists (select 1 from actuales a where a.partido_id = nb.partido_id and a.jugador_id = nb.jugador_id)
),
diff_nuevos as (
  select a.partido_id, a.jugador_id
  from actuales a
  where not exists (select 1 from notif_batch nb where nb.partido_id = a.partido_id and nb.jugador_id = a.jugador_id)
)
-- nota: "puntos_ronda" se lee así -- (to_jsonb(tor)->>'puntos_ronda')::jsonb --
-- en vez de tor.puntos_ronda directo, para que la consulta no reviente si esa
-- columna todavía no existe en esta base (algunas instalaciones la tienen
-- global en otra tabla en vez de por-torneo); si no existe, estas dos
-- columnas de puntos quedan en null pero el resto del diagnóstico igual sirve.
select
  tor.nombre as torneo,
  p.categoria,
  p.ronda,
  p.horario,
  j.nombre || ' ' || j.apellido as jugador,
  'TIENE PUNTOS DE MÁS (ya no está en esta pareja)' as situacion,
  coalesce((((to_jsonb(tor)->>'puntos_ronda')::jsonb)->> (case when p.ronda = 'Final' then 'Campeón' else p.ronda end))::int, null) as pts_si_esa_pareja_ganó,
  coalesce((((to_jsonb(tor)->>'puntos_ronda')::jsonb)->> (case when p.ronda = 'Final' then 'Sub' else p.ronda end))::int, null) as pts_si_esa_pareja_perdió,
  p.id as partido_id
from diff_viejos d
join partidos p on p.id = d.partido_id
join torneos tor on tor.id = p.torneo_id
join jugadores j on j.id = d.jugador_id
where p.estado = 'jugado' and p.ganador_pareja_id is not null
union all
select
  tor.nombre, p.categoria, p.ronda, p.horario,
  j.nombre || ' ' || j.apellido,
  'LE FALTAN PUNTOS (no estaba cuando se cargó este resultado)',
  coalesce((((to_jsonb(tor)->>'puntos_ronda')::jsonb)->> (case when p.ronda = 'Final' then 'Campeón' else p.ronda end))::int, null),
  coalesce((((to_jsonb(tor)->>'puntos_ronda')::jsonb)->> (case when p.ronda = 'Final' then 'Sub' else p.ronda end))::int, null),
  p.id
from diff_nuevos d
join partidos p on p.id = d.partido_id
join torneos tor on tor.id = p.torneo_id
join jugadores j on j.id = d.jugador_id
where p.estado = 'jugado' and p.ganador_pareja_id is not null
order by horario desc nulls last, torneo, jugador;

-- Si esta consulta viene vacía: el ranking está bien, no hubo ningún
-- cambio de jugador hecho DESPUÉS de cargar un resultado (el problema con
-- Facundo Vera / Facu Loprette sería entonces el de la Parte 2: un
-- perfil duplicado, no un problema de timing del cambio).

-- ------------------------------------------------------------
-- PARTE 2a — duplicados "seguros": mismo nombre y apellido normalizados
-- (sin mayúsculas/acentos/espacios de más).
-- ------------------------------------------------------------
select
  unaccent(lower(trim(nombre) || ' ' || trim(apellido))) as nombre_normalizado,
  array_agg(id order by created_at) as ids,
  array_agg(categoria order by created_at) as categorias,
  array_agg(puntos_ranking order by created_at) as puntos_ranking,
  array_agg(coalesce(email, '(sin email)') order by created_at) as emails,
  array_agg(created_at order by created_at) as creados
from jugadores
group by 1
having count(*) > 1
order by 1;

-- ------------------------------------------------------------
-- PARTE 2b — duplicados "probables": mismo apellido + nombres parecidos
-- (agarra apodos tipo "Facu" / "Facundo") o mismo teléfono.
-- ------------------------------------------------------------
select
  a.id as id_1, a.nombre || ' ' || a.apellido as jugador_1, a.categoria as categoria_1, a.puntos_ranking as puntos_1,
  b.id as id_2, b.nombre || ' ' || b.apellido as jugador_2, b.categoria as categoria_2, b.puntos_ranking as puntos_2,
  'mismo apellido, nombre parecido' as motivo
from jugadores a
join jugadores b on b.id > a.id
  and unaccent(lower(trim(a.apellido))) = unaccent(lower(trim(b.apellido)))
  and a.id <> b.id
  and (
    unaccent(lower(trim(a.nombre))) like unaccent(lower(trim(b.nombre))) || '%'
    or unaccent(lower(trim(b.nombre))) like unaccent(lower(trim(a.nombre))) || '%'
    or similarity(unaccent(lower(trim(a.nombre))), unaccent(lower(trim(b.nombre)))) > 0.4
  )
union
select
  a.id, a.nombre || ' ' || a.apellido, a.categoria, a.puntos_ranking,
  b.id, b.nombre || ' ' || b.apellido, b.categoria, b.puntos_ranking,
  'mismo teléfono'
from jugadores a
join jugadores b on b.id > a.id
  and a.telefono is not null and btrim(a.telefono) <> ''
  and regexp_replace(a.telefono, '\D', '', 'g') = regexp_replace(b.telefono, '\D', '', 'g')
order by jugador_1;

-- Nota sobre unificar: no hay ninguna herramienta en la app para "fusionar"
-- dos perfiles todavía — jugador_id se referencia desde parejas,
-- inscripciones, partidos (vía parejas), ranking_categoria y
-- notificaciones. Unificar a mano implicaría decidir cuál id se
-- conserva y re-apuntar todo eso al ganador antes de desactivar/borrar
-- el duplicado; mejor no automatizarlo a ciegas — conviene revisar caso
-- por caso lo que devuelva esta consulta y avisar antes de armar un
-- script de fusión.
