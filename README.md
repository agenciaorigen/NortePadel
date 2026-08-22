# Norte Padel — App instalable (PWA)

App para tu organización de torneos: ranking automático por categoría, jugadores que se registran e inscriben solos, armado automático de partidos, resultados en vivo, complejos/canchas reasignables, flyers, jugador del mes y espacio de sponsors.

Está hecha en HTML/CSS/JS puro (sin frameworks) + [Supabase](https://supabase.com) como base de datos y sistema de login en la nube. Así cualquier jugador que entra ve el mismo ranking y los mismos partidos en tiempo real, desde cualquier celular o computadora.

## 1. Crear el backend (10 minutos, gratis)

1. Andá a [supabase.com](https://supabase.com), creá una cuenta gratis y un proyecto nuevo (elegí una región cercana, ej: São Paulo).
2. Cuando el proyecto esté listo, andá a **SQL Editor > New query**, pegá **todo** el contenido del archivo `schema.sql` y ejecutalo. Esto crea todas las tablas, el ranking automático, las reglas de seguridad y los buckets de flyers/sponsors.
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
- Crean los **torneos** (desde la pestaña Torneos, ahí aparece el formulario) eligiendo el complejo sede, categoría, fechas y puntos — y pueden subir el flyer ahí mismo, que aparece automáticamente en Inicio.
- Desde el detalle de un torneo: agregan/cambian canchas (por clima u otro motivo), inscriben jugadores manualmente si hace falta, arman las parejas y los partidos con un clic, cargan resultados y reasignan canchas.
- Eligen al **jugador del mes** desde el panel de administrador.
- Suben los logos de **auspiciantes/publicidad**.

**Jugadores**: se registran ellos mismos (Mi perfil > Crear cuenta), completan su categoría, nivel y en qué días/horarios pueden jugar, y desde ahí ya está — para anotarse a un torneo entran a la pestaña Torneos, tocan el que quieren y tocan **"Inscribirme"**. Un solo toque: la app ya sabe con qué horarios cuentan porque los cargaron en su perfil. Pueden editar sus datos y horarios cuando quieran desde Mi perfil.

## 5. El resto de las funciones

- **Ranking por categoría**: en la pestaña Ranking, con pastillas para elegir la categoría (6ta, 5ta, Damas, etc.). Se actualiza solo al cargar cada resultado, incluso en las pantallas de otros jugadores en vivo.
- **Armado automático**: "Armar parejas" empareja por nivel de ranking; "Armar partidos" cruza las parejas, busca un horario donde los 4 jugadores estén disponibles (según lo que cargaron en su perfil) y asigna una cancha libre, evitando choques.
- **Inicio**: muestra los flyers de los próximos torneos y, si hay uno cargado, el jugador del mes.
- **Notificaciones**: cuando a alguien le asignan un horario de partido o se carga un resultado en el que jugó, le llega un aviso mientras tiene la app abierta o instalada. Push real con la app cerrada del todo (como WhatsApp) es un paso extra — avisame si lo querés y lo sumamos con claves VAPID y una Supabase Edge Function.
- **Publicidad**: los logos de sponsors aparecen en Inicio y, en pantallas grandes, en una columna fija al costado de toda la app.

## 6. Seguridad

La base de datos quedó con permisos por rol de verdad (no solo ocultos en la interfaz): un jugador solo puede crear o editar su propia fila y su propia inscripción; crear torneos, complejos, cargar resultados o subir flyers/sponsors requiere estar en la tabla `admins`. Los emails y teléfonos de los jugadores no son visibles públicamente — el ranking y las listas públicas se arman con funciones que exponen solo nombre, categoría y puntos.

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
└── icons/               → íconos de la app
```
