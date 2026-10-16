// Shared public interaction for the shape-style menus.
export async function chooseShapeStyle(page, kind, value) {
  await page.locator(kind === 'outline' ? '#outline' : '#shape-fill').click();
  await page.locator(`#menu [data-command="${kind}:${value}"]`).click();
}
