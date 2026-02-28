# Evaluacion completa de Shiro para autonomia operativa

## Objetivo evaluado

Este documento evalua si Shiro cumple el objetivo de ser un agente autonomo que:

- Controle la PC de forma segura.
- Tenga un espacio de trabajo operativo para crear codigo y ejecutar tareas solicitadas.
- Mantenga continuidad de contexto y memoria.
- Pueda intervenir ante loops o errores sin degradar seguridad.

Estado actual: **parcial**. La base tecnica existe, pero todavia no alcanza autonomia plena ni control seguro de extremo a extremo.

## Errores y brechas detectadas

### [x] ERR-01 - Agente principal en modo solo texto

El flujo principal fuerza contexto en `textOnly` y responde sin tool-calling en modo normal.
Impacto: no hay ejecucion autonoma real en la ruta principal.

### [x] ERR-02 - Planner y ejecucion de herramientas no activos por defecto

Los entrypoints principales usan `usePlanner: false`.
Impacto: la arquitectura Planner/Executor existe, pero no se usa para operar en produccion.

### [x] ERR-03 - Seleccion de herramientas en UI sin enforcement real en backend

La UI permite seleccionar herramientas, pero backend no aplica esa seleccion como politica dura.
Impacto: control de permisos inconsistente y potencial falsa sensacion de seguridad.

### [x] ERR-04 - Perdida de historial real en `/api/chat`

El backend termina usando principalmente el ultimo mensaje para ejecutar el agente.
Impacto: continuidad conversacional limitada y peores decisiones en tareas largas.

### ERR-05 - Memoria compartida global entre sesiones

Hay una instancia de memoria compartida en servidor para distintas conversaciones.
Impacto: contaminacion de contexto entre sesiones/canales.

### ERR-06 - Riesgo de escape de ruta en herramientas de workspace

La validacion de rutas por prefijo puede ser insuficiente en casos de borde.
Impacto: posible acceso fuera del directorio esperado.

### ERR-07 - Sin limite de tamano de body HTTP

La lectura de body no corta por tamano maximo.
Impacto: riesgo de degradacion o caida por requests grandes.

### ERR-08 - Deteccion de loops desalineada con eventos reales

El detector espera ciertos campos (`name`) y en otras rutas se registra `step`.
Impacto: falsos positivos/negativos al intervenir.

### ERR-09 - Endpoints sensibles sin autenticacion

Rutas de control operativo (como WhatsApp) no tienen auth fuerte.
Impacto: riesgo si el servicio se expone fuera de localhost.

### ERR-10 - Control de PC limitado a operaciones de archivos

No hay una capa robusta para procesos, comandos o acciones avanzadas con permisos.
Impacto: autonomia incompleta para "controlar la PC" de forma util y segura.

### ERR-11 - Cobertura de pruebas insuficiente para autonomia

Hay pruebas unitarias base, pero falta cobertura integral en permisos, aislamiento y ejecucion autonoma.
Impacto: mayor riesgo de regresiones en cambios de autonomia.

### ERR-12 - Falta de matriz de autorizacion por nivel de riesgo

No existe una politica unificada y ejecutable para acciones segun criticidad.
Impacto: decisiones de seguridad dispersas o ambiguas.

### ERR-13 - Falta README operativo del proyecto

No hay una guia principal consolidada de arranque, ejecucion, arquitectura y limites.
Impacto: mantenimiento y onboarding mas costosos.

### ERR-14 - Inconsistencia de naming en documentacion

Referencias mixtas entre `AGENTS.md` y `AGENTS.MD`.
Impacto: fragilidad en entornos sensibles a mayusculas/minusculas.

### ERR-15 - Documento de plan desactualizado respecto al estado real

El plan historico no refleja claramente que ya se implemento y que falta.
Impacto: confusion en prioridades y alcance tecnico.

### ERR-16 - Falta documento formal de permisos del agente

No hay un documento operativo que delimite acciones permitidas y confirmaciones.
Impacto: riesgo al escalar autonomia.

### ERR-17 - Falta runbook operativo y de recuperacion

No hay una guia de incidentes para loops, puertos, vLLM, sesion WA o corrupcion de estado.
Impacto: recuperacion manual lenta ante fallas.

## Mejoras y acciones recomendadas

### ACT-01 - Activar modo autonomo real en backend

Agregar modo configurable (seguro por defecto) que habilite planner + tools.

### ACT-02 - Enforcement de herramientas en servidor

Aplicar lista de herramientas permitidas por sesion/request en backend, no solo en prompt/UI.

### ACT-03 - Aislamiento de memoria por sesion/canal

Instanciar memoria por `sessionId` (web) y por chat-id (WA).

### ACT-04 - Usar historial conversacional real en ejecucion

Construir contexto con historial o ventana resumida, no solo ultimo mensaje.

### ACT-05 - Endurecer sandbox de rutas

Usar validacion por frontera de directorio y rutas normalizadas para bloquear traversal.

### ACT-06 - Limites operativos en API HTTP

Agregar limite de body, timeouts y rate limiting basico.

### ACT-07 - Seguridad minima para control remoto

Token de autenticacion, CORS restringido y binding local por defecto.

### ACT-08 - Flujo completo plan -> ejecutar -> verificar

Integrar de forma real `Planner`, `Executor` y `Verifier` con reglas de parada.

### ACT-09 - Roadmap por fases para control de PC

Fase 1: archivos/workspace.
Fase 2: comandos permitidos.
Fase 3: procesos y servicios.
Fase 4: automatizacion adicional con permisos.

### ACT-10 - Trazabilidad completa por ejecucion

Logs estructurados por run/session/tool con resultado y causa.

### ACT-11 - Suite de pruebas orientada a autonomia

Cobertura de permisos, aislamiento, limites, fallbacks y escenarios de error.

### ACT-12 - Politica formal por riesgo

Definir acciones permitidas, bloqueadas y con confirmacion obligatoria.

### ACT-13 - Crear README operativo

Comandos, arquitectura, variables, troubleshooting y alcance de autonomia.

### ACT-14 - Unificar naming documental

Estandarizar referencias y nombres de archivos Markdown.

### ACT-15 - Separar documento historico de arquitectura vigente

Mantener plan historico como archivo aparte y publicar estado actual en docs.

### ACT-16 - Crear `docs/permissions.md`

Matriz de permisos y niveles de confirmacion por tipo de accion.

### ACT-17 - Crear `docs/runbook.md`

Procedimientos de recuperacion rapida y diagnostico operativo.

## Priorizacion de ejecucion sugerida

### Bloque 1 (critico)

- ACT-01
- ACT-02
- ACT-03
- ACT-04
- ACT-05
- ACT-06

### Bloque 2 (seguridad y robustez)

- ACT-07
- ACT-08
- ACT-10
- ACT-11
- ACT-12

### Bloque 3 (documentacion y operacion)

- ACT-13
- ACT-14
- ACT-15
- ACT-16
- ACT-17

## Criterio de salida para considerar a Shiro "autonomo operativo"

Shiro se considera autonomo operativo cuando:

- Ejecuta herramientas en flujo principal bajo politicas activas de permisos.
- Mantiene memoria aislada y continuidad real por sesion.
- Soporta tareas multi-paso con verificacion y corte de loops confiable.
- Tiene seguridad base aplicada en API y acciones de alto riesgo.
- Dispone de documentacion operativa vigente para uso y recuperacion.
