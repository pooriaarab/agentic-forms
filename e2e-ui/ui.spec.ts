import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { TOKEN } from "../playwright.config.js";

const SHOTS = "docs/screenshots";
const SCHEMES = ["light", "dark"] as const;
const FORM = `team-${Date.now().toString(36)}`;

// Every view is checked in both color schemes: an axe WCAG 2.2 AA scan, then a screenshot for review.
async function audit(page: Page, view: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `${view} (${scheme})`).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/${view}-${scheme}.png` });
  }
}

const addQuestion = async (page: Page, label: string, type: string, extra?: (dialog: ReturnType<Page["getByRole"]>) => Promise<void>) => {
  await page.getByRole("button", { name: /^Add question/ }).click();
  const dialog = page.getByRole("dialog", { name: "Add question" });
  await dialog.getByLabel("Question", { exact: true }).fill(label);
  await dialog.getByLabel("Type").selectOption(type);
  await extra?.(dialog);
  await dialog.getByRole("button", { name: "Add question" }).click();
  await expect(dialog).toBeHidden();
};
const questionNames = (page: Page) => page.getByRole("list", { name: /^Questions in/ }).locator(".af-item__label").allTextContents();

test("sign in, build a form, publish, fill it by link, read the response, reload", async ({ page, browser }) => {
  // Sign in: a wrong token is refused with a clear message.
  await page.goto("/ui/");
  await expect(page.getByRole("heading", { name: "Forms" })).toBeVisible();
  await audit(page, "01-sign-in");
  await page.getByLabel("API token").fill("not-the-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("The token was not accepted");
  await page.getByLabel("API token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The list starts empty.
  await expect(page.getByRole("heading", { name: "Your forms" })).toBeVisible();
  await expect(page.getByText("No forms yet")).toBeVisible();
  await audit(page, "02-forms-empty");

  // A new form, by keyboard: focus the button, press Enter, fill, submit.
  await page.getByRole("button", { name: "New form" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New form" });
  await dialog.getByLabel("Title").fill("Team survey");
  await dialog.getByLabel("Form id").fill(FORM);
  await audit(page, "03-new-form");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Team survey", level: 1 })).toBeVisible();
  await expect(page.getByText("No questions in this section")).toBeVisible();

  // Two questions, one of them conditional on the other.
  await addQuestion(page, "Your name", "short_text", async (d) => {
    await d.getByLabel("Required").check();
  });
  await page.getByRole("button", { name: /^Add question/ }).click();
  await audit(page, "04-question-dialog");
  await page.keyboard.press("Escape");
  await addQuestion(page, "Favorite color", "single_choice", async (d) => {
    await d.getByLabel("Choices").fill("red\nblue");
  });
  await addQuestion(page, "Throwaway", "number");
  expect(await questionNames(page)).toEqual(["Your name", "Favorite color", "Throwaway"]);

  // Edit, reorder, and remove.
  await page.getByRole("button", { name: "Edit: Throwaway" }).click();
  await page.getByRole("dialog", { name: "Edit question" }).getByLabel("Question", { exact: true }).fill("Team size");
  await page.getByRole("button", { name: "Save question" }).click();
  await page.getByRole("button", { name: "Move up: Team size" }).click();
  expect(await questionNames(page)).toEqual(["Your name", "Team size", "Favorite color"]);
  await page.getByRole("button", { name: "Remove: Team size" }).click();
  expect(await questionNames(page)).toEqual(["Your name", "Favorite color"]);
  await expect(page.getByText("You have unsaved changes.")).toBeVisible();

  // Save. The server marks the questions the caller made. This token is a deployment agent.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("All changes saved.")).toBeVisible();
  await expect(page.getByText("Agent changed this")).toHaveCount(2);
  await audit(page, "05-builder");

  // Preview.
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByRole("group", { name: "Favorite color" })).toBeVisible();
  await page.getByLabel("Your name (required)").fill("Ada");
  await audit(page, "06-preview");

  // Publish, then fill by the share link.
  await page.getByRole("tab", { name: "Questions" }).click();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
  const link = await page.getByRole("link", { name: new RegExp(`/f/${FORM}$`) }).getAttribute("href");
  expect(link).toBe(`http://127.0.0.1:8890/f/${FORM}`);
  await audit(page, "07-published");

  const respondent = await (await browser.newContext({ colorScheme: "light" })).newPage();
  await respondent.goto(link!);
  await expect(respondent.getByRole("heading", { name: "Team survey" })).toBeVisible();
  await respondent.getByLabel("Your name").fill("Grace");
  await respondent.getByLabel("blue").check();
  await audit(respondent, "08-fill");
  await respondent.getByRole("button", { name: "Send" }).click();
  await expect(respondent.getByRole("status")).toContainText("We received your answers");
  await respondent.close();

  // The response shows in the table.
  await page.getByRole("tab", { name: "Responses" }).click();
  const table = page.getByRole("table");
  await expect(table.getByRole("cell", { name: "Grace" })).toBeVisible();
  await expect(table.getByRole("cell", { name: "blue" })).toBeVisible();
  await audit(page, "09-responses");

  // CSV export.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toBe(`${FORM}.csv`);
  const csv = readFileSync(await download.path(), "utf8");
  expect(csv.split("\n")[0]).toBe("response_id,submitted_at,form_version,your_name,favorite_color");
  expect(csv).toContain("Grace,blue");

  // A reload keeps the token, the form, the questions, and the response.
  await page.reload();
  await expect(page.getByRole("cell", { name: "Grace" })).toBeVisible();
  await page.getByRole("tab", { name: "Questions" }).click();
  expect(await questionNames(page)).toEqual(["Your name", "Favorite color"]);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "All forms" }).click();
  await expect(page.getByRole("link", { name: "Team survey" })).toBeVisible();
  await audit(page, "10-forms-list");
});

const signIn = async (page: Page) => {
  await page.goto("/ui/");
  await page.getByLabel("API token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Your forms" })).toBeVisible();
};

test("a missing form shows an error, not a blank page", async ({ page }) => {
  await signIn(page);
  await page.goto("/ui/#/forms/does-not-exist");
  await expect(page.getByRole("alert")).toContainText("not found");
  await audit(page, "11-error");
});

test("an edit made elsewhere is refused, and nothing is overwritten", async ({ page, request }) => {
  await signIn(page);
  const id = `race-${Date.now().toString(36)}`;
  const headers = { authorization: `Bearer ${TOKEN}` };
  const section = (labels: string[]) => [{ id: "main", title: "Questions", questions: labels.map((l) => ({ id: l, type: "short_text", label: l })) }];
  expect((await request.post("/api/v1/forms", { headers, data: { id, title: "Race", sections: section(["one"]) } })).status()).toBe(201);
  await page.goto(`/ui/#/forms/${id}`);
  await expect(page.getByRole("heading", { name: "Race", level: 1 })).toBeVisible();
  // Someone else (an agent over the API) changes the form after this page loaded it.
  expect((await request.put(`/api/v1/forms/${id}`, { headers, data: { title: "Race", sections: section(["one", "two"]) } })).status()).toBe(200);
  await page.getByLabel("Form title").fill("Race, renamed");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Someone changed this form");
  await page.getByRole("button", { name: "Reload the form" }).click();
  await expect(page.getByRole("heading", { name: "Race", level: 1 })).toBeVisible();
  expect(await questionNames(page)).toEqual(["one", "two"]);
});

test("focus is visible on each stop of the sign-in page", async ({ page }) => {
  await page.goto("/ui/");
  const visible = () =>
    page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as HTMLElement);
      return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
    });
  await page.keyboard.press("Tab"); // the skip link is not on this page, so the first stop is the field
  await expect(page.getByLabel("API token")).toBeFocused();
  expect(await visible()).toBe(true);
  await page.getByLabel("API token").fill("x");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeFocused();
  expect(await visible()).toBe(true);
});
