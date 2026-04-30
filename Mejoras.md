SHIRO v2 — Especificación clara (para Cursor)
🎯 Objetivo

Construir un agente modular con memoria, tools y planificación, capaz de ejecutar tareas reales.

🏗️ 1. Arquitectura (esto es ley)
shiro/
│
├── core/
│   ├── agent.py
│   ├── planner.py
│   ├── executor.py
│
├── brain/
│   ├── prompts.py
│   ├── reasoning.py
│
├── memory/
│   ├── short_term.py
│   ├── long_term.py
│
├── tools/
│   ├── base.py
│   ├── web_search.py
│   ├── file_tool.py
│   ├── code_exec.py
│
├── api/
│   ├── server.py
│
├── config/
│   ├── settings.py
│
└── main.py

👉 Si no respetas esto, en 2 semanas tu código será un desastre.

🔁 2. Loop del agente (el corazón)
class Agent:
    def __init__(self, llm, memory, tools):
        self.llm = llm
        self.memory = memory
        self.tools = tools

    def run(self, user_input):
        state = self.memory.load()

        goal = self.llm.generate_goal(user_input)

        while True:
            plan = self.llm.plan(goal, state)
            action = self.select_tool(plan)

            result = action.execute(plan)

            state.update(result)
            self.memory.save(state)

            if self.is_done(result):
                return result

👉 Esto es lo que convierte tu proyecto en “agente” y no en chatbot glorificado.

🧠 3. Planner (cerebro real)
class Planner:
    def __init__(self, llm):
        self.llm = llm

    def create_plan(self, goal, context):
        prompt = f"""
        Goal: {goal}
        Context: {context}

        Divide this into steps and decide which tool to use.

        Output JSON:
        {{
          "steps": [
            {{"tool": "...", "action": "..."}}
          ]
        }}
        """
        return self.llm(prompt)
🧩 4. Sistema de Tools (modular o muere)
base.py
class Tool:
    name = "base"

    def execute(self, input_data):
        raise NotImplementedError
ejemplo: file_tool.py
from tools.base import Tool

class FileTool(Tool):
    name = "file"

    def execute(self, input_data):
        with open(input_data["path"], "r") as f:
            return f.read()
🧠 5. Memoria
short_term.py
class ShortTermMemory:
    def __init__(self):
        self.buffer = []

    def add(self, message):
        self.buffer.append(message)

    def get(self):
        return self.buffer[-10:]
long_term.py (usa Supabase o vector DB)
class LongTermMemory:
    def __init__(self, vector_db):
        self.db = vector_db

    def store(self, text):
        self.db.insert(text)

    def retrieve(self, query):
        return self.db.search(query)
⚙️ 6. Executor (ejecución controlada)
class Executor:
    def __init__(self, tools):
        self.tools = {tool.name: tool for tool in tools}

    def run(self, step):
        tool = self.tools.get(step["tool"])
        if not tool:
            return "Tool not found"

        return tool.execute(step)
🔐 7. Seguridad (no lo ignores)

Implementa mínimo:

def sanitize_input(user_input):
    banned = ["rm -rf", "exec(", "__import__"]
    for b in banned:
        if b in user_input:
            raise Exception("Blocked input")
    return user_input

👉 Luego mejoras con sandbox real.

🌐 8. API (para que no sea inútil)
server.py
from fastapi import FastAPI
from core.agent import Agent

app = FastAPI()
agent = Agent(...)

@app.post("/chat")
def chat(input: str):
    return {"response": agent.run(input)}
🧠 9. Prompts (esto define tu agente)
prompts.py
SYSTEM_PROMPT = """
You are Shiro, an autonomous AI agent.

Rules:
- Always think step by step
- Use tools when necessary
- Do not hallucinate tools
- Return structured outputs
"""
🚀 10. main.py
from core.agent import Agent
from tools.file_tool import FileTool

agent = Agent(
    llm=YourLLM(),
    memory=YourMemory(),
    tools=[FileTool()]
)

print(agent.run("Analyze this file"))
💥 11. Mejoras que debes implementar después

Prioridad real (no te distraigas):

✅ Tool: ejecución de Python sandbox
✅ Tool: requests HTTP
✅ Memoria con embeddings
✅ Logging de decisiones del agente
✅ Sistema de roles (modo hacker, analista, dev)
🧠 Mentalidad (esto te lo digo claro)

Si haces esto bien:

👉 puedes convertir Shiro en:

agente de pentesting básico
analista de logs
automatizador de tareas

Si no:
👉 será otro repo muerto con estrellas falsas

⚡ Siguiente paso (si quieres subir de nivel)

Te puedo armar:

👉 integración directa con:

Ollama (local)
o API tipo Opencode