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

-- un jugador no puede cambiar su propia categoría oficial directo (solo puede dejarla
-- pedida en categoria_pendiente); si intenta escribir en categoria igual, se ignora.
-- el admin sí puede escribir categoria libremente (para aprobar pedidos o corregir errores).
create or replace function proteger_categoria_jugador() returns trigger as $$
begin
  if not is_admin() and new.categoria is distinct from old.categoria then
    new.categoria := old.categoria;
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

-- ---------- DISPONIBILIDAD HORARIA DEL JUGADOR ----------
-- dia_semana: 0=domingo ... 6=sábado
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
  estado text not null default 'inscripcion', -- inscripcion, en_curso, finalizado, cancelado
  puntos_primero int not null default 100,
  puntos_segundo int not null default 60,
  puntos_participacion int not null default 10,
  flyer_url text,
  created_at timestamptz not null default now()
);

alter table torneos add column if not exists flyer_url text;

-- Canchas habilitadas para cada torneo (permite reasignar por clima u otro motivo)
create table if not exists torneo_canchas (
  id uuid primary key default gen_random_uuid(),
  torneo_id uuid not null references torneos(id) on delete cascade,
  cancha_id uuid not null references canchas(id) on delete cascade,
  unique (torneo_id, cancha_id)
);

-- Categorías que compiten en cada torneo (un torneo puede abarcar varias, ej: de 2da a 8va)
create table if not exists torneo_categorias (
  id uuid primary key default gen_random_uuid(),
  torneo_id uuid not null references torneos(id) on delete cascade,
  categoria text not null,
  unique (torneo_id, categoria)
);

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

-- ---------- PARTIDOS ----------
create table if not exists partidos (
  id uuid primary key default gen_random_uuid(),
  torneo_id uuid not null references torneos(id) on delete cascade,
  ronda text default 'Fase de grupos',
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
begin
  -- solo actuar cuando el partido pasa a "jugado" y tiene ganador
  if new.estado = 'jugado' and new.ganador_pareja_id is not null
     and (old.estado is distinct from 'jugado' or old.ganador_pareja_id is distinct from new.ganador_pareja_id) then

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

    -- puntos + partido jugado para la pareja perdedora
    if perdedor.id is not null then
      update jugadores set
        puntos_ranking = puntos_ranking + coalesce(pts_perdedor, 0),
        partidos_jugados = partidos_jugados + 1
      where id in (perdedor.jugador1_id, perdedor.jugador2_id);
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

create or replace function inscriptos_publicos(p_torneo_id uuid) returns table (
  jugador_id uuid, nombre text, apellido text, categoria text
) language sql stable security definer set search_path = public as $$
  select j.id, j.nombre, j.apellido, j.categoria
  from inscripciones i join jugadores j on j.id = i.jugador_id
  where i.torneo_id = p_torneo_id
  order by j.apellido;
$$;

create or replace function parejas_publicas(p_torneo_id uuid) returns table (
  id uuid, jugador1_id uuid, jugador2_id uuid, jugador1_nombre text, jugador2_nombre text
) language sql stable security definer set search_path = public as $$
  select p.id, p.jugador1_id, p.jugador2_id,
    j1.nombre || ' ' || j1.apellido, j2.nombre || ' ' || j2.apellido
  from parejas p
  join jugadores j1 on j1.id = p.jugador1_id
  join jugadores j2 on j2.id = p.jugador2_id
  where p.torneo_id = p_torneo_id;
$$;

create or replace function partidos_publicos(p_torneo_id uuid) returns table (
  id uuid, ronda text, horario timestamptz, estado text, sets jsonb,
  cancha_id uuid, cancha_nombre text,
  pareja1_id uuid, pareja2_id uuid, ganador_pareja_id uuid,
  pareja1_nombre text, pareja2_nombre text
) language sql stable security definer set search_path = public as $$
  select pa.id, pa.ronda, pa.horario, pa.estado, pa.sets,
    pa.cancha_id, c.nombre,
    pa.pareja1_id, pa.pareja2_id, pa.ganador_pareja_id,
    coalesce(j1a.nombre || ' ' || j1a.apellido || ' / ' || j1b.nombre || ' ' || j1b.apellido, '?'),
    coalesce(j2a.nombre || ' ' || j2a.apellido || ' / ' || j2b.nombre || ' ' || j2b.apellido, '?')
  from partidos pa
  left join canchas c on c.id = pa.cancha_id
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
create or replace function inscribirse_con_pareja(p_torneo_id uuid, p_pareja_jugador_id uuid default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_mi_id uuid;
begin
  select id into v_mi_id from jugadores where auth_user_id = auth.uid();
  if v_mi_id is null then
    raise exception 'Completá tu perfil de jugador antes de inscribirte';
  end if;

  insert into inscripciones (torneo_id, jugador_id)
  values (p_torneo_id, v_mi_id)
  on conflict (torneo_id, jugador_id) do nothing;

  if p_pareja_jugador_id is not null and p_pareja_jugador_id <> v_mi_id then
    insert into inscripciones (torneo_id, jugador_id)
    values (p_torneo_id, p_pareja_jugador_id)
    on conflict (torneo_id, jugador_id) do nothing;

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
  end if;
end;
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
alter table categorias enable row level security;
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

-- complejos / canchas: lectura pública, escritura solo admin
drop policy if exists "complejos_select" on complejos;
create policy "complejos_select" on complejos for select using (true);
drop policy if exists "complejos_write" on complejos;
create policy "complejos_write" on complejos for all using (is_admin()) with check (is_admin());

drop policy if exists "canchas_select" on canchas;
create policy "canchas_select" on canchas for select using (true);
drop policy if exists "canchas_write" on canchas;
create policy "canchas_write" on canchas for all using (is_admin()) with check (is_admin());

-- categorias: lectura pública, solo admin agrega/borra
drop policy if exists "categorias_select" on categorias;
create policy "categorias_select" on categorias for select using (true);
drop policy if exists "categorias_write" on categorias;
create policy "categorias_write" on categorias for all using (is_admin()) with check (is_admin());

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

-- inscripciones: cada jugador ve/crea/borra la suya, admin todas
drop policy if exists "inscripciones_select" on inscripciones;
create policy "inscripciones_select" on inscripciones for select using (
  is_admin() or exists (select 1 from jugadores j where j.id = inscripciones.jugador_id and j.auth_user_id = auth.uid())
);
drop policy if exists "inscripciones_insert" on inscripciones;
create policy "inscripciones_insert" on inscripciones for insert with check (
  is_admin() or exists (select 1 from jugadores j where j.id = inscripciones.jugador_id and j.auth_user_id = auth.uid())
);
drop policy if exists "inscripciones_delete" on inscripciones;
create policy "inscripciones_delete" on inscripciones for delete using (
  is_admin() or exists (select 1 from jugadores j where j.id = inscripciones.jugador_id and j.auth_user_id = auth.uid())
);

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
