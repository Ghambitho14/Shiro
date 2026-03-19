// Tools de Web
export { fetchUrlTool, executeFetchUrl } from "./fetch.js";
export { searchWebTool, executeSearchWeb } from "./search.js";

// Tools de Utilidades
export { getWeatherTool, executeGetWeather } from "./weather.js";
export { calculatorTool, executeCalculator } from "./calculator.js";
export { getTimeTool, executeGetTime } from "./time.js";

// Auto-import de canales
import "./channels/channel_list.js";
import "./channels/channel_create.js";
import "./channels/channel_start.js";
import "./channels/channel_delete.js";

// Auto-import de self
import "./self/self_analyze.js";
import "./self/self_reflect.js";

// Auto-import de cron
import "./cron/cron_create.js";
import "./cron/cron_list.js";
import "./cron/cron_delete.js";
import "./cron/cron_toggle.js";

// Auto-import de meta
import "./meta/ask_user.js";
import "./meta/project_analyze.js";
import "./meta/self_modify.js";
import "./meta/git.js";

export { askUserTool } from "./meta/ask_user.js";
export { projectAnalyzeTool } from "./meta/project_analyze.js";
export { selfModifyTool } from "./meta/self_modify.js";
export { gitTool } from "./meta/git.js";
