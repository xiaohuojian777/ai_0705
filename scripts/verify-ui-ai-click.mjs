import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const APP_URL = "http://localhost:3500";
const DEMO_DIR = "D:/codex/AITest/demos";
const CHROME_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe";

function pickDemoFile() {
  const files = fs.readdirSync(DEMO_DIR);
  const target = files
    .filter((name) => /\.(xlsx|xls|docx|doc|pdf)$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "zh-CN"))[0];

  if (!target) {
    throw new Error("No demo file found");
  }

  return path.join(DEMO_DIR, target);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME_PATH,
  });
  const page = await browser.newPage();
  const demoFile = pickDemoFile();
  const result = {
    demoFile,
    title: "",
    loginOk: false,
    uploadOk: false,
    aiButtonEnabled: false,
    aiRequestStatus: null,
    aiSummaryText: "",
    providerText: "",
    modelText: "",
    pageTextSnippet: "",
  };

  try {
    await page.goto(`${APP_URL}/universal-import`, { waitUntil: "networkidle" });
    result.title = await page.title();

    const hasLoginForm = await page.getByPlaceholder("请输入账号").isVisible().catch(() => false);
    if (hasLoginForm) {
      await page.getByPlaceholder("请输入账号").fill("admin");
      await page.getByPlaceholder("请输入数字密码").fill("1234");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL("**/universal-import", { timeout: 20000 });
    }

    result.loginOk = true;

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(demoFile);

    await page.waitForTimeout(1500);
    result.uploadOk = await page.getByText("已上传").first().isVisible().catch(() => false);

    const aiButton = page.getByRole("button", { name: "AI 生成规则建议" });
    result.aiButtonEnabled = await aiButton.isEnabled();

    const aiResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/universal-import/templates/ai-suggest") &&
        response.request().method() === "POST",
      { timeout: 120000 },
    );

    await aiButton.click();
    const aiResponse = await aiResponsePromise;
    result.aiRequestStatus = aiResponse.status();

    await page.waitForTimeout(3000);

    const bodyText = await page.locator("body").innerText();
    result.pageTextSnippet = bodyText.slice(0, 2000);

    const statusPanel = page.locator(".status-panel");
    result.aiSummaryText = (await statusPanel.innerText()).slice(0, 800);

    const overviewCards = page.locator(".overview-card");
    const cardTexts = await overviewCards.allInnerTexts();
    result.providerText = cardTexts.find((text) => text.includes("AI 建议来源")) || "";
    result.modelText = cardTexts.find((text) => text.includes("当前模型")) || "";

    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (!result.uploadOk && !result.aiButtonEnabled) {
      try {
        result.pageTextSnippet = (await page.locator("body").innerText()).slice(0, 2000);
        console.log(JSON.stringify(result, null, 2));
      } catch {}
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
