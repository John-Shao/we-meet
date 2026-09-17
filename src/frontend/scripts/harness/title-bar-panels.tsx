// 走查夹具:把通讯录「外部联系人」面板挂起来,量它内容标题栏的几何(不参与构建)。
// 只有 scripts/check-title-bar.mjs 会通过 Vite dev server 动态 import 它。
//
// 注意两点:
//   ① 用**相对路径** —— 走查文件在 scripts/ 下,Vite 的 `@/` 别名只覆盖 src/;
//   ② 这里只挂「外部联系人」:它的备注是**一句长说明**,是最该在真实浏览器里量的那一个
//      (标题 + 长备注 + 右侧按钮三者抢宽度)。「我的群组」依赖 IM SDK(dev 下没有
//      VITE_JUSI_IM_BASE_URL 会直接抛错),由 jsdom 那条 ContactsRoute 用例覆盖。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { Router } from 'wouter'

import { ConfirmProvider } from '../../src/components/ConfirmProvider'
import { ExternalContactsPanel } from '../../src/features/contacts/components/ExternalContactsPanel'

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

export const mountExternalPanel = (host: HTMLElement) => {
  createRoot(host).render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Router>
          {/* 宽度按真实布局里的中间列量级(几百到一千多像素)。 */}
          <div
            data-testid="host-external"
            style={{ width: '700px', height: '160px', backgroundColor: '#fff' }}
          >
            <ExternalContactsPanel onMessage={async () => undefined} />
          </div>
        </Router>
      </ConfirmProvider>
    </QueryClientProvider>
  )
}
