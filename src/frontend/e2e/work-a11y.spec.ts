import { readFileSync } from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

const axeSource = readFileSync(
  path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'),
  'utf8'
)

type AxeResults = {
  violations: Array<{ id: string; impact: string | null; help: string }>
}

const scanMain = async (page: Page) =>
  page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (context: Element, options: object) => Promise<AxeResults>
        }
      }
    ).axe
    const main = document.querySelector('main')
    if (!main) {
      throw new Error('main landmark not found')
    }
    return axe.run(main, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    })
  })

test('work UI passes WCAG A/AA axe scan including color contrast', async ({
  page,
}) => {
  await page.goto('/work')
  await expect(
    page.getByRole('heading', { name: '工作', exact: true })
  ).toBeVisible()
  await page.evaluate(axeSource)
  for (const view of ['全部', '待处理', '进行中', '待验收', '已完成']) {
    await page.getByRole('button', { name: view, exact: true }).click()
    const results = await scanMain(page)
    expect(
      results.violations,
      `${view}: ${JSON.stringify(results.violations, null, 2)}`
    ).toEqual([])
  }
})
