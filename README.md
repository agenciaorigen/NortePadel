# Norte Padel — App instalable (PWA)

App para tu organización de torneos: ranking automático por categoría, jugadores que se registran e inscriben solos, armado automático de partidos, resultados en vivo, complejos/canchas reasignables, flyers, jugador del mes y espacio de sponsors.

Está hecha en HTML/CSS/JS puro (sin frameworks) + [Supabase](https://supabase.com) como base de datos y sistema de login en la nube. Así cualquier jugador que entra ve el mismo ranking y los mismos partidos en tiempo real, desde cualquier celular o computadora.

## 1. Crear el backend (10 minutos, gratis)

1. Andá a [supabase.com](https://supabase.com), creá una cuenta gratis y un proyecto nuevo (elegí una región cercana, ej: São Paulo).
2. Cuando el proyecto esté listo, andá a **SQL Editor > New query**, pegá **todo** el contenido del archivo `schema.sql` y ejecutalo. Esto crea todas las tablas, el ranking automático, las reglas de seguridad y los buckets de flyers/sponsors.

   > Si ya habías corrido una versión anterior de `schema.sql`, volvé a pegar y ejecutar el archivo completo igual: es seguro correrlo de nuevo (no borra datos existentes) y así sumás las funciones nuevas, como la de anotarse con pareja.
3. Andá a **Authentication > Providers > Email** y **desactivá "Confirm email"**. Así, cuando alguien crea una cuenta, entra directo sin tener que ir a confirmar por correo (podés reactivarlo más adelante si configurás un proveedor de email propio).
4. Andá a **Project Settings > API** y copiá:
   - **Project URL**
   - **anon public key**
5. Abrí el archivo `config.js` y pegalos ahí:
   ```js
   const SUPABASE_URL = "https://xxxxx.supabase.co";
   const SUPABASE_ANON_KEY = "eyJhbGciOi...";
   ```

## 2. Publicar la web (para que sea instalable)

Un PWA necesita HTTPS para poder instalarse y funcionar offline. La forma más simple y gratis:

1. Subí la carpeta completa (`index.html`, `app.js`, `config.js`, `matching.js`, `style.css`, `sw.js`, `manifest.json`, `icons/`) a [Netlify Drop](https://app.netlify.com/drop) (arrastrás la carpeta y listo) o a Vercel/GitHub Pages.
2. Te da una URL tipo `https://norte-padel.netlify.app`. Compartísela a los jugadores.
3. Cualquiera que la abra desde el celular va a ver la opción **"Agregar a pantalla de inicio" / "Instalar app"** en el navegador (Chrome/Safari), y les queda como una app más.

## 3. Convertirte en administrador

Recién instalada, nadie es administrador todavía (ni siquiera vos) — es a propósito, para que nadie pueda auto-asignarse el rol desde la app. Para activarte:

1. Abrí la app y andá a **Mi perfil > Crear cuenta nueva** con tu email y una contraseña.
2. En Supabase, andá a **SQL Editor** y corré (cambiando el email por el que usaste):
   ```sql
   insert into admins (user_id)
   select id from auth.users where email = 'tu-email@ejemplo.com';
   ```
3. Volvé a la app y refrescá la página. Ahora vas a ver el ícono de engranaje ⚙️ en el encabezado: ese es tu panel de administrador.

Repetí el paso 2 con el email de cualquier otra persona que también organice torneos con vos.

## 4. Cómo funciona para cada rol

**Administradores** (el ícono ⚙️ en el encabezado):
- Crean los **complejos**, con nombre, dirección y cuántas canchas tiene (las crea automáticamente con ese número; después podés agregar más una por una si hace falta).
- Administran la lista de **categorías** (6ta, 5ta, Damas, Suma12, la que hagan falta): las agregan, **editan el nombre** (✏️, para corregir errores de tipeo — renombra también a todos los jugadores y torneos que ya la tenían asignada) o las borran desde el panel de administrador, y esa lista es la que después aparece para elegir tanto en el perfil del jugador como al crear un torneo.
- **Aprueban o rechazan los pedidos de categoría** de los jugadores, desde "Solicitudes de categoría" en el panel de administrador. Un jugador nunca puede cambiar su categoría oficial por su cuenta (está bloqueado también a nivel de base de datos, no solo en la pantalla) — solo puede pedirla, y el admin decide.
- Crean los **torneos** (desde la pestaña Torneos, ahí aparece el formulario) eligiendo el complejo sede, **qué categorías compiten** (tildan una o varias, por ejemplo de 2da a 8va, o "seleccionar todas") y fechas — y pueden subir el flyer ahí mismo, que aparece automáticamente en Inicio.
- Desde el detalle de un torneo: agregan/cambian canchas (por clima u otro motivo), inscriben jugadores manualmente si hace falta, arman las parejas y los partidos con un clic, y cargan resultados eligiendo la **ronda** de cada partido (Dieciseisavos, Octavos, Cuartos, Semifinal, Final) para que sume los puntos que corresponden.
- Definen los **puntos por ronda** desde el panel de administrador (por defecto: Campeón 1000, Sub 750, Semifinal 500, Cuartos 250, Octavos 125, Dieciseisavos 100) y los pueden cambiar cuando quieran.
- Eligen al **jugador del mes y a la jugadora del mes** desde el panel de administrador (un mismo selector para cualquier jugador: la app detecta sola si es de una categoría "Damas" o "Caballeros" y lo pone en la tarjeta que corresponde). Se muestran los dos a la vez en Inicio; mientras no se eligió ninguno, se ve una tarjeta de muestra en su lugar.
- Suben los logos de **auspiciantes/publicidad**, generales (aparecen en Inicio, la columna lateral y todos los torneos) o de un torneo puntual (aparecen solo en ese torneo).

**Jugadores**: se registran ellos mismos (Mi perfil > Crear cuenta), completan su categoría deseada (elegida de la lista que armó el administrador) y en qué días/horarios pueden jugar, y desde ahí ya está. Esa categoría queda **pedida** — el jugador ve un aviso de "pendiente de aprobación" y sigue jugando en su categoría oficial hasta que un administrador la apruebe desde el panel de administrador ("Solicitudes de categoría"); si se arrepiente y vuelve a elegir su categoría actual antes de que lo aprueben, el pedido se cancela solo. Para anotarse a un torneo entran a la pestaña Torneos, tocan el que quieren y primero ven **quiénes ya se anotaron**. Ahí mismo pueden tocar **"Inscribirme"**: si van a jugar con alguien, buscan su nombre (aparece mientras escriben) y los anota a los **dos juntos** de una sola vez, incluso si su pareja todavía no había entrado a la app — le queda una notificación avisándole que ya está anotada. Si van solos, con tocar el botón alcanza. La app ya sabe con qué horarios cuentan porque los cargaron en su perfil. Pueden editar sus datos y horarios cuando quieran desde Mi perfil.

## 5. El resto de las funciones

- **En vivo** (nueva pestaña, con un punto que titila cuando hay torneo en curso): si no hay ningún torneo corriendo en este momento, muestra fecha y sede del próximo. Si hay uno en curso, muestra el estado "EN VIVO" y, a cada jugador logueado, su propio horario y cancha asignados apenas están cargados (o un aviso de que todavía no le tocó). Desde ahí el administrador entra directo a cargar resultados a medida que se van jugando los partidos, y esos resultados impactan al toque en el ranking de todos.
- **Categorías por torneo**: cada torneo puede abarcar una o varias categorías (ej: "de 2da a 8va"). Se elige al crearlo y se ve en la lista de torneos y en su detalle.
- **Ranking por eliminación directa**: al cargar el resultado de un partido de bracket, la pareja que **pierde** suma los puntos de la ronda en la que quedó eliminada (llegó hasta ahí). En la Final, el ganador suma los puntos de "Campeón" y el perdedor los de "Sub". Un partido de fase de grupos (o sin ronda asignada) no reparte puntos de ranking, solo cuenta como partido jugado.
- **Ranking por categoría**: en la pestaña Ranking, primero se elige Damas o Caballeros y recién ahí aparecen las pastillas de esas categorías (6ta, 5ta, etc.) — así entran todas, aunque haya muchas, sin que las tape el ancho de la pantalla. Se ve la tabla completa de esa categoría (sin cortar), con la foto de cada jugador al lado del nombre — más grande para el top 5. Se actualiza solo al cargar cada resultado, incluso en las pantallas de otros jugadores en vivo. La misma separación Damas/Caballeros se usa para elegir categoría en el perfil del jugador, al crear un torneo y en el panel de administrador.
- **3 formas de ver los partidos de un torneo** (pastillas arriba de la lista de partidos, en el detalle del torneo): **Lista** (como antes), **Calendario** (tabla con las canchas del torneo como columnas y cada horario como fila, para ver de un vistazo qué se juega dónde y cuándo) y **Llave** (cuadro de eliminación directa tipo "mata-mata", una columna por ronda — Dieciseisavos a Final — con el ganador de cada partido resaltado). La fase de grupos no aparece en la Llave porque no es de eliminación directa.
- **Armado automático**: "Armar parejas" empareja por nivel de ranking a quienes no eligieron pareja propia; "Armar partidos" cruza las parejas, busca un horario donde los 4 jugadores estén disponibles (según lo que cargaron en su perfil) y asigna una cancha libre, evitando choques.
- **Inicio**: arranca con un encabezado grande (estilo revista deportiva) con el eslogan del club y, si estás logueado, tu posición actual en el ranking de tu categoría. Debajo, el próximo torneo se destaca grande (nombre bien grande y en mayúscula) con su flyer de fondo, la jugadora y el jugador del mes lado a lado sobre una foto de cancha difuminada, y los campeones recientes.
- **Auspiciantes por torneo**: además de los generales (se ven en toda la app), un torneo puede tener sus propios auspiciantes — aparecen solo en el detalle de ese torneo, con el logo bien grande.
- **Notificaciones**: cuando a alguien le asignan un horario de partido, se carga un resultado en el que jugó, o una pareja lo anota a un torneo, le llega un aviso mientras tiene la app abierta o instalada. Push real con la app cerrada del todo (como WhatsApp) es un paso extra — avisame si lo querés y lo sumamos con claves VAPID y una Supabase Edge Function.
- **Publicidad**: los logos de sponsors aparecen en Inicio y, en pantallas grandes, en una columna fija al costado de toda la app. Ahí, si hay pocos sponsors cargados, sus logos se agrandan para aprovechar el espacio disponible en vez de quedar chicos con hueco vacío debajo.
- **Foto de perfil**: cada jugador puede subir su propia foto desde "Mi perfil". Aparece en su avatar, en la tarjeta de "Jugador del mes" y en "Campeones" (Inicio). "Campeones" se arma solo: en cuanto se carga el resultado de una Final, la pareja ganadora aparece ahí, sin que el admin tenga que cargar nada aparte.
- **Categorías separadas por género**: "6ta Damas" y "6ta Caballeros" son categorías distintas (con jugadores y ranking propios), no se mezclan.
- **Cuentas importadas del ranking histórico**: los jugadores del circuito 2026 que ya tenían puntos antes de la app se importaron con una cuenta y clave provisoria (ver carpeta `norte-padel-import`). La primera vez que entran, la app los frena con una pantalla obligatoria para elegir su propia contraseña antes de poder usar el resto de la app.
- **Perfil público de cada jugador**: tocando a cualquier jugador (en el Ranking, en "Jugador/a del mes" o en el nombre de un campeón en "Campeones") se abre su perfil con su foto más grande, su categoría, sus puntos, partidos jugados/ganados, efectividad, y la lista completa de los torneos que ganó (con quién los ganó y la fecha).

## 6. Seguridad

La base de datos quedó con permisos por rol de verdad (no solo ocultos en la interfaz): un jugador solo puede crear o editar su propia fila y su propia inscripción; crear torneos, complejos, cargar resultados o subir flyers/sponsors requiere estar en la tabla `admins`. Los emails y teléfonos de los jugadores no son visibles públicamente — el ranking y las listas públicas se arman con funciones que exponen solo nombre, categoría y puntos. La categoría oficial (`categoria`) tampoco la puede cambiar un jugador directo aunque manipule la app: hay una regla en la base de datos que revierte cualquier intento y solo la deja pasar si la cambia un administrador. El panel de administrador (pestaña de configuración ⚙️) solo se ve y se puede abrir si estás en la tabla `admins` — para cualquier otra persona, ni el botón aparece.

## 7. Velocidad

La base de datos tiene índices en todas las columnas por las que se filtra seguido (categoría, torneo, jugador, estado del partido, etc.) — sin esto, cada pantalla iba a ir recorriendo la tabla entera a medida que crezca la cantidad de jugadores y partidos, en vez de ir directo a lo que necesita. En la app se sacaron pedidos duplicados que se estaban haciendo de más en cada carga (la pantalla "En vivo" y los datos de la sesión se estaban pidiendo dos veces sin darse cuenta) y se juntaron en uno solo los pedidos que no dependían entre sí, para no esperar a que termine uno para recién arrancar el otro. Las fotos que están más abajo en la pantalla (sponsors, próximos torneos, avatares del ranking) se cargan solas recién cuando el jugador llega a esa parte, para no tener que bajar todas las fotos de una si nunca las llega a ver.

## Estructura de archivos

```
norte-padel/
├── index.html      → estructura de la app
├── style.css        → estilos (tema oscuro, mobile-first + escritorio)
├── app.js            → lógica: auth, ranking, torneos, partidos, admin, notificaciones
├── matching.js       → algoritmo de armado automático de parejas/partidos/horarios
├── config.js         → tus claves de Supabase (completar)
├── manifest.json      → metadata de instalación como app
├── sw.js               → service worker (offline + push)
├── schema.sql          → script para crear toda la base de datos, roles y seguridad en Supabase
├── hero-cancha.jpg      → foto de fondo del encabezado de Inicio
├── energia-pelota.jpg    → foto de fondo de la banda "Sentí la verdadera energía del pádel"
├── destacados-fondo.jpg  → foto de fondo (difuminada) de la banda "Jugadores del mes"
├── icon-192.png          → ícono de la app
├── icon-512.png          → ícono de la app (versión grande)
└── icon-512-maskable.png → ícono de la app (versión "maskable", para Android)
```

> Todos los archivos van sueltos, al mismo nivel — ya no hay ninguna subcarpeta (ni `icons/` ni `fotos/`). Es a propósito: al subir arrastrando a GitHub o Netlify, si arrastrás archivos sueltos en vez de una carpeta completa, las subcarpetas a veces no se crean y las imágenes quedan rotas. Con todo plano, ese problema no puede pasar — subís los archivos que sean (todos juntos, sin armar carpetas) y listo.
