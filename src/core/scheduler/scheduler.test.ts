import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSchedule, nextRunAfter, parseSchedule } from "./schedule.js";
import {
	createCronTask,
	deleteCronTask,
	getCronTask,
	initCronScheduler,
	listCronTasks,
	runCronTask,
	runDueTasks,
	stopCronScheduler,
	toggleCronTask,
	type CronTask,
} from "./CronService.js";

const HOUR = 3_600_000;

test("intervalos", () => {
	assert.deepEqual(parseSchedule("30 minutos"), { kind: "interval", ms: 30 * 60_000 });
	assert.deepEqual(parseSchedule("cada 2 horas"), { kind: "interval", ms: 2 * HOUR });
	assert.deepEqual(parseSchedule("cada hora"), { kind: "interval", ms: HOUR });
	assert.deepEqual(parseSchedule("1 día"), { kind: "interval", ms: 24 * HOUR });
	assert.throws(() => parseSchedule("1 minuto"), /5 minutos/);
});

test("hora fija y días", () => {
	assert.deepEqual(parseSchedule("cada día 08:00"), { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], hour: 8, minute: 0 });
	assert.deepEqual(parseSchedule("todos los días a las 8"), { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], hour: 8, minute: 0 });
	assert.deepEqual(parseSchedule("Lunes a Viernes 9:30"), { kind: "weekly", days: [1, 2, 3, 4, 5], hour: 9, minute: 30 });
	assert.deepEqual(parseSchedule("viernes a las 18:00"), { kind: "weekly", days: [5], hour: 18, minute: 0 });
	assert.deepEqual(parseSchedule("lunes y jueves a las 7 pm"), { kind: "weekly", days: [1, 4], hour: 19, minute: 0 });
	assert.deepEqual(parseSchedule("sábados a las 8 de la noche"), { kind: "weekly", days: [6], hour: 20, minute: 0 });
	assert.deepEqual(parseSchedule("fines de semana 10:00"), { kind: "weekly", days: [0, 6], hour: 10, minute: 0 });
	assert.deepEqual(parseSchedule("miércoles 7.15"), { kind: "weekly", days: [3], hour: 7, minute: 15 });
	assert.deepEqual(parseSchedule("viernes a lunes 6:00"), { kind: "weekly", days: [0, 1, 5, 6], hour: 6, minute: 0 });
	assert.throws(() => parseSchedule("los viernes"), /No entendí/);
	assert.throws(() => parseSchedule("25:00"), /No entendí/);
	assert.throws(() => parseSchedule(""), /Falta el horario/);
});

test("próxima vez", () => {
	// Miércoles 12 de noviembre de 2025, 10:00 (hora local).
	const wed10 = new Date(2025, 10, 12, 10, 0);
	const at = (s: string) => nextRunAfter(parseSchedule(s), wed10);
	assert.deepEqual(at("cada día 08:00"), new Date(2025, 10, 13, 8, 0));
	assert.deepEqual(at("cada día 11:00"), new Date(2025, 10, 12, 11, 0));
	assert.deepEqual(at("cada día 10:00"), new Date(2025, 10, 13, 10, 0)); // la misma hora no: la siguiente
	assert.deepEqual(at("viernes 18:00"), new Date(2025, 10, 14, 18, 0));
	assert.deepEqual(at("miércoles 9:00"), new Date(2025, 10, 19, 9, 0));
	assert.deepEqual(at("cada 2 horas"), new Date(wed10.getTime() + 2 * HOUR));
});

test("horario en palabras", () => {
	assert.equal(describeSchedule(parseSchedule("cada día 8:00")), "todos los días a las 08:00");
	assert.equal(describeSchedule(parseSchedule("lunes a viernes 9:30")), "de lunes a viernes a las 09:30");
	assert.equal(describeSchedule(parseSchedule("domingo y lunes 7:00")), "los lunes y domingo a las 07:00");
	assert.equal(describeSchedule(parseSchedule("cada 2 horas")), "cada 2 horas");
	assert.equal(describeSchedule(parseSchedule("90 minutos")), "cada 90 minutos");
});

test("crear, pausar, reanudar y borrar", () => {
	const task = createCronTask({ name: "Noticias", expression: "cada día 08:00", action: "agent", payload: { prompt: "Resume" } });
	assert.equal(task.deliver, "both");
	assert.ok(task.nextRun && new Date(task.nextRun).getTime() > Date.now());
	assert.throws(() => createCronTask({ name: "x", expression: "cada día 8:00", action: "agent", payload: {} }), /prompt/);
	assert.throws(() => createCronTask({ name: "x", expression: "algún día", action: "notify", payload: {} }), /No entendí/);

	toggleCronTask(task.id, false);
	assert.equal(getCronTask(task.id)?.enabled, false);
	toggleCronTask(task.id, true);
	assert.equal(getCronTask(task.id)?.enabled, true);
	assert.ok(deleteCronTask(task.id));
	assert.equal(getCronTask(task.id), undefined);
});

test("el reloj corre lo que tocaba una sola vez y agenda la próxima", async () => {
	const ran: CronTask[] = [];
	initCronScheduler(async (t) => {
		ran.push(t);
		return { result: `hecho ${t.name}` };
	});
	stopCronScheduler(); // las pruebas mueven el reloj a mano
	const task = createCronTask({ name: "Aviso", expression: "cada día 08:00", action: "notify", payload: { message: "hola" } });
	const paused = createCronTask({ name: "Pausada", expression: "cada día 08:00", action: "notify", payload: { message: "x" } });
	toggleCronTask(paused.id, false);

	// Aku estuvo apagado tres días: corre una vez, no tres.
	const later = new Date(new Date(task.nextRun!).getTime() + 3 * 24 * HOUR + 60_000);
	assert.deepEqual(runDueTasks(later), [task.id]);
	assert.deepEqual(runDueTasks(later), []);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(ran.length, 1);
	const saved = getCronTask(task.id)!;
	assert.equal(saved.lastResult, "hecho Aviso");
	assert.ok(new Date(saved.nextRun!).getTime() > later.getTime());

	for (const t of listCronTasks()) deleteCronTask(t.id);
});

test("un error de la tarea queda guardado", async () => {
	initCronScheduler(async () => ({ result: "texto", error: "Telegram no está conectado" }));
	stopCronScheduler();
	const task = createCronTask({ name: "Falla", expression: "cada 2 horas", action: "notify", payload: { message: "x" } });
	const after = await runCronTask(task.id);
	assert.equal(after.lastError, "Telegram no está conectado");
	assert.ok(after.lastRun);
	deleteCronTask(task.id);
});
