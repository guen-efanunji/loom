import { base } from "$app/paths";
import * as publicEnv from "$env/static/public";
const env = publicEnv as Record<string, string>;
export const repository = "https://github.com/MrPinguiiin/loom";
export const sitePath = (path = "/") => `${base}${path}`;
export const installCommands = {
  unix: `curl -fsSL ${env.PUBLIC_INSTALL_BASE || "https://raw.githubusercontent.com/MrPinguiiin/loom/main"}/install.sh | sh`,
  windows: `irm ${env.PUBLIC_INSTALL_BASE || "https://raw.githubusercontent.com/MrPinguiiin/loom/main"}/install.ps1 | iex`,
};
