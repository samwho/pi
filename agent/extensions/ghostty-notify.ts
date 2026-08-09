import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function notify(message: string) {
  // OSC 777: desktop notification. BEL terminates the escape sequence.
  process.stdout.write(`\u001b]777;notify;Pi;${message}\u0007`);
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode === "tui" && process.env.TERM_PROGRAM === "ghostty") {
      notify("Pi is ready for your input");
    }
  });
}
