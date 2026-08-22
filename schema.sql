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
  nombre text not null,
  apellido text not null,
  email text unique,
  telefono text,
  nivel text default 'intermedio', -- principiante, intermedio, avanzado
  categoria text not null default '6ta', -- categoría de competencia (6ta, 5ta, 4ta, Damas, etc.)
  lado_preferido text, -- drive, reves, indistinto
  puntos_ranking int not null default 0,
  partidos_jugados int not null default 0,
  partidos_ganados int not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- por si la tabla ya existía de una instalación anterior sin esta columna
alter table jugadores add column if not exists categoria text not null default '6ta';

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
  created_at timestamptz not null default now()
);

-- Canchas habilitadas para cada torneo (permite reasignar por clima u otro motivo)
create table if not exists torneo_canchas (
  id uuid primary key default gen_random_uuid(),
  torneo_id uuid not null references torneos(id) on delete cascade,
  cancha_id uuid not null references canchas(id) on delete cascade,
  unique (torneo_id, cancha_id)
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

-- ============================================================
-- TRIGGER: al cargar resultado de un partido, sumar puntos de ranking
-- ============================================================
create or replace function actualizar_ranking() returns trigger as $$
declare
  t torneos%rowtype;
  ganador parejas%rowtype;
  perdedor_id uuid;
  perdedor parejas%rowtype;
begin
  -- solo actuar cuando el partido pasa a "jugado" y tiene ganador
  if new.estado = 'jugado' and new.ganador_pareja_id is not null
     and (old.estado is distinct from 'jugado' or old.ganador_pareja_id is distinct from new.ganador_pareja_id) then

    select * into t from torneos where id = new.torneo_id;
    select * into ganador from parejas where id = new.ganador_pareja_id;

    perdedor_id := case when new.pareja1_id = new.ganador_pareja_id then new.pareja2_id else new.pareja1_id end;
    select * into perdedor from parejas where id = perdedor_id;

    -- puntos + partido jugado + partido ganado para la pareja ganadora
    update jugadores set
      puntos_ranking = puntos_ranking + coalesce(t.puntos_primero,0),
      partidos_jugados = partidos_jugados + 1,
      partidos_ganados = partidos_ganados + 1
    where id in (ganador.jugador1_id, ganador.jugador2_id);

    -- puntos de participación + partido jugado para la pareja perdedora
    if perdedor.id is not null then
      update jugadores set
        puntos_ranking = puntos_ranking + coalesce(t.puntos_segundo,0),
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
-- ROW LEVEL SECURITY
-- MVP: lectura pública para toda la app (ranking, flyers, torneos, etc.)
-- Escritura pública controlada a nivel de app (sin login de admin todavía).
-- Podés endurecer esto más adelante agregando Supabase Auth para el organizador.
-- ============================================================
alter table complejos enable row level security;
alter table canchas enable row level security;
alter table jugadores enable row level security;
alter table disponibilidad enable row level security;
alter table torneos enable row level security;
alter table torneo_canchas enable row level security;
alter table parejas enable row level security;
alter table inscripciones enable row level security;
alter table partidos enable row level security;
alter table flyers enable row level security;
alter table push_subscriptions enable row level security;
alter table notificaciones enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['complejos','canchas','jugadores','disponibilidad','torneos','torneo_canchas','parejas','inscripciones','partidos','flyers','push_subscriptions','notificaciones']
  loop
    execute format('drop policy if exists "public_select" on %I', tbl);
    execute format('create policy "public_select" on %I for select using (true)', tbl);
    execute format('drop policy if exists "public_insert" on %I', tbl);
    execute format('create policy "public_insert" on %I for insert with check (true)', tbl);
    execute format('drop policy if exists "public_update" on %I', tbl);
    execute format('create policy "public_update" on %I for update using (true) with check (true)', tbl);
    execute format('drop policy if exists "public_delete" on %I', tbl);
    execute format('create policy "public_delete" on %I for delete using (true)', tbl);
  end loop;
end $$;

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
create policy "flyers_public_write" on storage.objects
  for insert with check (bucket_id = 'flyers');
