import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

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
