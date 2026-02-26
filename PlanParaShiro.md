# Objetivo Para mejorar el agente Shiro
Quiero refactorizar el agente Shiro (TypeScript) a una arquitectura PRO: SOUL centralizado, MEMORY con compresión/summarization y HEALTH como controlador anti-loops, con separación Planner/Executor, presupuesto de tokens, y herramientas (tools) bien tipadas y validadas.

## Contexto actual (archivos existentes)
Tenemos al menos:
- index.ts (orquestador)
- server.ts (API)
- vllm.ts (cliente LLM)
- tools.ts (tools del agente)
- store.ts (persistencia/estado)
- workspace.ts (entorno)
- tui.ts (interfaz terminal)
- config.ts
- greet.ts
- health.ts

## Resultado esperado
1) Nueva estructura de carpetas PRO (ver abajo).
2) SOUL centralizado en un solo módulo (system prompt + reglas + estilo + políticas).
3) MEMORY con:
   - memoria de corto plazo (rolling window)
   - memoria de largo plazo (resúmenes)
   - compresión automática por “token budget”
   - eventos estructurados (acciones, tool calls, observaciones, errores)
4) HEALTH que NO solo observa: debe intervenir.
   - loop detection (repetición de acciones/errores)
   - circuit breaker (corta o cambia estrategia)
   - retry policy (backoff + límite)
   - safe-mode (reduce tools o fuerza “ask user”)
5) Separación Planner/Executor:
   - Planner decide el plan de pasos (alto nivel)
   - Executor ejecuta 1 paso usando tools y devuelve observación
   - Critic/Verifier opcional: valida si se cumplió el objetivo
6) Tools:
   - schema/typing estricto (zod o similar)
   - validación de inputs
   - logs consistentes (telemetría)
7) Token budgeting:
   - function `buildContext()` que arma el prompt con presupuesto dinámico
   - prioridad: SOUL > goal > short memory > tool context > long memory
   - truncado inteligente + resumen automático
8) Pruebas mínimas (unit tests) para:
   - memory summarizer
   - loop detection
   - buildContext token budget
9) Documentación:
   - README “Cómo corre”
   - Diagrama simple del flujo del agente

## Nueva estructura propuesta (debes implementarla)
src/
  core/
    agent/
      Agent.ts                 # loop principal
      Planner.ts               # planning
      Executor.ts              # ejecución con tools
      ContextBuilder.ts        # token budget + armado de prompt
      Types.ts                 # tipos compartidos (Message, Event, Step, ToolResult)
      Verifier.ts              # (opcional) valida completion
    soul/
      soul.ts                  # system prompt + reglas + estilo + constraints
      policies.ts              # políticas (seguridad, límites, stop conditions)
    memory/
      MemoryStore.ts           # interfaz
      MemoryManager.ts         # short/long memory + compresión
      Summarizer.ts            # resume memoria
      serializers.ts           # convertir Events a messages
    health/
      HealthManager.ts         # estado y acciones correctivas
      LoopDetector.ts          # detecta patrones de repetición
      RetryPolicy.ts
      metrics.ts               # counters
    llm/
      LLMClient.ts             # interfaz
      vllmClient.ts            # implementación actual (mover vllm.ts acá)
    tools/
      ToolRegistry.ts
      schemas.ts               # zod schemas
      tools.ts                 # tools existentes migradas
  interfaces/
    tui/
      tui.ts                   # mover tui.ts
    api/
      server.ts                # mover server.ts
  config/
    config.ts                  # mover config.ts
  index.ts                     # bootstrap

## Reglas de implementación (importante)
- No rompas el funcionamiento actual: deja un modo “compatibilidad” si hace falta.
- Mantén TypeScript estricto, sin any.
- Cada módulo debe tener responsabilidad única.
- Logging: usa un logger único (pino/winston o simple console wrapper) con niveles.
- Los eventos del agente deben ser estructurados:
  - type: "plan" | "tool_call" | "observation" | "error" | "summary" | "decision"
  - timestamp, runId, stepId, payload
- ContextBuilder debe recibir:
  - goal/usuario
  - SOUL
  - tools manifest (descripción compacta)
  - short memory (últimos N eventos)
  - long memory (resumen)
  - health state (si está en safe-mode, etc.)
  - tokenBudget (ej: 8k, 16k configurable)
- Summarizer:
  - resume cuando se excede budget o cada X eventos
  - produce: “LongTermSummary” + “KeyFacts” + “OpenTasks”
- LoopDetector:
  - detecta repetición de misma tool/action >= 3
  - detecta mismo error consecutivo >= 2
  - detecta “no progreso” (mismo estado) >= 3
  - Acciones: cambiar estrategia, pedir input al usuario, reset parcial de contexto

## Entregables
A) Implementa la estructura de carpetas y mueve/refactoriza los archivos existentes.
B) Crea el SOUL centralizado: `src/core/soul/soul.ts`
   - Debe definir: identidad del agente, objetivos, estilo, límites, stop conditions.
C) Implementa MemoryManager + Summarizer + ContextBuilder + HealthManager.
D) Ajusta Agent.ts para usar Planner/Executor y respetar token budget.
E) Añade tests y README.

## Criterios de aceptación
- El proyecto compila.
- Se puede correr por TUI y/o API.
- El agente mantiene continuidad (usa short + long memory).
- No se infla sin control: token budget se respeta.
- Si se repite en loops, HealthManager interviene y se ve en logs.
- SOUL se aplica siempre y es fácil de editar.

## Paso a paso que debes seguir (importante)
1) Crear nueva estructura (carpetas y skeleton).
2) Migrar vllm.ts -> core/llm/vllmClient.ts y definir interfaz LLMClient.
3) Migrar tools.ts -> core/tools; registrar tools con schemas.
4) Implementar eventos y MemoryManager.
5) Implementar Summarizer (aunque sea simple al inicio).
6) Implementar ContextBuilder con presupuesto.
7) Implementar HealthManager + LoopDetector.
8) Implementar Planner/Executor y conectar todo.
9) Añadir tests.
10) Actualizar README con run commands.

## Notas
- Si hay partes que no puedes completar por falta de info, deja TODOs claros, pero NO inventes APIs inexistentes.
- Prefiero código simple, robusto y mantenible antes que “muy fancy”.

Ahora genera el código y refactor completo.

despues
Modo “Runs”: guardar cada ejecución en runs/<runId>.jsonl (event log) para debug.

Memory embeddings (largo plazo real): más adelante metes vector store, pero ahora deja la interfaz lista.

Tool permissions: HEALTH puede desactivar tools peligrosas en safe-mode.