import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// 版本号只有一个真值：package.json。构建期读出来注入，渲染层直接用，
// 不会漂移成「package.json 是 0.2.0、界面显示 2.0.0」这种硬编码。
// JSON.stringify 把值包成合法 JS 字符串字面量，define 做纯文本替换。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/**
 * 三方构建配置。electron-vite 把主进程 / preload / 渲染进程分开编译：
 *   src/main     -> out/main/index.js      (Node 环境)
 *   src/preload  -> out/preload/index.js   (沙箱环境)
 *   src/renderer -> out/renderer/          (浏览器环境)
 *
 * 共享代码放 src/shared/，主进程和渲染进程都能 import，electron-vite 自己处理
 * 路径解析，不要额外配 alias 指 src/。
 */
export default defineConfig({
  main: {},
  preload: {
    // 必须输出 CJS。渲染进程开了 sandbox，沙箱化的 preload 根本不支持 ESM
    // import（见 Electron ESM 文档），一旦打出 .mjs 就是启动即崩。项目里没有任何
    // import.meta，所以 ESM 语法在 preload 里本来就用不上。
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    // base 不要自己设：electron-vite 在 production 下强制 './'，写了会告警。
    // 渲染入口是 src/renderer/index.html，vite 会自己发现，无需显式 input。
    define: {
      // 声明在 src/renderer/version.d.ts；只给渲染层，主进程用不到版本号。
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [vue()],
    resolve: {
      alias: {
        // 与 tsconfig.app.json 的 "@/*": ["src/*"] 保持一致，写成 ./src/renderer 会让
        // "@/renderer/store" 解析成 src/renderer/renderer/store。
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  },
})
