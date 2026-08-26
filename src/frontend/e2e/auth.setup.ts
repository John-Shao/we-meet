import path from 'node:path'
import { expect, test as setup } from '@playwright/test'

const authState = path.join(process.cwd(), 'playwright/.auth/user.json')
const username = process.env.E2E_USERNAME || 'user-e2e-chromium'
const password = process.env.E2E_PASSWORD || 'password-e2e-chromium'
const appOrigin = new URL(process.env.E2E_BASE_URL || 'http://localhost:3000')
  .origin

setup('authenticate with the development Keycloak realm', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('i18nextLng', 'zh')
  })

  await page.goto('/')
  await page.locator('[data-attr="login"]').first().click()

  await expect(page.locator('#username')).toBeVisible()
  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  await page.locator('#kc-login').click()

  await page.waitForURL((url) => url.origin === appOrigin)
  await page.goto('/tasks')
  await expect(
    page.getByRole('heading', { name: '任务', exact: true })
  ).toBeVisible()

  await page.context().storageState({ path: authState })
})
