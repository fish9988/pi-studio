// Pi models.json 的思考档位从界面保存到文件，再重新打开回显。只使用临时配置，不连接上游。
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { expectNoOverflow, launchSettings, setLocaleTheme } from "./launch.ts";

test("自定义模型思考档位：保存、重开回显并可清除，不改其它能力", async () => {
  const { launched, agentDir } = await launchSettings(
    { STUDIO_MODELS_DEV_URL: "http://127.0.0.1:9/api.json" },
    {
      section: "providers",
      height: 900,
      prepare: async (dir) => {
        await writeFile(
          path.join(dir, "models.json"),
          JSON.stringify({
            providers: {
              "test-sol": {
                baseUrl: "http://127.0.0.1:9/v1",
                api: "openai-responses",
                apiKey: "test-only-key",
                models: [{ id: "sol", reasoning: true, contextWindow: 128000, maxTokens: 8192 }],
              },
            },
          }),
        );
      },
    },
  );
  try {
    const { page } = launched;
    await setLocaleTheme(page, "zh-CN", "light");
    const edit = page.getByTestId("custom-edit-test-sol");
    await edit.click();
    await page.getByTestId("custom-model-levels-sol").click();
    await page.getByTestId("custom-model-level-sol-xhigh").fill("xhigh");
    await page.getByTestId("custom-model-level-sol-max").fill("max");
    await page.getByTestId("custom-model-hide-sol-minimal").check();
    await expectNoOverflow(page.getByTestId("custom-provider-form"));
    await page.getByTestId("custom-save").click();
    await expect(page.getByTestId("custom-provider-form")).toHaveCount(0);
    const savedModel = async () => {
      const raw = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as {
        providers: Record<string, { models: Record<string, unknown>[] }>;
      };
      return raw.providers["test-sol"]!.models[0]!;
    };
    expect(await savedModel()).toMatchObject({
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 8192,
      thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: null },
    });
    await edit.click();
    await page.getByTestId("custom-model-levels-sol").click();
    await expect(page.getByTestId("custom-model-level-sol-xhigh")).toHaveValue("xhigh");
    await expect(page.getByTestId("custom-model-level-sol-max")).toHaveValue("max");
    await expect(page.getByTestId("custom-model-hide-sol-minimal")).toBeChecked();
    await page.setViewportSize({ width: 900, height: 900 });
    await expectNoOverflow(page.getByTestId("custom-provider-form"));
    await page.getByTestId("custom-model-level-sol-xhigh").fill("");
    await page.getByTestId("custom-model-level-sol-max").fill("");
    await page.getByTestId("custom-model-hide-sol-minimal").uncheck();
    await page.getByTestId("custom-save").click();
    await expect(page.getByTestId("custom-provider-form")).toHaveCount(0);
    expect(await savedModel()).not.toHaveProperty("thinkingLevelMap");
  } finally {
    try {
      await launched.close();
    } finally {
      await rm(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});
