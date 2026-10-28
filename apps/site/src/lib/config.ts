import { base } from "$app/paths";
import * as publicEnv from "$env/static/public";

const env = publicEnv as Record<string, string>;
export const repository = "https://github.com/guen-efanunji/loom";
export const sitePath = (path = "/") => `${base}${path}`;
export const installCommands = {
	unix: `curl -fsSL ${env.PUBLIC_INSTALL_BASE || "https://loomworkspace.bond"}/install.sh | sh`,
	windows: `irm ${env.PUBLIC_INSTALL_BASE || "https://loomworkspace.bond"}/install.ps1 | iex`,
};
