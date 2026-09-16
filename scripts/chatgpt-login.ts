/**
 * Headed Brave/Chrome login for a ChatGPT account profile.
 *
 * Usage:
 *   npx tsx scripts/chatgpt-login.ts --account acct_main
 *
 * Opens headed browser with persistent profile under state/profiles/<account>/chromium.
 * Log in manually, wait until the ChatGPT composer is visible, then press Enter here.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { ChromiumBrowserBackend } from "../src/browser/chromium/backend.js";
import { newAgentId } from "../src/types/ids.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      account: { type: "string", default: "acct_default" },
      url: { type: "string", default: "https://chatgpt.com/" },
    },
  });
  const accountId = values.account ?? "acct_default";
  const stateDir = process.env.AIFROST_STATE_DIR ?? "./state";

  const backend = new ChromiumBrowserBackend({
    requireBinary: true,
    headless: false,
    stateDir,
  });
  await backend.start({ host: "127.0.0.1" });
  console.log("browser:", backend.getBinaryPath(), `(${backend.getBrand()})`);
  console.log("profile:", join(stateDir, "profiles", accountId, "chromium"));

  const session = await backend.createRuntime({
    agentId: newAgentId(),
    accountId,
    startUrl: values.url ?? "https://chatgpt.com/",
  });

  console.log(`
============================================================
  Log into ChatGPT in the opened browser window.
  Complete any Cloudflare / 2FA challenges.
  Wait until you see the normal chat composer.
  Then return here and press Enter.
============================================================
`);

  const rl = createInterface({ input, output });
  await rl.question("Press Enter when login is complete… ");
  rl.close();

  const title = await session.evaluate("document.title");
  const href = await session.evaluate("location.href");
  const hasComposer = await session.evaluate(`
    !!(document.querySelector('#prompt-textarea')
      || document.querySelector('[data-testid="composer"]')
      || document.querySelector('div[contenteditable="true"]')
      || document.querySelector('textarea'))
  `);

  console.log(
    JSON.stringify(
      {
        title: title.value,
        href: href.value,
        hasComposer: hasComposer.value,
        challenge: /just a moment/i.test(String(title.value ?? "")),
        accountId,
        profileDir: join(stateDir, "profiles", accountId, "chromium"),
      },
      null,
      2,
    ),
  );

  if (!hasComposer.value) {
    console.error("Composer not detected. Profile saved anyway — re-run login if needed.");
  } else {
    console.log("Login looks good. Profile persisted for headless reuse.");
  }

  await backend.shutdown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
