import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const projectRoot = process.cwd();
const routerDirectory = path.join(projectRoot, "src", "app");
const typesDirectory = path.join(projectRoot, ".expo", "types");

// Expo normally runs this generator from the Metro server. Set the same root
// before importing expo-router so its headless generator sees this app's routes.
process.env.EXPO_ROUTER_APP_ROOT = routerDirectory;

const require = createRequire(import.meta.url);
const { regenerateDeclarations } = require("expo-router/build/typed-routes");

fs.mkdirSync(typesDirectory, { recursive: true });
regenerateDeclarations(typesDirectory);

// regenerateDeclarations is debounced by expo-router and does not return a
// promise. Keep this process alive until the write has completed.
await new Promise((resolve) => setTimeout(resolve, 1_100));

const declarationPath = path.join(typesDirectory, "router.d.ts");
const declaration = fs.readFileSync(declarationPath, "utf8");
const pluginSettingsRoute = "/settings/hosts/[serverId]/plugins/[pluginId]/[screenId]";

if (!declaration.includes(pluginSettingsRoute)) {
  throw new Error(`Generated route declaration is missing ${pluginSettingsRoute}`);
}
