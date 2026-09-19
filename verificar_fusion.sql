-- ============================================================
-- Verificación de solo lectura de la fusión Facu Vera -> Facundo Vera.
-- Corré los 3 bloques y pasame lo que te devuelva cada uno.
-- ============================================================

-- 1) El perfil "Facu Vera" (el que se tenía que borrar) ya no debería
--    existir. Si esto devuelve 0 filas, la fusión se hizo.
select id, nombre, apellido, categoria, puntos_ranking
from jugadores
where id = 'ba851067-602d-4471-8c49-75e8e357379e';

-- 2) El perfil "Facundo Vera" (el que quedó) — puntos_ranking y
--    partidos deberían ser la SUMA de lo que tenía cada uno antes
--    (Facundo tenía 2250 + Facu tenía 625 = 2875, si no jugó nada nuevo
--    en el medio).
select id, nombre, apellido, categoria, puntos_ranking, partidos_jugados, partidos_ganados
from jugadores
where id = 'bdd2a705-b964-4d8d-89cd-63d3536a1f12';

-- 3) No debería quedar NADA en ninguna tabla apuntando todavía al id
--    viejo (ba851067...). Las 4 columnas de "filas" de abajo tienen que
--    dar todas en 0.
select
  (select count(*) from parejas where jugador1_id = 'ba851067-602d-4471-8c49-75e8e357379e' or jugador2_id = 'ba851067-602d-4471-8c49-75e8e357379e') as parejas_con_id_viejo,
  (select count(*) from inscripciones where jugador_id = 'ba851067-602d-4471-8c49-75e8e357379e') as inscripciones_con_id_viejo,
  (select count(*) from ranking_categoria where jugador_id = 'ba851067-602d-4471-8c49-75e8e357379e') as ranking_categoria_con_id_viejo,
  (select count(*) from notificaciones where jugador_id = 'ba851067-602d-4471-8c49-75e8e357379e') as notificaciones_con_id_viejo;
