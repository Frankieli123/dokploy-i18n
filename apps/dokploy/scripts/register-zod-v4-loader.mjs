import { register } from "node:module";

register(new URL("./zod-v4-loader.mjs", import.meta.url).href, import.meta.url);
