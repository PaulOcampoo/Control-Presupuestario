Objective:
Agregar la misma quinta paleta "Tema Azul" (Azul Zafiro, `#2563EB`) al selector de apariencia de App-CP (la app original, producto real para Grupo Roforb) — replicando el cambio ya hecho en la demo, adaptado a la estructura real de App-CP si difiere.

⚠️ Contexto de riesgo: este es el producto real de un cliente activo (Grupo Roforb), no la demo. Aplicar el mismo nivel de cautela que en cualquier cambio a este repo — verificar dos veces antes de commitear, y NO hacer push/deploy sin que el usuario lo revise explícitamente primero.

Starting State:
- App-CP ya tiene 4 paletas propias (dorada/morada/verde/naranja), confirmadas en la auditoría de la sesión anterior como las mismas 4 que la demo (Dorado/NYRA/Jade/Terra) — pero verificar si el mecanismo interno (nombres de variables CSS, componente del selector, manejo de `brand_config` si App-CP tiene un sistema equivalente) es idéntico al de la demo o tiene diferencias propias antes de asumir que el mismo prompt aplica sin ajustes.
- Color base para la nueva paleta: Azul Zafiro, `#2563EB` (mismo valor usado en la demo, para consistencia entre ambos productos).
- Ya se implementó el mismo cambio en la demo (repo hermano `../` respecto a App-CP, o la ruta que corresponda) — se puede usar como referencia de qué se hizo ahí, pero confirmando que la estructura de App-CP es análoga antes de copiar literalmente.

Target State:
1. Confirmar la estructura real de paletas en App-CP (leer el código, no asumir que es idéntica a la demo solo porque comparten las mismas 4 paletas).
2. Definir las CSS custom properties de "Tema Azul" siguiendo el mismo patrón que las paletas existentes de App-CP, usando `#2563EB` como color base (con su derivado, si el patrón existente deriva un segundo tono).
3. Agregar "Tema Azul" como quinta opción en el selector de apariencia de App-CP, con su swatch.
4. Si App-CP tiene un mecanismo de brand config propio (o algo análogo a `brand_config` de la demo) que pudiera interferir con las paletas, aplicar el mismo cuidado de aislamiento ya usado en la demo — pero solo si ese mecanismo existe ahí; no inventar uno si App-CP no lo tiene.
5. Verificar manualmente que seleccionar "Tema Azul" funciona correctamente y no rompe las 4 paletas existentes.

Allowed Actions:
- Leer y modificar el código de paletas/selector de apariencia de App-CP.
- Verificar el cambio localmente.
- Dejar el cambio como commit local, SIN push.

Forbidden Actions:
- NO modificar las 4 paletas existentes de App-CP ni ningún otro módulo no relacionado.
- NO hacer push ni deploy — este cambio debe quedar como commit local para que el usuario lo revise explícitamente antes de subirlo a producción real de Grupo Roforb.
- NO tocar la demo (`Control-Presupuestario`) desde este prompt — ese cambio ya se hizo por separado.
- NO asumir que la estructura interna de App-CP es idéntica a la de la demo sin confirmarlo primero — son repos que divergieron, y App-CP es la fuente original, no al revés.

Stop Conditions:
- Si App-CP tiene una arquitectura de theming notablemente distinta a la de la demo (por ejemplo, si las paletas no son solo CSS custom properties sino que dependen de configuración por cliente/tenant real de Grupo Roforb) — detenerse y describir la diferencia antes de aplicar cualquier cambio, dado que este es software en uso real.
- Si tocar el selector de apariencia requiere modificar algo compartido con lógica de negocio real de Grupo Roforb (no solo presentación) — pausar y preguntar.

Checkpoints:
✅ Estructura real de App-CP confirmada antes de escribir código.
✅ "Tema Azul" agregado y funcionando en App-CP, con el mismo color `#2563EB` usado en la demo.
✅ Las 4 paletas existentes de App-CP siguen funcionando sin cambios.
✅ Commit local claro y acotado, SIN push — pendiente de revisión explícita del usuario antes de subir a producción real.
