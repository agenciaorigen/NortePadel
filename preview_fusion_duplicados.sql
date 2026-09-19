-- ============================================================
-- PREVIEW de solo lectura para decidir, par por par, cuáles de los 30
-- candidatos a duplicado (resultado de la Parte 2b del diagnóstico
-- anterior) son realmente LA MISMA PERSONA anotada dos veces, y cuál de
-- los dos ids conviene conservar.
--
-- OJO: "mismo apellido + nombre parecido" es una pista, no una prueba.
-- Nombres comunes (ej. "Patricio Esquivel" aparece en 3 ids distintos)
-- pueden ser personas distintas de verdad. Antes de fusionar cualquier
-- par, mirá también email/teléfono acá abajo — si coinciden, es case
-- prácticamente seguro; si ninguno de los dos tiene email/teléfono
-- cargado, conviene preguntarle al jugador o comparar con la lista de
-- inscripción en papel/WhatsApp del torneo donde apareció por primera vez.
-- ============================================================

with pares(id_1, id_2) as (
  values
    ('104ba0a0-8f14-4320-b22c-0e717dd7ef13'::uuid, 'b8a60e9c-501d-47fe-a873-dd9711a69384'::uuid), -- Adriana Regalado
    ('8c33123a-5c75-405c-903d-fd706ab127a3'::uuid, 'ce1a59d7-686a-4a86-ba37-06648f9183de'::uuid), -- Alex Da Rosa
    ('47f1c761-ee62-4de2-9c51-1ca8529bbc61'::uuid, 'd43d2a84-8ff7-442d-8ca1-28693a5814d0'::uuid), -- Alex/Ale Lopez
    ('268d1fc8-8970-4f1d-8f71-e60024044d92'::uuid, 'cd251440-5e38-412d-8083-7f2fdc01952a'::uuid), -- Alexander/Alex Benitez
    ('03532c18-9d6b-4158-9589-f61cdc8c5196'::uuid, 'e090e2fb-a66d-4fff-a37a-eb5f94bbf5cc'::uuid), -- Anahel/Ana Schreiner
    ('8cfb2415-eb5f-45d3-b51e-50b3eb6791cc'::uuid, 'b47d9037-a8ff-412a-871e-147d105dd866'::uuid), -- Anto/Antonella Aguirre
    ('9f802d00-cd04-4032-8141-c2d74319a5bf'::uuid, 'bb11233a-a416-4c03-a8f4-ba76a1452184'::uuid), -- Antonella/Antonela Motta
    ('3b04d5dc-1f77-40a1-84ed-7099a4cf54fe'::uuid, '514692fe-be9f-4fda-a485-994cf9971811'::uuid), -- Cami/Camila Saucedo
    ('b6172c12-3b13-4d26-8fb1-19091cd634e3'::uuid, 'd0f02d39-ea2b-40b2-ad71-a9692d53e92c'::uuid), -- Cristina (Soledad) Gonzalez
    ('033f1e60-dc71-4b2e-9211-03322074e844'::uuid, '6079fb2b-1917-44d0-84b6-34653850d7bd'::uuid), -- Dai/Daina Paiva
    ('51563a13-698a-4ae0-a310-2899a5dc6437'::uuid, 'ad0f42d2-deca-4e81-a845-b3c3a6142a38'::uuid), -- Dani/Daniel Ortiz
    ('3f7abbc9-7dbc-48eb-8624-e84361fdc959'::uuid, 'ce3bf531-dfb6-441e-8c45-27a38450c13c'::uuid), -- Danilo/Daniel Rotela
    ('09cc483b-62f8-411f-8986-4eb39d38b5c0'::uuid, '7d552be1-8783-4b4e-85e5-238d46ca6ddd'::uuid), -- Eze/Ezequiel Avalos
    ('ba851067-602d-4471-8c49-75e8e357379e'::uuid, 'bdd2a705-b964-4d8d-89cd-63d3536a1f12'::uuid), -- Facu/Facundo Vera *** el caso que preguntaste ***
    ('069010b1-ac04-4e37-865d-c6712f321ebd'::uuid, 'a3f7162f-92e6-4578-b8b9-61f0f78118bf'::uuid), -- Fernanda/Fer Spallanzani
    ('e3a436ba-dee4-494f-b83f-52a726cc6200'::uuid, 'f9e05b6a-2718-43c9-9c26-95e3294cc513'::uuid), -- Francisco/Fran Corde
    ('33654975-a584-4bff-9e36-497ef658e5f2'::uuid, 'f02aa80e-2001-490f-940e-8fbb76b56ff5'::uuid), -- Gonzalo/Gonza Sosa
    ('08fd44d7-811d-4e08-b2ab-bdc5379ed8db'::uuid, 'e8b8d31a-46ba-4612-b7cc-7b7c5d310176'::uuid), -- Joa/Joaquin Dachary
    ('53961c73-1c57-4b7f-bbfc-ec6d0fcccfbd'::uuid, '84c9fe4c-ebdf-4414-950a-47ac9aa774ac'::uuid), -- Joaquin/Joa Pereira
    ('8a5d0181-422d-436e-bd5a-8e234a50f342'::uuid, 'e36f5212-7a3d-485a-99a6-abb3addf8297'::uuid), -- Jonatan/Jonathan Paredes
    ('2fcb574b-9b09-478b-9541-610749da8307'::uuid, 'f2779e67-b853-4002-97c1-41d7c0cd07b3'::uuid), -- Mauricio/Mauri Lemes
    ('0a610208-489d-4ad4-81fd-626e7d1b0648'::uuid, '95c9ccf2-340f-4b07-80af-9623271622e2'::uuid), -- Mauricio/Mauri Miranda
    ('45fc9405-0972-40df-b0f6-7421fca1d90e'::uuid, 'b5e64b80-b33a-40ce-9ebd-5c79ce97fb56'::uuid), -- Maximo/Maxi Benitez
    ('40ffb037-bd7a-4d27-8379-9a9fc5090a2b'::uuid, 'ac33c9dc-85f7-4e9e-af2d-e63d2c9fdfb0'::uuid), -- Mica/Micaela Gautschi
    ('02820429-e4a3-4675-b7e8-99269b013b49'::uuid, 'aaf0d718-cc82-4200-b417-8b0245815c12'::uuid), -- Patricio Esquivel (par 1)
    ('02820429-e4a3-4675-b7e8-99269b013b49'::uuid, 'd33771f5-02b1-4de1-aa26-251f60a0ab62'::uuid), -- Patricio Esquivel (par 2)
    ('aaf0d718-cc82-4200-b417-8b0245815c12'::uuid, 'd33771f5-02b1-4de1-aa26-251f60a0ab62'::uuid), -- Patricio Esquivel (par 3) -- ¡3 ids! revisar con más cuidado, puede ser 1, 2 o 3 personas
    ('a3f23adc-2846-4299-9aad-a77545cdd5f9'::uuid, 'aea121ac-b774-48e1-8faf-861bf7252dc4'::uuid), -- Rodrigo/Rodri Vera
    ('933a2c82-5d67-4fbf-a66c-82daf842d736'::uuid, 'b5f23ec2-133a-4bd8-a3dc-375d9689edf0'::uuid), -- Sole/Soledad Rojas
    ('7095bff2-22d2-4062-9da6-b756de86f09f'::uuid, 'a553bfb7-2ef2-4389-a2a9-2d1164d1ddd5'::uuid), -- Tati/Tatiana Caradona
    ('12fb7998-af22-4a21-9a3c-cca79ff9a6f6'::uuid, 'c256bcd8-7904-4729-9ab8-b74e4ef27794'::uuid)  -- Yani/Yanina Miranda
),
totales as (
  select
    j.id,
    j.nombre || ' ' || j.apellido as nombre_completo,
    j.categoria,
    j.email,
    j.telefono,
    j.auth_user_id is not null as tiene_login,
    j.puntos_ranking,
    coalesce((select sum(rc.puntos_ranking) from ranking_categoria rc where rc.jugador_id = j.id), 0) as puntos_otras_categorias,
    (select count(*) from parejas pa where pa.jugador1_id = j.id or pa.jugador2_id = j.id) as parejas_jugadas,
    j.created_at
  from jugadores j
)
select
  p.id_1, t1.nombre_completo as jugador_1, t1.categoria as cat_1, t1.email as email_1, t1.telefono as tel_1,
  t1.tiene_login as login_1, t1.puntos_ranking as pts_1, t1.puntos_otras_categorias as pts_otras_cat_1,
  t1.parejas_jugadas as parejas_1, t1.created_at as creado_1,
  p.id_2, t2.nombre_completo as jugador_2, t2.categoria as cat_2, t2.email as email_2, t2.telefono as tel_2,
  t2.tiene_login as login_2, t2.puntos_ranking as pts_2, t2.puntos_otras_categorias as pts_otras_cat_2,
  t2.parejas_jugadas as parejas_2, t2.created_at as creado_2,
  case
    when t1.email is not null and t1.email = t2.email then 'MISMO EMAIL — casi seguro la misma persona'
    when t1.telefono is not null and regexp_replace(t1.telefono,'\D','','g') = regexp_replace(t2.telefono,'\D','','g') then 'MISMO TELÉFONO — casi seguro la misma persona'
    when t1.tiene_login and t2.tiene_login then 'OJO: los dos tienen cuenta propia (login) — antes de fusionar, confirmar cuál de las dos cuentas sigue usando'
    else 'sin dato extra — confirmar a mano'
  end as pista
from pares p
join totales t1 on t1.id = p.id_1
join totales t2 on t2.id = p.id_2
order by jugador_1;
