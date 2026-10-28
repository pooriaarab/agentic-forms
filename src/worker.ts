import { createApp } from "./app.js";

// One in-memory store per isolate until a D1 adapter ships. Data is lost on restart.
const app = createApp();

export default { fetch: app.fetch };
