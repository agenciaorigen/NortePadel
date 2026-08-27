-- ============================================================
-- NORTE PADEL - Esquema de base de datos (Supabase / Postgres)
-- Pegar y ejecutar completo en: Supabase > SQL Editor > New query
-- ============================================================

-- Extensión para UUIDs
create extension if not exists "pgcrypto";

-- ---------- COMPLEJOS ----------
create table if not exists complejos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  direccion text,
  created_at timestamptz not null default now()
);

-- ---------- CANCHAS ----------
create table if not exists canchas (
  id uuid primary key default gen_random_uuid(),
  complejo_id uuid not null references complejos(id) on delete cascade,
  nombre text not null,
  tipo text default 'cristal', -- cristal, muro, indoor, etc
  activa boolean not null default true,
  created_at timestamptz not null default now()
);
alter table canchas add column if not exists costo_hora numeric; -- precio de alquiler por hora (opcional, para "Jugar" / reservar cancha)

-- ---------- JUGADORES ----------
create table if not exists jugadores (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  nombre text not null,
  apellido text not null,
  email text unique,
  telefono text,
  nivel text default 'intermedio', -- principiante, intermedio, avanzado
  categoria text not null default '6ta', -- categoría de competencia (6ta, 5ta, 4ta, Damas, etc.)
  lado_preferido text, -- drive, reves, indistinto
  puntos_ranking numeric(10,1) not null default 0, -- decimal por los "ascenso" del circuito histórico (mitad de puntos)
  partidos_jugados int not null default 0,
  partidos_ganados int not null default 0,
  activo boolean not null default true,
  debe_cambiar_clave boolean not null default false, -- true para cuentas importadas con clave provisoria
  foto_url text, -- foto de perfil, la sube cada jugador desde "Mi perfil"
  created_at timestamptz not null default now()
);

-- por si la tabla ya existía de una instalación anterior sin estas columnas
alter table jugadores add column if not exists categoria text not null default '6ta';
alter table jugadores add column if not exists auth_user_id uuid unique references auth.users(id) on delete cascade;
alter table jugadores add column if not exists debe_cambiar_clave boolean not null default false;
alter table jugadores add column if not exists foto_url text;
alter table jugadores add column if not exists categoria_pendiente text; -- categoría que el jugador pidió, a la espera de que el admin la apruebe
-- por si la tabla venía con puntos_ranking como entero, de la importación histórica con medios puntos por ascenso
-- (hay que tirar la vista que depende de la columna antes de poder cambiarle el tipo; se vuelve a crear más abajo)
drop view if exists vista_ranking;
alter table jugadores alter column puntos_ranking type numeric(10,1) using puntos_ranking::numeric(10,1);
alter table jugadores alter column puntos_ranking set default 0;

-- ---------- RANKING POR CATEGORÍA (un jugador puede estar anotado y sumar puntos en más de una categoría a la vez) ----------
-- jugadores.categoria/puntos_ranking siguen siendo la "categoría principal" (perfil, alta de
-- jugador, inscripción por defecto) y no se tocan. Esta tabla es la que permite que la MISMA
-- persona tenga una fila de ranking en 2+ categorías simultáneamente (ej: juega 4ta y 5ta) —
-- cada fila es independiente y el admin puede agregar/editar/borrar las que haga falta.
create table if not exists ranking_categoria (
  jugador_id uuid not null references jugadores(id) on delete cascade,
  categoria text not null,
  puntos_ranking numeric(10,1) not null default 0,
  partidos_jugados int not null default 0,
  partidos_ganados int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (jugador_id, categoria)
);

-- alta inicial: cada jugador arranca con su categoría principal ya como una fila de ranking_categoria
-- (idempotente — no pisa nada si ya se corrió antes o si el admin ya cargó categorías extra)
insert into ranking_categoria (jugador_id, categoria, puntos_ranking, partidos_jugados, partidos_ganados)
select id, categoria, puntos_ranking, partidos_jugados, partidos_ganados from jugadores
on conflict (jugador_id, categoria) do nothing;

create index if not exists idx_ranking_categoria_categoria on ranking_categoria(categoria);

-- ---------- RESERVAS (jugar/entrenar con amigos, día a día, fuera del circuito de torneos) ----------
create table if not exists reservas (
  id uuid primary key default gen_random_uuid(),
  cancha_id uuid not null references canchas(id) on delete cascade,
  organizador_id uuid not null references jugadores(id) on delete cascade,
  horario timestamptz not null,
  duracion_minutos int not null default 90,
  costo numeric, -- foto del costo_hora de la cancha al reservar, para que un cambio de precio no altere reservas ya hechas
  estado text not null default 'pendiente', -- pendiente, confirmada, rechazada, cancelada
  created_at timestamptz not null default now()
);

create table if not exists reserva_invitados (
  id uuid primary key default gen_random_uuid(),
  reserva_id uuid not null references reservas(id) on delete cascade,
  jugador_id uuid not null references jugadores(id) on delete cascade,
  unique (reserva_id, jugador_id)
);

-- ---------- CATEGORIAS ----------
-- Lista editable de categorías (6ta, 5ta, Suma12, etc.) que usan tanto
-- el perfil de jugador como la creación de torneos. El admin la administra
-- desde el panel de administrador (agregar / borrar categorías).
create table if not exists categorias (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  orden int not null default 0,
  created_at timestamptz not null default now()
);

-- Categorías reales del circuito: Damas y Caballeros son escalafones separados
-- (una "6ta Damas" y una "6ta Caballeros" son grupos de jugadores distintos).
-- Se dejan también las genéricas viejas (no se borran, por si algún torneo ya las usa).
insert into categorias (nombre, orden) values
  ('8va Damas', 1), ('7ma Damas', 2), ('6ta Damas', 3), ('5ta Damas', 4), ('4ta Damas', 5),
  ('8va Caballeros', 10), ('7ma Caballeros', 11), ('6ta Caballeros', 12), ('5ta Caballeros', 13),
  ('4ta Caballeros', 14), ('3ra Caballeros', 15),
  ('8va', 20), ('7ma', 21), ('6ta', 22), ('5ta', 23), ('4ta', 24),
  ('3ra', 25), ('2da', 26), ('1ra', 27), ('Damas', 28)
on conflict (nombre) do nothing;

-- ---------- ETIQUETAS DE JUGADOR (uso interno del admin) ----------
-- Etiquetas libres con color (ej: "Veterano") para que el admin las use como ayuda
-- visual al acomodar horarios/partidos — a diferencia de "categorias", NO son
-- públicas: nada de esto se muestra a los jugadores ni en las vistas públicas.
create table if not exists etiquetas_jugador (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  color text not null default '#6a3dff',
  orden int not null default 0,
  created_at timestamptz not null default now()
);

-- por si la tabla ya existía de una instalación anterior
alter table jugadores add column if not exists etiqueta_id uuid references etiquetas_jugador(id) on delete set null;

-- ---------- ADMINISTRADORES ----------
-- Quienes pueden crear torneos, complejos, cargar resultados, etc.
-- Para convertir a alguien en admin: que primero se registre normal en la app
-- (Mi perfil > crear cuenta) y después correr, con su email real:
--   insert into admins (user_id) select id from auth.users where email = 'tu-email@ejemplo.com';
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

-- un jugador no puede cambiar su propia categoría oficial ni sus puntos de ranking directo
-- (la categoría solo puede dejarla pedida en categoria_pendiente); si intenta escribirlos igual, se ignora.
-- el admin sí puede escribir ambos libremente (para aprobar pedidos, corregir errores o cargar
-- puntos a mano en casos puntuales).
create or replace function proteger_categoria_jugador() returns trigger as $$
begin
  if not is_admin() and new.categoria is distinct from old.categoria then
    new.categoria := old.categoria;
  end if;
  if not is_admin() and new.puntos_ranking is distinct from old.puntos_ranking then
    new.puntos_ranking := old.puntos_ranking;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_proteger_categoria on jugadores;
create trigger trg_proteger_categoria
before update on jugadores
for each row execute function proteger_categoria_jugador();

-- ---------- JUGADOR DEL MES ----------
create table if not exists jugador_del_mes (
  id uuid primary key default gen_random_uuid(),
  jugador_id uuid not null references jugadores(id) on delete cascade,
  motivo text,
  created_at timestamptz not null default now()
);

-- ---------- HORARIOS BLOQUEADOS DEL JUGADOR ----------
-- OJO: el nombre de la tabla quedó de una versión anterior, en la que cada fila
-- era un horario en el que el jugador SÍ podía jugar. Ahora es al revés: cada
-- fila es un horario en el que NO puede (bloqueado) — quien no cargó ninguna
-- fila para un día se asume disponible todo ese día. dia_semana: 0=domingo ... 6=sábado.
-- torneo_id null = bloqueo general del perfil (aplica siempre); con torneo_id
-- cargado, es un bloqueo puntual para ESE torneo nada más (además del general).
create table if not exists disponibilidad (
  id uuid primary key default gen_random_uuid(),
  jugador_id uuid not null references jugadores(id) on delete cascade,
  dia_semana int not null check (dia_semana between 0 and 6),
  hora_desde time not null,
  hora_hasta time not null,
  created_at timestamptz not null default now()
);

-- ---------- TORNEOS ----------
create table if not exists torneos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  complejo_id uuid references complejos(id) on delete set null,
  categoria text default 'abierta',
  fecha_inicio date not null,
  fecha_fin date,
  estado text not null default 'inscripcion', -- inscripcion, inscripcion_cerrada, en_curso, finalizado, cancelado
  puntos_primero int not null default 100,
  puntos_segundo int not null default 60,
  puntos_participacion int not null default 10,
  flyer_url text,
  costo numeric,
  created_at timestamptz not null default now()
);

alter table torneos add column if not exists flyer_url text;
alter table torneos add column if not exists costo numeric;
alter table torneos add column if not exists duracion_minutos int not null default 90;
alter table torneos add column if not exists dias_semana int[]; -- días de semana permitidos (0=domingo..6=sábado); null = todos los días del rango
alter table torneos add column if not exists hora_desde time; -- horario del día desde el que se puede programar (opcional)
alter table torneos add column if not exists hora_hasta time; -- horario del día hasta el que se puede programar (opcional)
-- horario propio por día de la semana, para torneos que juegan en franjas distintas
-- cada día (ej: viernes de noche, sábado y domingo desde la mañana). Formato
-- {"5": {"desde":"18:00","hasta":"23:00"}, ...}, clave = mismo número que dias_semana.
-- Un día sin entrada acá usa hora_desde/hora_hasta (el horario "por defecto"). Null =
-- todos los días usan el horario por defecto, como siempre.
alter table torneos add column if not exists horarios_por_dia jsonb;
-- formato de la fase de grupos: 'grupos' = todos contra todos en grupos chicos,
-- nadie queda eliminado en esta etapa (cada pareja juega tamano_grupo-1 partidos);
-- 'eliminacion' = 1 solo partido, el que pierde queda afuera directo;
-- 'cuadro_zonas' = el formato propio del club (ver PLANTILLAS_CUADRO en
-- matching.js): zonas de 2 parejas armadas por ranking, con una "segunda
-- chance" cruzada para el que pierde su primer partido antes de pasar a
-- eliminación directa.
alter table torneos add column if not exists fase_grupos_formato text not null default 'grupos';
alter table torneos add column if not exists tamano_grupo int not null default 3; -- parejas por grupo (solo aplica si fase_grupos_formato='grupos')
alter table torneos add column if not exists avanzan_por_grupo int not null default 2; -- cuántas parejas de cada grupo pasan a la siguiente fase

-- torneo_id null = bloqueo general del perfil (aplica siempre); con torneo_id
-- cargado, es un bloqueo puntual para ESE torneo nada más (además del general).
-- va acá (no junto a la tabla) porque necesita que "torneos" ya exista.
alter table disponibilidad add column if not exists torneo_id uuid references torneos(id) on delete cascade;

-- Canchas habilitadas para cada torneo (permite reasignar por clima u otro motivo)
create table if not exists torneo_canchas (
  id uuid primary key default gen_random_uuid(),
  torneo_id uuid not null references torneos(id) on delete cascade,
  cancha_id uuid not null references canchas(id) on delete cascade,
  unique (torneo_id, cancha_id)
);
-- días de semana en que ESTA cancha está disponible para ESTE torneo (mismo
-- formato que torneos.dias_semana: 0=domingo..6=sábado). Null o vacío = todos
-- los días del torneo, como siempre — solo hace falta cargarlo cuando el club
-- tiene distinta cantidad de canchas según el día (ej: jueves y viernes menos
-- canchas que sábado y domingo).
alter table torneo_canchas add column if not exists dias_semana int[];

-- ---------- BLOQUEOS DE CANCHA (funcionalidad nueva) ----------
-- Un bloqueo de cancha es distinto de la disponibilidad de un jugador:
-- la disponibilidad es una preferencia de horario de UN jugador (no impide
-- que otros jueguen ahí); un bloqueo de cancha hace que ESA cancha quede
-- literalmente inutilizable para TODOS en esa ventana (lluvia, mantenimiento,
-- otro evento del club, etc.) — nunca se combinan ni se guardan en la misma
-- tabla, para no confundir ambos conceptos.
create table if not exists canchas_bloqueos (
  id uuid primary key default gen_random_uuid(),
  cancha_id uuid not null references canchas(id) on delete cascade,
  desde timestamptz not null,
  hasta timestamptz not null,
  motivo text,
  created_at timestamptz not null default now(),
  check (hasta > desde)
);
create index if not exists idx_canchas_bloqueos_cancha on canchas_bloqueos(cancha_id, desde, hasta);

-- Categorías que compiten en cada torneo (un torneo puede abarcar varias, ej: de 2da a 8va)
create table if not exists torneo_categorias (
  id uuid primary key default gen_random_uuid(),
  torneo_id uuid not null references torneos(id) on delete cascade,
  categoria text not null,
  unique (torneo_id, categoria)
);
-- fase en la que está ESTA categoría dentro del torneo (cada categoría avanza a su
-- propio ritmo — una puede seguir en fase de grupos mientras otra ya tiene calendario):
--   sin_fixture         -> todavía no se armaron los cruces
--   fixture_generado    -> ya están los cruces (partidos con cancha_id/horario en null)
--   calendario_confirmado -> ya se les asignó cancha y horario
--   finalizada          -> ya se jugó su fase final
-- Es la fuente de verdad para mostrar Calendario/Resultados al público (ver
-- renderTorneoSubnav en app.js) en vez del parche anterior de "hay partidos sí/no",
-- que se rompía apenas existía un fixture todavía sin horario.
alter table torneo_categorias add column if not exists estado_fase text not null default 'sin_fixture';

-- ---------- PAREJAS ----------
create table if not exists parejas (
  id uuid primary key default gen_random_uuid(),
  torneo_id uuid not null references torneos(id) on delete cascade,
  jugador1_id uuid not null references jugadores(id) on delete cascade,
  jugador2_id uuid not null references jugadores(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------- INSCRIPCIONES (jugador -> torneo, con disponibilidad puntual si difiere) ----------
create table if not exists inscripciones (
  id uuid primary key default gen_random_uuid(),
  torneo_id uuid not null references torneos(id) on delete cascade,
  jugador_id uuid not null references jugadores(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (torneo_id, jugador_id)
);
-- categoría en la que juega ESE torneo puntual (un torneo puede abarcar varias, ej "de 2da a 8va")
-- y si el admin ya confirmó el pago/la categoría, o todavía está pendiente de revisión.
-- estado: pendiente, confirmada, rechazada (con motivo), cancelada (el jugador se
-- dio de baja él mismo). rechazada/cancelada NO se borran físicamente — quedan
-- como historial y para que el cupo se libere sin perder el registro de que existió.
alter table inscripciones add column if not exists categoria text;
alter table inscripciones add column if not exists estado text not null default 'pendiente';
alter table inscripciones add column if not exists motivo_rechazo text;

-- ---------- PARTIDOS ----------
create table if not exists partidos (
  id uuid primary key default gen_random_uuid(),
  torneo_id uuid not null references torneos(id) on delete cascade,
  ronda text default 'Fase de grupos',
  categoria text, -- categoría de este partido (un torneo puede tener varias corriendo en paralelo)
  pareja1_id uuid references parejas(id) on delete cascade,
  pareja2_id uuid references parejas(id) on delete cascade,
  cancha_id uuid references canchas(id) on delete set null,
  horario timestamptz,
  estado text not null default 'programado', -- programado, en_juego, jugado, suspendido
  sets jsonb, -- ej: [{"p1":6,"p2":3},{"p1":6,"p2":4}]
  ganador_pareja_id uuid references parejas(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table partidos add column if not exists categoria text;
alter table partidos add column if not exists grupo int; -- número de grupo dentro de la fase de grupos (null = no es de fase de grupos, o es de eliminación directa)
-- Posición de un partido dentro de la plantilla de cuadro del club (ver
-- PLANTILLAS_CUADRO en matching.js), ej: "Z3" (partido de la zona 3), "O2"
-- (octavos, partido 2), "C1", "S1", "F1". Solo se usa cuando el torneo tiene
-- fase_grupos_formato='cuadro_zonas' — permite que al cargar el resultado de
-- un partido, el motor sepa exactamente a qué cruce de la siguiente ronda
-- alimenta (ganador y, si corresponde, perdedor), en vez de tener que
-- adivinarlo por orden de creación.
alter table partidos add column if not exists slot_cuadro text;

-- ---------- FLYERS ----------
create table if not exists flyers (
  id uuid primary key default gen_random_uuid(),
  torneo_id uuid references torneos(id) on delete set null,
  titulo text not null,
  url text not null,
  created_at timestamptz not null default now()
);

-- ---------- SPONSORS / PUBLICIDAD ----------
-- torneo_id null = auspiciante general (aparece en Inicio, la columna lateral
-- y en todos los torneos). Con torneo_id cargado, aparece solo en ese torneo.
create table if not exists sponsors (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  logo_url text not null,
  link_url text,
  torneo_id uuid references torneos(id) on delete cascade,
  orden int not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

alter table sponsors add column if not exists torneo_id uuid references torneos(id) on delete cascade;

-- ---------- CONFIGURACIÓN GENERAL (clave/valor, para no tener que migrar cada vez que se suma un dato global) ----------
-- claves usadas hoy: 'whatsapp_numero' (código de país + número, solo dígitos, ej: 595981234567),
-- 'instagram_url' (link al perfil, ej: https://instagram.com/nortepadel)
create table if not exists config (
  clave text primary key,
  valor text
);

-- valores del club (si ya los cambiaste desde "Configuración general", correr esto
-- de nuevo no los pisa: "on conflict do nothing")
insert into config (clave, valor) values
  ('whatsapp_numero', '5493757507816'),
  ('instagram_url', 'https://www.instagram.com/encuentrosdepadeliguazu/')
on conflict (clave) do nothing;

-- ---------- NOTICIAS (novedades del club en Inicio; se cargan a mano, como los flyers) ----------
create table if not exists noticias (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  texto text,
  imagen_url text,
  link text,
  created_at timestamptz not null default now()
);

-- ---------- SUSCRIPCIONES A NOTIFICACIONES PUSH ----------
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  jugador_id uuid not null references jugadores(id) on delete cascade,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------- NOTIFICACIONES (bandeja in-app, respaldo del push) ----------
create table if not exists notificaciones (
  id uuid primary key default gen_random_uuid(),
  jugador_id uuid not null references jugadores(id) on delete cascade,
  mensaje text not null,
  leido boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- PUNTOS POR RONDA (ranking por eliminación directa) ----------
-- Cuando se carga el resultado de un partido de Semifinal/Cuartos/Octavos/Dieciseisavos,
-- la pareja PERDEDORA suma los puntos de esa ronda (llegó hasta ahí y quedó eliminada).
-- En la Final, el ganador suma "Campeón" y el perdedor suma "Sub". Los partidos que no son
-- de una de estas rondas (ej: fase de grupos) no suman puntos de ranking, solo estadísticas
-- de partidos jugados/ganados. El admin puede editar estos valores desde el panel de admin.
create table if not exists puntos_ronda (
  ronda text primary key,
  puntos int not null
);

insert into puntos_ronda (ronda, puntos) values
  ('Campeón', 1000), ('Sub', 750), ('Semifinal', 500),
  ('Cuartos', 250), ('Octavos', 125), ('Dieciseisavos', 100)
on conflict (ronda) do nothing;

-- ---------- HISTORIAL DE CATEGORÍA (para mostrar "ascendidos" en Inicio) ----------
-- Se carga una fila cada vez que el admin aprueba un pedido de cambio de categoría
-- (ver "Solicitudes de categoría"). No hace falta guardar si fue ascenso o descenso:
-- eso se calcula al leer, comparando el "orden" de las dos categorías.
create table if not exists historial_categoria (
  id uuid primary key default gen_random_uuid(),
  jugador_id uuid not null references jugadores(id) on delete cascade,
  categoria_anterior text,
  categoria_nueva text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ÍNDICES (velocidad)
-- Postgres indexa automáticamente las primary key y las columnas unique,
-- pero NO las foreign key ni las columnas por las que se filtra seguido
-- (categoría, estado, etc.) — sin esto, cada pantalla hace una recorrida
-- completa de la tabla a medida que crece la cantidad de jugadores/partidos.
-- ============================================================
create index if not exists idx_canchas_complejo on canchas(complejo_id);
create index if not exists idx_jugadores_categoria on jugadores(categoria);
create index if not exists idx_jugadores_activo on jugadores(activo);
create index if not exists idx_jugador_del_mes_jugador on jugador_del_mes(jugador_id);
create index if not exists idx_disponibilidad_jugador on disponibilidad(jugador_id);
create index if not exists idx_disponibilidad_torneo on disponibilidad(torneo_id);
create index if not exists idx_torneos_complejo on torneos(complejo_id);
create index if not exists idx_torneo_canchas_torneo on torneo_canchas(torneo_id);
create index if not exists idx_torneo_categorias_torneo on torneo_categorias(torneo_id);
create index if not exists idx_parejas_torneo on parejas(torneo_id);
create index if not exists idx_parejas_jugador1 on parejas(jugador1_id);
create index if not exists idx_parejas_jugador2 on parejas(jugador2_id);
create index if not exists idx_inscripciones_torneo on inscripciones(torneo_id);
create index if not exists idx_inscripciones_jugador on inscripciones(jugador_id);
create index if not exists idx_partidos_torneo on partidos(torneo_id);
create index if not exists idx_partidos_pareja1 on partidos(pareja1_id);
create index if not exists idx_partidos_pareja2 on partidos(pareja2_id);
create index if not exists idx_partidos_ganador_pareja on partidos(ganador_pareja_id);
create index if not exists idx_partidos_estado on partidos(estado);
create index if not exists idx_flyers_torneo on flyers(torneo_id);
create index if not exists idx_sponsors_torneo on sponsors(torneo_id);
create index if not exists idx_push_subscriptions_jugador on push_subscriptions(jugador_id);
create index if not exists idx_notificaciones_jugador on notificaciones(jugador_id);
create index if not exists idx_historial_categoria_jugador on historial_categoria(jugador_id);
create index if not exists idx_historial_categoria_fecha on historial_categoria(created_at);
create index if not exists idx_noticias_fecha on noticias(created_at);

-- ============================================================
-- TRIGGER: al cargar resultado de un partido, sumar puntos de ranking
-- ============================================================
create or replace function actualizar_ranking() returns trigger as $$
declare
  ganador parejas%rowtype;
  perdedor_id uuid;
  perdedor parejas%rowtype;
  pts_ganador int := 0;
  pts_perdedor int := 0;
  es_correccion boolean;
  old_ganador parejas%rowtype;
  old_perdedor_id uuid;
  old_perdedor parejas%rowtype;
  old_pts_ganador int := 0;
  old_pts_perdedor int := 0;
begin
  -- solo actuar cuando el partido pasa a "jugado" y tiene ganador
  if new.estado = 'jugado' and new.ganador_pareja_id is not null
     and (old.estado is distinct from 'jugado' or old.ganador_pareja_id is distinct from new.ganador_pareja_id) then

    -- si el partido YA estaba jugado con otro ganador, es una corrección de
    -- un resultado que ya había sumado puntos: hay que revertir exactamente
    -- lo que se le dio al ganador/perdedor viejo ANTES de sumar el nuevo,
    -- para no dejar el ranking inflado con cada corrección (bug detectado:
    -- antes de este fix, una corrección solo sumaba y nunca restaba).
    es_correccion := old.estado = 'jugado' and old.ganador_pareja_id is not null
                      and old.ganador_pareja_id is distinct from new.ganador_pareja_id;

    if es_correccion then
      select * into old_ganador from parejas where id = old.ganador_pareja_id;
      old_perdedor_id := case when old.pareja1_id = old.ganador_pareja_id then old.pareja2_id else old.pareja1_id end;
      select * into old_perdedor from parejas where id = old_perdedor_id;

      if old.ronda = 'Final' then
        select puntos into old_pts_ganador from puntos_ronda where ronda = 'Campeón';
        select puntos into old_pts_perdedor from puntos_ronda where ronda = 'Sub';
      elsif old.ronda in ('Semifinal', 'Cuartos', 'Octavos', 'Dieciseisavos') then
        select puntos into old_pts_perdedor from puntos_ronda where ronda = old.ronda;
      end if;

      update jugadores set
        puntos_ranking = puntos_ranking - coalesce(old_pts_ganador, 0),
        partidos_jugados = partidos_jugados - 1,
        partidos_ganados = partidos_ganados - 1
      where id in (old_ganador.jugador1_id, old_ganador.jugador2_id);

      if old.categoria is not null then
        update ranking_categoria set
          puntos_ranking = puntos_ranking - coalesce(old_pts_ganador, 0),
          partidos_jugados = partidos_jugados - 1,
          partidos_ganados = partidos_ganados - 1,
          updated_at = now()
        where categoria = old.categoria and jugador_id in (old_ganador.jugador1_id, old_ganador.jugador2_id);
      end if;

      if old_perdedor.id is not null then
        update jugadores set
          puntos_ranking = puntos_ranking - coalesce(old_pts_perdedor, 0),
          partidos_jugados = partidos_jugados - 1
        where id in (old_perdedor.jugador1_id, old_perdedor.jugador2_id);

        if old.categoria is not null then
          update ranking_categoria set
            puntos_ranking = puntos_ranking - coalesce(old_pts_perdedor, 0),
            partidos_jugados = partidos_jugados - 1,
            updated_at = now()
          where categoria = old.categoria and jugador_id in (old_perdedor.jugador1_id, old_perdedor.jugador2_id);
        end if;
      end if;
    end if;

    select * into ganador from parejas where id = new.ganador_pareja_id;

    perdedor_id := case when new.pareja1_id = new.ganador_pareja_id then new.pareja2_id else new.pareja1_id end;
    select * into perdedor from parejas where id = perdedor_id;

    -- puntos según la ronda: en la Final, ganador = Campeón y perdedor = Sub;
    -- en las demás rondas de bracket, solo el perdedor suma (quedó eliminado ahí)
    if new.ronda = 'Final' then
      select puntos into pts_ganador from puntos_ronda where ronda = 'Campeón';
      select puntos into pts_perdedor from puntos_ronda where ronda = 'Sub';
    elsif new.ronda in ('Semifinal', 'Cuartos', 'Octavos', 'Dieciseisavos') then
      select puntos into pts_perdedor from puntos_ronda where ronda = new.ronda;
    end if;

    -- puntos + partido jugado + partido ganado para la pareja ganadora
    update jugadores set
      puntos_ranking = puntos_ranking + coalesce(pts_ganador, 0),
      partidos_jugados = partidos_jugados + 1,
      partidos_ganados = partidos_ganados + 1
    where id in (ganador.jugador1_id, ganador.jugador2_id);

    -- mismo resultado, pero en la categoría del partido dentro de ranking_categoria: así un
    -- jugador que compite en más de una categoría a la vez suma en la que corresponde, sin
    -- perder lo que ya tenía en las demás. Si todavía no tenía fila en esa categoría (recién
    -- arranca a jugarla), se crea sola.
    if new.categoria is not null then
      insert into ranking_categoria (jugador_id, categoria, puntos_ranking, partidos_jugados, partidos_ganados)
      select j, new.categoria, coalesce(pts_ganador, 0), 1, 1
      from unnest(array[ganador.jugador1_id, ganador.jugador2_id]) as j
      where j is not null
      on conflict (jugador_id, categoria) do update set
        puntos_ranking = ranking_categoria.puntos_ranking + excluded.puntos_ranking,
        partidos_jugados = ranking_categoria.partidos_jugados + 1,
        partidos_ganados = ranking_categoria.partidos_ganados + 1,
        updated_at = now();
    end if;

    -- puntos + partido jugado para la pareja perdedora
    if perdedor.id is not null then
      update jugadores set
        puntos_ranking = puntos_ranking + coalesce(pts_perdedor, 0),
        partidos_jugados = partidos_jugados + 1
      where id in (perdedor.jugador1_id, perdedor.jugador2_id);

      if new.categoria is not null then
        insert into ranking_categoria (jugador_id, categoria, puntos_ranking, partidos_jugados, partidos_ganados)
        select j, new.categoria, coalesce(pts_perdedor, 0), 1, 0
        from unnest(array[perdedor.jugador1_id, perdedor.jugador2_id]) as j
        where j is not null
        on conflict (jugador_id, categoria) do update set
          puntos_ranking = ranking_categoria.puntos_ranking + excluded.puntos_ranking,
          partidos_jugados = ranking_categoria.partidos_jugados + 1,
          updated_at = now();
      end if;
    end if;

    -- notificación in-app a los 4 jugadores
    insert into notificaciones (jugador_id, mensaje)
    select j, 'Resultado cargado: revisá el partido en Norte Padel'
    from unnest(array[ganador.jugador1_id, ganador.jugador2_id, perdedor.jugador1_id, perdedor.jugador2_id]) as j
    where j is not null;
  end if;

  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_actualizar_ranking on partidos;
create trigger trg_actualizar_ranking
before update on partidos
for each row execute function actualizar_ranking();

-- Si se borra un partido que ya estaba "jugado" (a mano, o en cascada porque
-- se borró el torneo entero: on delete cascade SÍ dispara este trigger, es un
-- delete real fila por fila) hay que revertir los puntos que ya se le habían
-- sumado a esas 4 parejas/jugadores — si no, el ranking queda con puntos de
-- partidos que ya no existen. Misma cuenta que la corrección de resultado de
-- más arriba, aplicada sobre old en vez de new.
create or replace function revertir_ranking_al_borrar_partido() returns trigger as $$
declare
  ganador parejas%rowtype;
  perdedor_id uuid;
  perdedor parejas%rowtype;
  pts_ganador int := 0;
  pts_perdedor int := 0;
begin
  if old.estado = 'jugado' and old.ganador_pareja_id is not null then
    select * into ganador from parejas where id = old.ganador_pareja_id;
    perdedor_id := case when old.pareja1_id = old.ganador_pareja_id then old.pareja2_id else old.pareja1_id end;
    select * into perdedor from parejas where id = perdedor_id;

    if old.ronda = 'Final' then
      select puntos into pts_ganador from puntos_ronda where ronda = 'Campeón';
      select puntos into pts_perdedor from puntos_ronda where ronda = 'Sub';
    elsif old.ronda in ('Semifinal', 'Cuartos', 'Octavos', 'Dieciseisavos') then
      select puntos into pts_perdedor from puntos_ronda where ronda = old.ronda;
    end if;

    if ganador.id is not null then
      update jugadores set
        puntos_ranking = puntos_ranking - coalesce(pts_ganador, 0),
        partidos_jugados = partidos_jugados - 1,
        partidos_ganados = partidos_ganados - 1
      where id in (ganador.jugador1_id, ganador.jugador2_id);

      if old.categoria is not null then
        update ranking_categoria set
          puntos_ranking = puntos_ranking - coalesce(pts_ganador, 0),
          partidos_jugados = partidos_jugados - 1,
          partidos_ganados = partidos_ganados - 1,
          updated_at = now()
        where categoria = old.categoria and jugador_id in (ganador.jugador1_id, ganador.jugador2_id);
      end if;
    end if;

    if perdedor.id is not null then
      update jugadores set
        puntos_ranking = puntos_ranking - coalesce(pts_perdedor, 0),
        partidos_jugados = partidos_jugados - 1
      where id in (perdedor.jugador1_id, perdedor.jugador2_id);

      if old.categoria is not null then
        update ranking_categoria set
          puntos_ranking = puntos_ranking - coalesce(pts_perdedor, 0),
          partidos_jugados = partidos_jugados - 1,
          updated_at = now()
        where categoria = old.categoria and jugador_id in (perdedor.jugador1_id, perdedor.jugador2_id);
      end if;
    end if;
  end if;

  return old;
end;
$$ language plpgsql;

drop trigger if exists trg_revertir_ranking_al_borrar on partidos;
create trigger trg_revertir_ranking_al_borrar
before delete on partidos
for each row execute function revertir_ranking_al_borrar_partido();

-- El de arriba no alcanza solo: "parejas" también tiene "on delete cascade"
-- desde torneos, y esa cascada puede (y en la práctica, sí) borrar la fila de
-- parejas ANTES que la de partidos — para entonces el trigger de arriba ya no
-- puede levantar jugador1_id/jugador2_id porque la pareja ya no existe. Este
-- segundo trigger cubre ese caso mirándolo al revés: antes de borrar UNA
-- pareja, revisa sus propios partidos "jugado" (que a esta altura todavía
-- existen, porque el cascade de partidos recién corre después de este borrado)
-- y revierte lo que esa pareja puntual se llevó en cada uno. Si el otro
-- trigger ya se adelantó (torneo chico donde el orden salió al revés), acá no
-- encuentra partidos para esa pareja y no hace nada — no se duplica la resta
-- pase lo que pase con el orden real de la cascada.
create or replace function revertir_ranking_al_borrar_pareja() returns trigger as $$
declare
  p record;
  gano boolean;
  pts int;
begin
  for p in
    select * from partidos
    where estado = 'jugado' and ganador_pareja_id is not null
      and (pareja1_id = old.id or pareja2_id = old.id)
  loop
    gano := p.ganador_pareja_id = old.id;
    pts := 0;
    if p.ronda = 'Final' then
      select puntos into pts from puntos_ronda where ronda = (case when gano then 'Campeón' else 'Sub' end);
    elsif not gano and p.ronda in ('Semifinal', 'Cuartos', 'Octavos', 'Dieciseisavos') then
      select puntos into pts from puntos_ronda where ronda = p.ronda;
    end if;

    update jugadores set
      puntos_ranking = puntos_ranking - coalesce(pts, 0),
      partidos_jugados = partidos_jugados - 1,
      partidos_ganados = partidos_ganados - (case when gano then 1 else 0 end)
    where id in (old.jugador1_id, old.jugador2_id);

    if p.categoria is not null then
      update ranking_categoria set
        puntos_ranking = puntos_ranking - coalesce(pts, 0),
        partidos_jugados = partidos_jugados - 1,
        partidos_ganados = partidos_ganados - (case when gano then 1 else 0 end),
        updated_at = now()
      where categoria = p.categoria and jugador_id in (old.jugador1_id, old.jugador2_id);
    end if;
  end loop;

  return old;
end;
$$ language plpgsql;

drop trigger if exists trg_revertir_ranking_al_borrar_pareja on parejas;
create trigger trg_revertir_ranking_al_borrar_pareja
before delete on parejas
for each row execute function revertir_ranking_al_borrar_pareja();

-- ============================================================
-- TRIGGER: al asignar horario/cancha a un partido, notificar a los 4 jugadores
-- ============================================================
create or replace function notificar_horario_asignado() returns trigger as $$
declare
  p1 parejas%rowtype;
  p2 parejas%rowtype;
begin
  if new.horario is not null and (old.horario is distinct from new.horario or old.cancha_id is distinct from new.cancha_id) then
    select * into p1 from parejas where id = new.pareja1_id;
    select * into p2 from parejas where id = new.pareja2_id;

    insert into notificaciones (jugador_id, mensaje)
    select j, 'Te asignaron horario de partido: ' || to_char(new.horario, 'DD/MM HH24:MI')
    from unnest(array[p1.jugador1_id, p1.jugador2_id, p2.jugador1_id, p2.jugador2_id]) as j
    where j is not null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_notificar_horario on partidos;
create trigger trg_notificar_horario
before update on partidos
for each row execute function notificar_horario_asignado();

-- también disparar en el insert si ya viene con horario cargado
drop trigger if exists trg_notificar_horario_insert on partidos;
create trigger trg_notificar_horario_insert
before insert on partidos
for each row execute function notificar_horario_asignado();

-- ============================================================
-- VISTA: RANKING
-- ============================================================
create or replace view vista_ranking as
select
  id, nombre, apellido, nivel, categoria, puntos_ranking, partidos_jugados, partidos_ganados,
  rank() over (partition by categoria order by puntos_ranking desc) as posicion
from jugadores
where activo = true
order by categoria, puntos_ranking desc;

-- ============================================================
-- FUNCIONES PÚBLICAS DE SOLO LECTURA
-- Corren con permisos elevados (security definer) para poder mostrar
-- nombres de jugadores en el ranking, planteles y partidos sin exponer
-- email/teléfono a cualquiera con la clave anon. Así la tabla jugadores
-- puede quedar bloqueada por RLS y estas funciones son la única forma
-- de leer datos de jugadores desde afuera.
-- ============================================================
-- si existía de una versión anterior con otras columnas de salida, hay que tirarla:
-- Postgres no deja cambiarle la firma a una función con "or replace"
drop function if exists jugadores_publicos();
create or replace function jugadores_publicos() returns table (
  id uuid, nombre text, apellido text, categoria text, nivel text, foto_url text,
  puntos_ranking numeric(10,1), partidos_jugados int, partidos_ganados int
) language sql stable security definer set search_path = public as $$
  select id, nombre, apellido, categoria, nivel, foto_url, puntos_ranking, partidos_jugados, partidos_ganados
  from jugadores where activo = true;
$$;

-- ranking por categoría: a diferencia de jugadores_publicos() (una fila por jugador, su
-- categoría principal), esta devuelve una fila por cada categoría en la que el jugador
-- tiene puntos — así la misma persona aparece en el ranking de las 2+ categorías donde juega.
drop function if exists ranking_categoria_publico();
create or replace function ranking_categoria_publico() returns table (
  id uuid, nombre text, apellido text, categoria text, foto_url text,
  puntos_ranking numeric(10,1), partidos_jugados int, partidos_ganados int
) language sql stable security definer set search_path = public as $$
  select j.id, j.nombre, j.apellido, rc.categoria, j.foto_url,
         rc.puntos_ranking, rc.partidos_jugados, rc.partidos_ganados
  from ranking_categoria rc join jugadores j on j.id = rc.jugador_id
  where j.activo = true;
$$;

-- si existía de una versión anterior con otras columnas de salida, hay que tirarla:
-- Postgres no deja cambiarle la firma a una función con "or replace"
drop function if exists inscriptos_publicos(uuid);
create or replace function inscriptos_publicos(p_torneo_id uuid) returns table (
  jugador_id uuid, nombre text, apellido text, categoria text, categoria_torneo text, estado text
) language sql stable security definer set search_path = public as $$
  select j.id, j.nombre, j.apellido, j.categoria, i.categoria, i.estado
  from inscripciones i join jugadores j on j.id = i.jugador_id
  where i.torneo_id = p_torneo_id
  order by j.apellido;
$$;

drop function if exists parejas_publicas(uuid);
create or replace function parejas_publicas(p_torneo_id uuid) returns table (
  id uuid, jugador1_id uuid, jugador2_id uuid, jugador1_nombre text, jugador2_nombre text,
  categoria text, estado text, motivo_rechazo text
) language sql stable security definer set search_path = public as $$
  select p.id, p.jugador1_id, p.jugador2_id,
    j1.nombre || ' ' || j1.apellido, j2.nombre || ' ' || j2.apellido,
    i1.categoria, coalesce(i1.estado, 'pendiente'), i1.motivo_rechazo
  from parejas p
  join jugadores j1 on j1.id = p.jugador1_id
  join jugadores j2 on j2.id = p.jugador2_id
  left join inscripciones i1 on i1.torneo_id = p.torneo_id and i1.jugador_id = p.jugador1_id
  where p.torneo_id = p_torneo_id;
$$;

drop function if exists partidos_publicos(uuid);
create or replace function partidos_publicos(p_torneo_id uuid) returns table (
  id uuid, ronda text, categoria text, grupo int, horario timestamptz, estado text, sets jsonb,
  cancha_id uuid, cancha_nombre text, complejo_nombre text,
  pareja1_id uuid, pareja2_id uuid, ganador_pareja_id uuid,
  pareja1_nombre text, pareja2_nombre text,
  -- nombre/apellido (+ foto) de cada uno de los 4 jugadores por separado (además
  -- del "pareja1_nombre" ya concatenado, que se sigue usando en otras vistas) —
  -- lo pide la tarjeta de Zona/Ronda y la fila "orden de juego" para mostrar a
  -- cada jugador con su propio nombre y avatar, nunca a la pareja como un bloque
  j1a_nombre text, j1a_apellido text, j1a_foto text, j1b_nombre text, j1b_apellido text, j1b_foto text,
  j2a_nombre text, j2a_apellido text, j2a_foto text, j2b_nombre text, j2b_apellido text, j2b_foto text,
  created_at timestamptz
) language sql stable security definer set search_path = public as $$
  select pa.id, pa.ronda, pa.categoria, pa.grupo, pa.horario, pa.estado, pa.sets,
    pa.cancha_id, c.nombre, comp.nombre,
    pa.pareja1_id, pa.pareja2_id, pa.ganador_pareja_id,
    coalesce(j1a.nombre || ' ' || j1a.apellido || ' / ' || j1b.nombre || ' ' || j1b.apellido, '?'),
    coalesce(j2a.nombre || ' ' || j2a.apellido || ' / ' || j2b.nombre || ' ' || j2b.apellido, '?'),
    j1a.nombre, j1a.apellido, j1a.foto_url, j1b.nombre, j1b.apellido, j1b.foto_url,
    j2a.nombre, j2a.apellido, j2a.foto_url, j2b.nombre, j2b.apellido, j2b.foto_url,
    pa.created_at
  from partidos pa
  left join canchas c on c.id = pa.cancha_id
  left join complejos comp on comp.id = c.complejo_id
  left join parejas p1 on p1.id = pa.pareja1_id
  left join jugadores j1a on j1a.id = p1.jugador1_id
  left join jugadores j1b on j1b.id = p1.jugador2_id
  left join parejas p2 on p2.id = pa.pareja2_id
  left join jugadores j2a on j2a.id = p2.jugador1_id
  left join jugadores j2b on j2b.id = p2.jugador2_id
  where pa.torneo_id = p_torneo_id
  order by pa.horario nulls last;
$$;

-- ============================================================
-- INSCRIBIRSE (solo o invitando a una pareja) — función controlada
-- Permite que un jugador se anote a sí mismo y, si busca a otro jugador
-- ya registrado, anote a los dos juntos y arme la pareja automáticamente.
-- ============================================================
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
  -- nadie se anota solo: la pareja es obligatoria (se valida acá también, no solo en la app,
  -- para que no se pueda saltear llamando a la función directo)
  if p_pareja_jugador_id is null or p_pareja_jugador_id = v_mi_id then
    raise exception 'Elegí con quién vas a jugar antes de inscribirte: no te podés anotar solo/a';
  end if;
  -- la categoría también es obligatoria, y tiene que ser una de las que compiten
  -- en este torneo puntual (un torneo puede abarcar varias)
  if p_categoria is null or not exists (
    select 1 from torneo_categorias where torneo_id = p_torneo_id and categoria = p_categoria
  ) then
    raise exception 'Elegí en qué categoría van a jugar este torneo';
  end if;

  -- si ya existe una inscripción de este jugador a este torneo pero está
  -- 'cancelada' (se había dado de baja antes) o 'rechazada' (el admin la
  -- rechazó), se reactiva con la categoría nueva en vez de quedar pisada para
  -- siempre por el "do nothing": ninguna de las dos se borra físicamente (ver
  -- policy inscripciones_jugador_cancela y la columna motivo_rechazo), así que
  -- reinscribirse tiene que poder revivirlas. Si la fila existente está
  -- pendiente/confirmada de antes, se deja intacta como hasta ahora.
  insert into inscripciones (torneo_id, jugador_id, categoria)
  values (p_torneo_id, v_mi_id, p_categoria)
  on conflict (torneo_id, jugador_id) do update set categoria = excluded.categoria, estado = 'pendiente', motivo_rechazo = null
  where inscripciones.estado in ('cancelada', 'rechazada');

  insert into inscripciones (torneo_id, jugador_id, categoria)
  values (p_torneo_id, p_pareja_jugador_id, p_categoria)
  on conflict (torneo_id, jugador_id) do update set categoria = excluded.categoria, estado = 'pendiente', motivo_rechazo = null
  where inscripciones.estado in ('cancelada', 'rechazada');

  -- si ninguno de los dos tiene ya una pareja armada en este torneo, se arma
  if not exists (
    select 1 from parejas
    where torneo_id = p_torneo_id
      and (jugador1_id in (v_mi_id, p_pareja_jugador_id) or jugador2_id in (v_mi_id, p_pareja_jugador_id))
  ) then
    insert into parejas (torneo_id, jugador1_id, jugador2_id) values (p_torneo_id, v_mi_id, p_pareja_jugador_id);
  end if;

  insert into notificaciones (jugador_id, mensaje)
  select p_pareja_jugador_id,
    (select nombre || ' ' || apellido from jugadores where id = v_mi_id) || ' te anotó como su pareja en un torneo. ¡Ya quedaste inscripto!';
end;
$$;

-- ============================================================
-- JUGAR / RESERVAR CANCHA (día a día, fuera del circuito de torneos) —
-- reservar_cancha() arma la reserva + los invitados + les avisa, todo junto
-- y validado server-side (nunca queda una reserva de más de 4 personas ni
-- sin organizador). Queda "pendiente" hasta que el admin la confirma.
-- ============================================================
create or replace function reservar_cancha(p_cancha_id uuid, p_horario timestamptz, p_duracion_minutos int default 90, p_invitados_ids uuid[] default '{}')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_mi_id uuid;
  v_reserva_id uuid;
  v_costo_hora numeric;
  v_invitado uuid;
begin
  select id into v_mi_id from jugadores where auth_user_id = auth.uid();
  if v_mi_id is null then
    raise exception 'Completá tu perfil de jugador antes de reservar una cancha';
  end if;
  if p_horario is null or p_horario < now() then
    raise exception 'Elegí un horario válido, no puede ser en el pasado';
  end if;
  -- una cancha de pádel es para 4: el organizador + hasta 3 invitados
  if p_invitados_ids is not null and array_length(p_invitados_ids, 1) > 3 then
    raise exception 'Una cancha es para 4 personas como máximo (vos + 3 invitados)';
  end if;

  select costo_hora into v_costo_hora from canchas where id = p_cancha_id;

  insert into reservas (cancha_id, organizador_id, horario, duracion_minutos, costo)
  values (p_cancha_id, v_mi_id, p_horario, p_duracion_minutos,
    case when v_costo_hora is null then null else round(v_costo_hora * p_duracion_minutos / 60.0, 2) end)
  returning id into v_reserva_id;

  if p_invitados_ids is not null then
    foreach v_invitado in array p_invitados_ids loop
      if v_invitado is not null and v_invitado <> v_mi_id then
        insert into reserva_invitados (reserva_id, jugador_id) values (v_reserva_id, v_invitado) on conflict do nothing;
        insert into notificaciones (jugador_id, mensaje)
        select v_invitado, (select nombre || ' ' || apellido from jugadores where id = v_mi_id) || ' te invitó a jugar. Te avisamos cuando el club confirme la reserva.';
      end if;
    end loop;
  end if;

  return v_reserva_id;
end;
$$;

-- devuelve mis reservas (las que organicé o a las que me invitaron), con
-- todo lo que hace falta mostrar ya resuelto (nombres, no ids sueltos)
drop function if exists mis_reservas();
create or replace function mis_reservas() returns table (
  id uuid, cancha_id uuid, cancha_nombre text, complejo_nombre text,
  organizador_id uuid, organizador_nombre text, soy_organizador boolean,
  horario timestamptz, duracion_minutos int, costo numeric, estado text, invitados text
) language sql stable security definer set search_path = public as $$
  select r.id, r.cancha_id, c.nombre, co.nombre,
    r.organizador_id, jo.nombre || ' ' || jo.apellido, jo.auth_user_id = auth.uid(),
    r.horario, r.duracion_minutos, r.costo, r.estado,
    coalesce((select string_agg(ji.nombre || ' ' || ji.apellido, ', ')
      from reserva_invitados ri join jugadores ji on ji.id = ri.jugador_id where ri.reserva_id = r.id), '')
  from reservas r
  join canchas c on c.id = r.cancha_id
  left join complejos co on co.id = c.complejo_id
  join jugadores jo on jo.id = r.organizador_id
  where jo.auth_user_id = auth.uid()
     or exists (select 1 from reserva_invitados ri join jugadores ji on ji.id = ri.jugador_id where ri.reserva_id = r.id and ji.auth_user_id = auth.uid())
  order by r.horario;
$$;

-- todas las reservas para el panel de admin (confirmar/rechazar) — si quien
-- llama no es admin, devuelve vacío en vez de fallar
drop function if exists reservas_admin();
create or replace function reservas_admin() returns table (
  id uuid, cancha_id uuid, cancha_nombre text, complejo_nombre text,
  organizador_id uuid, organizador_nombre text, organizador_telefono text,
  horario timestamptz, duracion_minutos int, costo numeric, estado text, invitados text
) language sql stable security definer set search_path = public as $$
  select r.id, r.cancha_id, c.nombre, co.nombre,
    r.organizador_id, jo.nombre || ' ' || jo.apellido, jo.telefono,
    r.horario, r.duracion_minutos, r.costo, r.estado,
    coalesce((select string_agg(ji.nombre || ' ' || ji.apellido, ', ')
      from reserva_invitados ri join jugadores ji on ji.id = ri.jugador_id where ri.reserva_id = r.id), '')
  from reservas r
  join canchas c on c.id = r.cancha_id
  left join complejos co on co.id = c.complejo_id
  join jugadores jo on jo.id = r.organizador_id
  where is_admin()
  order by r.horario;
$$;

-- si existía de una versión anterior con otras columnas, hay que tirarla antes de poder redefinirla
drop function if exists jugador_del_mes_publico();
-- devuelve hasta 2 filas: el/la más reciente de Damas y de Caballeros por separado,
-- para poder mostrar "Jugador del mes" y "Jugadora del mes" a la vez en Inicio.
create or replace function jugador_del_mes_publico() returns table (
  jugador_id uuid, nombre text, apellido text, categoria text, genero text,
  puntos_ranking numeric, foto_url text, motivo text, created_at timestamptz
) language sql stable security definer set search_path = public as $$
  select distinct on (genero) jugador_id, nombre, apellido, categoria, genero, puntos_ranking, foto_url, motivo, created_at
  from (
    select j.id as jugador_id, j.nombre, j.apellido, j.categoria,
      case when j.categoria like '% Damas' then 'Damas'
           when j.categoria like '% Caballeros' then 'Caballeros'
           else 'Otras' end as genero,
      j.puntos_ranking, j.foto_url, m.motivo, m.created_at
    from jugador_del_mes m join jugadores j on j.id = m.jugador_id
  ) t
  where genero in ('Damas', 'Caballeros')
  order by genero, created_at desc;
$$;

-- ---------- CAMPEONES ----------
-- Se arma solo, a partir de los partidos de "Final" ya jugados: no hace falta cargar nada aparte.
drop function if exists campeones_publico();
create or replace function campeones_publico() returns table (
  torneo_id uuid, torneo_nombre text, fecha date,
  jugador1_id uuid, jugador1_nombre text, jugador1_apellido text, jugador1_foto text,
  jugador2_id uuid, jugador2_nombre text, jugador2_apellido text, jugador2_foto text
) language sql stable security definer set search_path = public as $$
  select t.id, t.nombre, coalesce(t.fecha_fin, t.fecha_inicio),
    j1.id, j1.nombre, j1.apellido, j1.foto_url,
    j2.id, j2.nombre, j2.apellido, j2.foto_url
  from partidos pt
  join torneos t on t.id = pt.torneo_id
  join parejas p on p.id = pt.ganador_pareja_id
  join jugadores j1 on j1.id = p.jugador1_id
  join jugadores j2 on j2.id = p.jugador2_id
  where pt.ronda = 'Final' and pt.estado = 'jugado' and pt.ganador_pareja_id is not null
  order by coalesce(t.fecha_fin, t.fecha_inicio) desc
  limit 8;
$$;

-- todos los torneos que ganó un jugador puntual (para su perfil público, sin el límite de 8 de arriba)
drop function if exists torneos_ganados_publico(uuid);
create or replace function torneos_ganados_publico(p_jugador_id uuid) returns table (
  torneo_id uuid, torneo_nombre text, fecha date, categoria text,
  companero_nombre text, companero_apellido text
) language sql stable security definer set search_path = public as $$
  select t.id, t.nombre, coalesce(t.fecha_fin, t.fecha_inicio), t.categoria,
    case when p.jugador1_id = p_jugador_id then j2.nombre else j1.nombre end,
    case when p.jugador1_id = p_jugador_id then j2.apellido else j1.apellido end
  from partidos pt
  join torneos t on t.id = pt.torneo_id
  join parejas p on p.id = pt.ganador_pareja_id
  join jugadores j1 on j1.id = p.jugador1_id
  join jugadores j2 on j2.id = p.jugador2_id
  where pt.ronda = 'Final' and pt.estado = 'jugado' and pt.ganador_pareja_id is not null
    and (p.jugador1_id = p_jugador_id or p.jugador2_id = p_jugador_id)
  order by coalesce(t.fecha_fin, t.fecha_inicio) desc;
$$;

-- torneos en los que un jugador llegó a la Final pero NO ganó (subcampeón) — para la
-- medalla de plata del perfil. Mismo criterio que torneos_ganados_publico de arriba,
-- pero del lado perdedor de la Final en vez del ganador.
drop function if exists finales_perdidas_publico(uuid);
create or replace function finales_perdidas_publico(p_jugador_id uuid) returns table (
  torneo_id uuid, torneo_nombre text, fecha date, categoria text,
  companero_nombre text, companero_apellido text
) language sql stable security definer set search_path = public as $$
  select t.id, t.nombre, coalesce(t.fecha_fin, t.fecha_inicio), t.categoria,
    case when p.jugador1_id = p_jugador_id then j2.nombre else j1.nombre end,
    case when p.jugador1_id = p_jugador_id then j2.apellido else j1.apellido end
  from partidos pt
  join torneos t on t.id = pt.torneo_id
  join parejas p on p.id = (case when pt.pareja1_id = pt.ganador_pareja_id then pt.pareja2_id else pt.pareja1_id end)
  join jugadores j1 on j1.id = p.jugador1_id
  join jugadores j2 on j2.id = p.jugador2_id
  where pt.ronda = 'Final' and pt.estado = 'jugado' and pt.ganador_pareja_id is not null
    and (p.jugador1_id = p_jugador_id or p.jugador2_id = p_jugador_id)
  order by coalesce(t.fecha_fin, t.fecha_inicio) desc;
$$;

-- estadísticas ampliadas del perfil de un jugador (finales jugadas, actividad de los
-- últimos 6 meses, primer/último torneo y total de torneos) — todo calculado a partir
-- de partidos/inscripciones ya existentes, sin agregar columnas nuevas en jugadores.
drop function if exists estadisticas_jugador(uuid);
create or replace function estadisticas_jugador(p_jugador_id uuid) returns table (
  total_finales int, partidos_6m int, ganados_6m int,
  primer_torneo date, ultimo_torneo date, total_torneos int
) language sql stable security definer set search_path = public as $$
  with mis_partidos as (
    select pa.*,
      case when p1.jugador1_id = p_jugador_id or p1.jugador2_id = p_jugador_id then pa.pareja1_id else pa.pareja2_id end as mi_pareja_id
    from partidos pa
    join parejas p1 on p1.id = pa.pareja1_id
    join parejas p2 on p2.id = pa.pareja2_id
    where p1.jugador1_id = p_jugador_id or p1.jugador2_id = p_jugador_id
       or p2.jugador1_id = p_jugador_id or p2.jugador2_id = p_jugador_id
  )
  select
    (select count(*)::int from mis_partidos where ronda = 'Final' and estado = 'jugado'),
    (select count(*)::int from mis_partidos where estado = 'jugado' and horario >= now() - interval '6 months'),
    (select count(*)::int from mis_partidos where estado = 'jugado' and horario >= now() - interval '6 months' and ganador_pareja_id = mi_pareja_id),
    (select min(t.fecha_inicio) from inscripciones i join torneos t on t.id = i.torneo_id where i.jugador_id = p_jugador_id),
    (select max(t.fecha_inicio) from inscripciones i join torneos t on t.id = i.torneo_id where i.jugador_id = p_jugador_id),
    (select count(distinct i.torneo_id)::int from inscripciones i where i.jugador_id = p_jugador_id);
$$;

-- jugadores que subieron de categoría este mes (para la tira rotativa de Inicio).
-- "subir" = pasar a una categoría con "orden" más alto; si alguien ascendió más de
-- una vez en el mes, se muestra solo la más reciente (distinct on).
drop function if exists ascendidos_del_mes();
create or replace function ascendidos_del_mes() returns table (
  jugador_id uuid, nombre text, apellido text, foto_url text, categoria_nueva text, fecha timestamptz
) language sql stable security definer set search_path = public as $$
  select jugador_id, nombre, apellido, foto_url, categoria_nueva, fecha from (
    select distinct on (h.jugador_id)
      h.jugador_id, j.nombre, j.apellido, j.foto_url, h.categoria_nueva, h.created_at as fecha
    from historial_categoria h
    join jugadores j on j.id = h.jugador_id
    join categorias ca_nueva on ca_nueva.nombre = h.categoria_nueva
    join categorias ca_vieja on ca_vieja.nombre = h.categoria_anterior
    where h.created_at >= date_trunc('month', now())
      and ca_nueva.orden > ca_vieja.orden
    order by h.jugador_id, h.created_at desc
  ) t
  order by fecha desc;
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- Lectura de listados públicos (ranking, torneos, complejos, sponsors)
-- abierta para toda la app. La escritura (crear torneos/complejos,
-- cargar resultados, subir flyers/sponsors) queda reservada a quienes
-- estén en la tabla "admins". Cada jugador solo puede crear/editar su
-- propia fila y su propia disponibilidad/inscripción.
-- ============================================================
alter table complejos enable row level security;
alter table canchas enable row level security;
alter table canchas_bloqueos enable row level security;
alter table categorias enable row level security;
alter table etiquetas_jugador enable row level security;
alter table puntos_ronda enable row level security;
alter table jugadores enable row level security;
alter table disponibilidad enable row level security;
alter table torneos enable row level security;
alter table torneo_canchas enable row level security;
alter table torneo_categorias enable row level security;
alter table parejas enable row level security;
alter table inscripciones enable row level security;
alter table partidos enable row level security;
alter table flyers enable row level security;
alter table sponsors enable row level security;
alter table jugador_del_mes enable row level security;
alter table push_subscriptions enable row level security;
alter table notificaciones enable row level security;
alter table admins enable row level security;
alter table historial_categoria enable row level security;
alter table config enable row level security;
alter table noticias enable row level security;
alter table reservas enable row level security;
alter table reserva_invitados enable row level security;

-- complejos / canchas: lectura pública, escritura solo admin
drop policy if exists "complejos_select" on complejos;
create policy "complejos_select" on complejos for select using (true);
drop policy if exists "complejos_write" on complejos;
create policy "complejos_write" on complejos for all using (is_admin()) with check (is_admin());

drop policy if exists "canchas_select" on canchas;
create policy "canchas_select" on canchas for select using (true);
drop policy if exists "canchas_write" on canchas;
create policy "canchas_write" on canchas for all using (is_admin()) with check (is_admin());

-- canchas_bloqueos: lectura pública (para que el calendario público muestre
-- la cancha como bloqueada), escritura solo admin — mismo patrón que canchas
drop policy if exists "canchas_bloqueos_select" on canchas_bloqueos;
create policy "canchas_bloqueos_select" on canchas_bloqueos for select using (true);
drop policy if exists "canchas_bloqueos_write" on canchas_bloqueos;
create policy "canchas_bloqueos_write" on canchas_bloqueos for all using (is_admin()) with check (is_admin());

-- reservas: cada uno ve las suyas (las que organizó o a las que lo invitaron) y el
-- admin las ve todas. El alta real de una reserva pasa por reservar_cancha() (más
-- abajo), no por un insert directo, para validar todo server-side de una. El
-- organizador SÍ puede cancelar su propia reserva directo (estado -> 'cancelada'),
-- pero no puede confirmarla él mismo: eso queda reservado al admin.
drop policy if exists "reservas_select" on reservas;
create policy "reservas_select" on reservas for select using (
  is_admin()
  or exists (select 1 from jugadores j where j.id = reservas.organizador_id and j.auth_user_id = auth.uid())
  or exists (select 1 from reserva_invitados ri join jugadores j on j.id = ri.jugador_id where ri.reserva_id = reservas.id and j.auth_user_id = auth.uid())
);
drop policy if exists "reservas_admin_write" on reservas;
create policy "reservas_admin_write" on reservas for all using (is_admin()) with check (is_admin());
drop policy if exists "reservas_organizador_cancela" on reservas;
create policy "reservas_organizador_cancela" on reservas for update
  using (exists (select 1 from jugadores j where j.id = reservas.organizador_id and j.auth_user_id = auth.uid()))
  with check (estado = 'cancelada');

-- ojo: esta policy NO mira la tabla reservas (aunque el organizador también
-- debería poder ver sus invitados) porque reservas_select ya mira
-- reserva_invitados — cruzarlas en las dos direcciones genera recursión
-- infinita en Postgres. El organizador ve sus invitados igual, a través de
-- mis_reservas()/reservas_admin() (funciones security definer, sin RLS).
drop policy if exists "reserva_invitados_select" on reserva_invitados;
create policy "reserva_invitados_select" on reserva_invitados for select using (
  is_admin()
  or exists (select 1 from jugadores j where j.id = reserva_invitados.jugador_id and j.auth_user_id = auth.uid())
);
drop policy if exists "reserva_invitados_write" on reserva_invitados;
create policy "reserva_invitados_write" on reserva_invitados for all using (is_admin()) with check (is_admin());

-- categorias: lectura pública, solo admin agrega/borra
drop policy if exists "categorias_select" on categorias;
create policy "categorias_select" on categorias for select using (true);
drop policy if exists "categorias_write" on categorias;
create policy "categorias_write" on categorias for all using (is_admin()) with check (is_admin());

-- etiquetas_jugador: NO es pública (a diferencia de categorias) — solo el admin
-- las puede leer o escribir, es una herramienta interna para armar horarios.
drop policy if exists "etiquetas_jugador_all" on etiquetas_jugador;
create policy "etiquetas_jugador_all" on etiquetas_jugador for all using (is_admin()) with check (is_admin());

-- puntos_ronda: lectura pública, solo admin edita los valores
drop policy if exists "puntos_ronda_select" on puntos_ronda;
create policy "puntos_ronda_select" on puntos_ronda for select using (true);
drop policy if exists "puntos_ronda_write" on puntos_ronda;
create policy "puntos_ronda_write" on puntos_ronda for all using (is_admin()) with check (is_admin());

-- jugadores: cada uno ve/edita su propia fila; admin ve/edita todas.
-- Para mostrar nombres en público se usan las funciones *_publicos() de arriba.
drop policy if exists "jugadores_select" on jugadores;
create policy "jugadores_select" on jugadores for select using (auth_user_id = auth.uid() or is_admin());
drop policy if exists "jugadores_insert" on jugadores;
create policy "jugadores_insert" on jugadores for insert with check (auth_user_id = auth.uid() or is_admin());
drop policy if exists "jugadores_update" on jugadores;
create policy "jugadores_update" on jugadores for update using (auth_user_id = auth.uid() or is_admin()) with check (auth_user_id = auth.uid() or is_admin());
drop policy if exists "jugadores_delete" on jugadores;
create policy "jugadores_delete" on jugadores for delete using (is_admin());

-- ranking_categoria: cada uno ve sus propias filas (todas sus categorías); admin ve/edita todas.
-- Solo el admin escribe (igual que categoria/puntos_ranking en jugadores) — un jugador no puede
-- auto-asignarse a una categoría extra ni tocar sus puntos. Para el público se usa
-- ranking_categoria_publico().
alter table ranking_categoria enable row level security;
drop policy if exists "ranking_categoria_select" on ranking_categoria;
create policy "ranking_categoria_select" on ranking_categoria for select
  using (is_admin() or exists (select 1 from jugadores j where j.id = ranking_categoria.jugador_id and j.auth_user_id = auth.uid()));
drop policy if exists "ranking_categoria_write" on ranking_categoria;
create policy "ranking_categoria_write" on ranking_categoria for all using (is_admin()) with check (is_admin());

-- disponibilidad: dueño del perfil o admin
drop policy if exists "disponibilidad_all" on disponibilidad;
create policy "disponibilidad_all" on disponibilidad for all
  using (exists (select 1 from jugadores j where j.id = disponibilidad.jugador_id and (j.auth_user_id = auth.uid() or is_admin())))
  with check (exists (select 1 from jugadores j where j.id = disponibilidad.jugador_id and (j.auth_user_id = auth.uid() or is_admin())));

-- torneos: lectura pública, escritura solo admin
drop policy if exists "torneos_select" on torneos;
create policy "torneos_select" on torneos for select using (true);
drop policy if exists "torneos_write" on torneos;
create policy "torneos_write" on torneos for all using (is_admin()) with check (is_admin());

-- torneo_canchas: lectura pública (qué cancha juega cada torneo), escritura admin
drop policy if exists "torneo_canchas_admin" on torneo_canchas;
drop policy if exists "torneo_canchas_select" on torneo_canchas;
create policy "torneo_canchas_select" on torneo_canchas for select using (true);
drop policy if exists "torneo_canchas_insert" on torneo_canchas;
create policy "torneo_canchas_insert" on torneo_canchas for insert with check (is_admin());
drop policy if exists "torneo_canchas_update" on torneo_canchas;
create policy "torneo_canchas_update" on torneo_canchas for update using (is_admin()) with check (is_admin());
drop policy if exists "torneo_canchas_delete" on torneo_canchas;
create policy "torneo_canchas_delete" on torneo_canchas for delete using (is_admin());

-- torneo_categorias: lectura pública (qué categorías compiten en cada torneo), escritura admin
drop policy if exists "torneo_categorias_select" on torneo_categorias;
create policy "torneo_categorias_select" on torneo_categorias for select using (true);
drop policy if exists "torneo_categorias_insert" on torneo_categorias;
create policy "torneo_categorias_insert" on torneo_categorias for insert with check (is_admin());
drop policy if exists "torneo_categorias_update" on torneo_categorias;
create policy "torneo_categorias_update" on torneo_categorias for update using (is_admin()) with check (is_admin());
drop policy if exists "torneo_categorias_delete" on torneo_categorias;
create policy "torneo_categorias_delete" on torneo_categorias for delete using (is_admin());

-- parejas, partidos: herramientas de armado, solo admin
-- (los datos públicos de partidos/parejas se muestran vía las funciones *_publicos())
drop policy if exists "parejas_admin" on parejas;
create policy "parejas_admin" on parejas for all using (is_admin()) with check (is_admin());
drop policy if exists "partidos_admin" on partidos;
create policy "partidos_admin" on partidos for all using (is_admin()) with check (is_admin());

-- historial_categoria: lo escribe el admin al aprobar un pedido; se lee vía ascendidos_del_mes()
drop policy if exists "historial_categoria_admin" on historial_categoria;
create policy "historial_categoria_admin" on historial_categoria for all using (is_admin()) with check (is_admin());

-- inscripciones: cada jugador ve/crea la suya, admin todas
drop policy if exists "inscripciones_select" on inscripciones;
create policy "inscripciones_select" on inscripciones for select using (
  is_admin() or exists (select 1 from jugadores j where j.id = inscripciones.jugador_id and j.auth_user_id = auth.uid())
);
drop policy if exists "inscripciones_insert" on inscripciones;
create policy "inscripciones_insert" on inscripciones for insert with check (
  is_admin() or exists (select 1 from jugadores j where j.id = inscripciones.jugador_id and j.auth_user_id = auth.uid())
);
-- el borrado físico queda reservado al admin (dar de baja a un jugador del roster,
-- o al borrar una pareja completa); el jugador cancela su propia inscripción
-- actualizando el estado (ver inscripciones_jugador_cancela más abajo), nunca
-- borrando la fila, para no perder el historial.
drop policy if exists "inscripciones_delete" on inscripciones;
create policy "inscripciones_delete" on inscripciones for delete using (is_admin());
-- el admin confirma/rechaza una inscripción (pago + categoría verificados)
drop policy if exists "inscripciones_update" on inscripciones;
create policy "inscripciones_update" on inscripciones for update using (is_admin()) with check (is_admin());
-- el propio jugador puede cancelar su inscripción (estado -> 'cancelada'), mismo
-- patrón ya usado en reservas_organizador_cancela
drop policy if exists "inscripciones_jugador_cancela" on inscripciones;
create policy "inscripciones_jugador_cancela" on inscripciones for update
  using (exists (select 1 from jugadores j where j.id = inscripciones.jugador_id and j.auth_user_id = auth.uid()))
  with check (estado = 'cancelada');

-- flyers (legacy), sponsors, jugador_del_mes: lectura pública, escritura admin
drop policy if exists "flyers_select" on flyers;
create policy "flyers_select" on flyers for select using (true);
drop policy if exists "flyers_write" on flyers;
create policy "flyers_write" on flyers for all using (is_admin()) with check (is_admin());

drop policy if exists "sponsors_select" on sponsors;
create policy "sponsors_select" on sponsors for select using (true);
drop policy if exists "sponsors_write" on sponsors;
create policy "sponsors_write" on sponsors for all using (is_admin()) with check (is_admin());

drop policy if exists "jugador_del_mes_select" on jugador_del_mes;
create policy "jugador_del_mes_select" on jugador_del_mes for select using (true);
drop policy if exists "jugador_del_mes_write" on jugador_del_mes;
create policy "jugador_del_mes_write" on jugador_del_mes for all using (is_admin()) with check (is_admin());

drop policy if exists "config_select" on config;
create policy "config_select" on config for select using (true);
drop policy if exists "config_write" on config;
create policy "config_write" on config for all using (is_admin()) with check (is_admin());

drop policy if exists "noticias_select" on noticias;
create policy "noticias_select" on noticias for select using (true);
drop policy if exists "noticias_write" on noticias;
create policy "noticias_write" on noticias for all using (is_admin()) with check (is_admin());

-- push_subscriptions, notificaciones: privadas del dueño (o admin)
drop policy if exists "push_subscriptions_all" on push_subscriptions;
create policy "push_subscriptions_all" on push_subscriptions for all
  using (is_admin() or exists (select 1 from jugadores j where j.id = push_subscriptions.jugador_id and j.auth_user_id = auth.uid()))
  with check (is_admin() or exists (select 1 from jugadores j where j.id = push_subscriptions.jugador_id and j.auth_user_id = auth.uid()));

drop policy if exists "notificaciones_select" on notificaciones;
create policy "notificaciones_select" on notificaciones for select using (
  is_admin() or exists (select 1 from jugadores j where j.id = notificaciones.jugador_id and j.auth_user_id = auth.uid())
);
drop policy if exists "notificaciones_update" on notificaciones;
create policy "notificaciones_update" on notificaciones for update using (
  is_admin() or exists (select 1 from jugadores j where j.id = notificaciones.jugador_id and j.auth_user_id = auth.uid())
);
drop policy if exists "notificaciones_insert" on notificaciones;
create policy "notificaciones_insert" on notificaciones for insert with check (is_admin());

-- admins: cada usuario solo puede consultar si ÉL es admin (no se puede
-- listar a los demás admins ni auto-asignarse el rol desde la app)
drop policy if exists "admins_select_own" on admins;
create policy "admins_select_own" on admins for select using (user_id = auth.uid());

-- ============================================================
-- STORAGE: bucket público para flyers
-- Ejecutar esto también (o crearlo a mano en Storage > New bucket "flyers", público)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('flyers', 'flyers', true)
on conflict (id) do nothing;

drop policy if exists "flyers_public_read" on storage.objects;
create policy "flyers_public_read" on storage.objects
  for select using (bucket_id = 'flyers');

drop policy if exists "flyers_public_write" on storage.objects;
drop policy if exists "flyers_admin_write" on storage.objects;
create policy "flyers_admin_write" on storage.objects
  for insert with check (bucket_id = 'flyers' and public.is_admin());

-- ============================================================
-- STORAGE: bucket público para logos de sponsors/publicidad
-- ============================================================
insert into storage.buckets (id, name, public)
values ('sponsors', 'sponsors', true)
on conflict (id) do nothing;

drop policy if exists "sponsors_public_read" on storage.objects;
create policy "sponsors_public_read" on storage.objects
  for select using (bucket_id = 'sponsors');

drop policy if exists "sponsors_public_write" on storage.objects;
drop policy if exists "sponsors_admin_write" on storage.objects;
create policy "sponsors_admin_write" on storage.objects
  for insert with check (bucket_id = 'sponsors' and public.is_admin());

-- ============================================================
-- STORAGE: bucket público para imágenes de noticias
-- ============================================================
insert into storage.buckets (id, name, public)
values ('noticias', 'noticias', true)
on conflict (id) do nothing;

drop policy if exists "noticias_public_read" on storage.objects;
create policy "noticias_public_read" on storage.objects
  for select using (bucket_id = 'noticias');

drop policy if exists "noticias_admin_write" on storage.objects;
create policy "noticias_admin_write" on storage.objects
  for insert with check (bucket_id = 'noticias' and public.is_admin());

-- ============================================================
-- STORAGE: bucket público para fotos de perfil de jugadores
-- A diferencia de flyers/sponsors, acá puede subir CUALQUIER usuario logueado
-- (su propia foto), no solo el admin.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('fotos', 'fotos', true)
on conflict (id) do nothing;

drop policy if exists "fotos_public_read" on storage.objects;
create policy "fotos_public_read" on storage.objects
  for select using (bucket_id = 'fotos');

drop policy if exists "fotos_auth_write" on storage.objects;
create policy "fotos_auth_write" on storage.objects
  for insert with check (bucket_id = 'fotos' and auth.role() = 'authenticated');
