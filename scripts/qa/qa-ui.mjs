import { join } from "node:path";
import { chromium } from "playwright";
import { bootHarness, seedTab } from "./harness.mjs";
import { api, evidenceDir, Recorder } from "./lib.mjs";

/**
 * Criterion C4: drive the real mobile UI in Chromium at 390x844 - configure through
 * the app, open a tab, and read shell output out of the xterm pane.
 */
const dir = evidenceDir(process.argv);
const rec = new Recorder(dir, "C4 mobile UI in Chromium at 390x844");
const MARKER = "POCKET_SSH_UI_OK";
let harness;
let browser;
let receipts = [];

try {
  harness = await bootHarness({ webRoot: true });
  rec.log(`app served at ${harness.baseUrl}`);

  const seeded = await seedTab(api, harness, { title: "ui-tab" });
  rec.log(`seeded tab ${seeded.tabId}`);

  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(harness.baseUrl, { waitUntil: "domcontentloaded" });
  rec.check("app shell loaded", true, await page.title());

  await page.getByTestId("token-input").fill(harness.token);
  await page.getByTestId("token-submit").click();

  const tabList = page.getByTestId("tab-list");
  await tabList.waitFor({ state: "visible", timeout: 15_000 });
  rec.check("token login reached the terminals view", await tabList.isVisible());

  const rows = page.getByTestId("tab-row");
  await rows.first().waitFor({ state: "visible", timeout: 15_000 });
  const rowCount = await rows.count();
  rec.check("configured tab is listed", rowCount >= 1, `rows=${rowCount}`);

  const navSpaces = page.getByTestId("nav-spaces");
  await navSpaces.click();
  const spaceForm = page.getByTestId("space-form");
  await spaceForm.waitFor({ state: "visible", timeout: 15_000 });
  rec.check("spaces view exposes the space form", await spaceForm.isVisible());

  await page.getByTestId("nav-agents").click();
  const agentForm = page.getByTestId("agent-form");
  await agentForm.waitFor({ state: "visible", timeout: 15_000 });
  rec.check("agents view exposes the agent form", await agentForm.isVisible());

  const touchTargets = await page.evaluate(() => {
    const selectors = ["[data-testid^='nav-']", "button", "[role='button']"];
    const nodes = [...new Set(selectors.flatMap((s) => [...document.querySelectorAll(s)]))];
    return nodes
      .filter((el) => {
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          label: el.getAttribute("data-testid") ?? el.textContent?.trim()?.slice(0, 24) ?? "?",
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
      })
      .filter((entry) => entry.w > 0 && entry.h > 0);
  });
  const tooSmall = touchTargets.filter((t) => t.h < 44);
  rec.check(
    "every visible control is at least 44px tall",
    tooSmall.length === 0,
    tooSmall.length
      ? JSON.stringify(tooSmall.slice(0, 6))
      : `${touchTargets.length} controls checked`,
  );

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  rec.check(
    "no horizontal overflow at 390px",
    overflow.scrollWidth <= overflow.clientWidth + 1,
    JSON.stringify(overflow),
  );

  await page.getByTestId("nav-terminals").click();
  await rows.first().click();
  const pane = page.getByTestId("terminal-pane");
  await pane.waitFor({ state: "visible", timeout: 15_000 });
  rec.check("tapping a tab opens the terminal pane", await pane.isVisible());

  await page.waitForFunction(() => document.querySelector(".xterm-rows") !== null, null, {
    timeout: 15_000,
  });
  await page.keyboard.type(`echo ${MARKER}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (marker) =>
      (document.querySelector("[data-testid='terminal-pane']")?.textContent ?? "").includes(marker),
    MARKER,
    { timeout: 20_000 },
  );
  const paneText = await pane.innerText();
  rec.check(
    `terminal shows ${MARKER}`,
    paneText.includes(MARKER),
    paneText.replace(/\s+/g, " ").slice(0, 200),
  );

  const shotPath = join(dir, "mobile-390x844.png");
  await page.screenshot({ path: shotPath, fullPage: false });
  rec.log(`screenshot: ${shotPath}`);
  rec.check("screenshot captured", true, shotPath);
  rec.check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} catch (error) {
  rec.check(
    "driver ran without throwing",
    false,
    error instanceof Error ? error.message : String(error),
  );
} finally {
  if (browser) {
    await browser.close();
    receipts.push("chromium closed");
  }
  if (harness) receipts = receipts.concat(await harness.cleanup());
  rec.log(`cleanup: ${receipts.join("; ")}`);
}

process.exit(rec.finish() ? 0 : 1);
