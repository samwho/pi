import { resolve } from "node:path";
import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";

const WORKSPACE_ROOT = "/workspace";

export default function (pi: ExtensionAPI) {
	pi.on("project_trust", (event): ProjectTrustEventResult => {
		const cwd = resolve(event.cwd);
		if (cwd === WORKSPACE_ROOT || cwd.startsWith(`${WORKSPACE_ROOT}/`)) {
			return { trusted: "yes" };
		}
		return { trusted: "undecided" };
	});
}
